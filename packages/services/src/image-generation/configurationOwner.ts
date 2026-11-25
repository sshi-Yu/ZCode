import { randomUUID } from "node:crypto";
import { withFileLock } from "@zcode/shared/node";
import type {
  ImageGenerationStartReceipt,
  ImageGenerationPublicConnection,
  ImageGenerationTestResult,
} from "./contract.js";
import type { GenerationSnapshot, ImageGenerationStore, StoredConnection } from "./storage.js";
import {
  defaultInputSchema,
  deleteConnectionSchema,
  destinationFingerprint,
  generationSchema,
  historySchema,
  normalizeConnection,
  probeSchema,
  requestSchema,
  stableParameters,
  testSample,
  validateProtocolParameters,
} from "./configuration.js";
import {
  ImageGenerationError,
  parseInput,
  readResponseJson,
  validateCredential,
  withinDeadline,
} from "./validation.js";

export interface ImageGenerationCredentialPort {
  get(ref?: string): Promise<string | null>;
  set(value: string, ref?: string): Promise<void>;
  delete(ref?: string): Promise<void>;
}
export type PrepareImageGeneration = (
  endpoint: string,
  policy: { officialPreset: boolean; fixtureOrigin?: string; signal: AbortSignal },
) => Promise<{ fetch(init: RequestInit): Promise<Response>; dispose(): void }>;
export function imageNetworkCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "proxy_unsupported" || code === "destination_blocked" ? code : "network_error";
}
export function publicConnection(c: StoredConnection): ImageGenerationPublicConnection {
  const { credentialRef, ...projection } = c;
  return { ...projection, configured: Boolean(credentialRef) };
}
export async function providerError(response: Response, signal: AbortSignal) {
  const { status } = response;
  if (status === 400 || status === 403 || status === 422 || status === 429) {
    // 仅对协议允许列表做定长代码归类，不记录/返回上游正文、自由文案或异常。
    const body = (await readResponseJson(response, signal, 32 * 1024).catch(() => null)) as {
      error?: { code?: unknown; type?: unknown };
    } | null;
    const codes = [body?.error?.code, body?.error?.type];
    if (codes.includes("insufficient_quota") || codes.includes("billing_hard_limit_reached"))
      return "quota_exceeded" as const;
    if (codes.includes("content_policy_violation") || codes.includes("moderation_blocked"))
      return "content_rejected" as const;
  } else void response.body?.cancel().catch(() => undefined);
  return status === 401 || status === 403
    ? ("authentication_failed" as const)
    : status === 404 || status === 405
      ? ("endpoint_unsupported" as const)
      : status === 429
        ? ("rate_limited" as const)
        : status === 402
          ? ("quota_exceeded" as const)
          : ("provider_rejected" as const);
}

/** One cross-process lock owns configuration, credential publication, admission snapshots and GC. */
export function createConfigurationOwner(options: {
  store: ImageGenerationStore;
  lockPath: string;
  credential: ImageGenerationCredentialPort;
  prepare: PrepareImageGeneration;
  fixtureEndpoint?: string;
  dispatch(snapshot: GenerationSnapshot, apiKey: string): Promise<ImageGenerationStartReceipt>;
}) {
  const { store, credential } = options;
  const locked = <T>(run: () => Promise<T>) => withFileLock(options.lockPath, run);
  async function collect() {
    const referenced = new Set(store.connections().map((c) => c.credentialRef));
    for (const ref of store.candidates())
      if (!referenced.has(ref)) {
        await credential.delete(ref);
        store.removeCandidate(ref);
      }
  }
  async function immutableKey(value: string) {
    const ref = `image-generation.credential.${randomUUID()}`;
    const validated = validateCredential(value);
    // 候选先持久化再写私钥，崩溃后仍能回收未发布引用；新引用从不覆盖旧版本。
    store.candidate(ref);
    await credential.set(validated, ref);
    return ref;
  }
  async function initializeLocked() {
    if (!store.migrated()) {
      const legacy = await credential.get();
      const staged = store.migrationCandidate(
        legacy ? `image-generation.credential.${randomUUID()}` : null,
      );
      if (staged && !(await credential.get(staged))) {
        if (!legacy)
          throw new ImageGenerationError(
            "Legacy image credential is unavailable.",
            "credential_required",
          );
        // 中断后复用已记录的迁移引用；先查看密钥是否已写，避免再次导入同一旧槽。
        await credential.set(validateCredential(legacy), staged);
      }
      store.migrateCredential(staged);
    }
    // 一次性标记与发布同事务；清理失败仅在下次启动续做，不从旧槽恢复已清空的配置。
    await credential.delete().catch(() => undefined);
    await collect().catch(() => undefined);
  }
  function current(id: string, revision: number) {
    const c = store.connections().find((entry) => entry.connectionId === id);
    if (!c || c.revision !== revision)
      throw new ImageGenerationError(
        "Image configuration changed. Refresh and confirm again.",
        "revision_conflict",
      );
    return c;
  }
  const probes = new Map<string, Promise<ImageGenerationTestResult>>();
  const api = {
    initialize: () => locked(initializeLocked),
    getConfiguration: async () => {
      const { connections, defaultSelection } = store.configuration();
      return {
        connections: connections.map(publicConnection),
        defaultSelection,
        testSample: { ...testSample, parameters: {} },
      };
    },
    saveConnection: async (raw: unknown) =>
      locked(async () => {
        const input = normalizeConnection(raw, options.fixtureEndpoint);
        // 已删除连接的稳定 ID 不可复用，否则旧确认可能命中新建连接的同一修订。
        if ((input.connectionId === undefined) !== (input.expectedRevision === null)) {
          throw new ImageGenerationError("Invalid image generation input.");
        }
        const id = input.connectionId ?? randomUUID();
        const previous = store.connections().find((c) => c.connectionId === id);
        if ((previous?.revision ?? null) !== input.expectedRevision)
          throw new ImageGenerationError(
            "Image configuration changed. Refresh and confirm again.",
            "revision_conflict",
          );
        const changed =
          previous && destinationFingerprint(previous) !== destinationFingerprint(input);
        if (changed && input.credential.action !== "replace")
          throw new ImageGenerationError(
            "Confirm the changed destination and provide a new API key.",
            "credential_required",
          );
        const ref =
          input.credential.action === "replace"
            ? await immutableKey(input.credential.apiKey)
            : input.credential.action === "remove"
              ? null
              : (previous?.credentialRef ?? null);
        const connection: StoredConnection = {
          connectionId: id,
          revision: (previous?.revision ?? 0) + 1,
          name: input.name,
          enabled: input.enabled,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          generationPath: input.generationPath,
          probePath: input.probePath,
          auth: input.auth,
          generationUrl: input.generationUrl,
          probeUrl: input.probeUrl,
          officialPreset: Boolean(previous?.officialPreset && !changed),
          credentialRef: ref,
          models: input.models,
        };
        const published = store.publish(connection, input.expectedRevision, input.defaultSelection);
        await collect().catch(() => undefined);
        return publicConnection(published);
      }),
    deleteConnection: async (raw: unknown) =>
      locked(async () => {
        const input = parseInput(deleteConnectionSchema, raw);
        store.deleteConnection(input.connectionId, input.expectedRevision, input.defaultSelection);
        await collect().catch(() => undefined);
      }),
    setDefaultSelection: async (raw: unknown) =>
      locked(async () => store.setDefault(parseInput(defaultInputSchema, raw))),
    startGeneration: async (raw: unknown): Promise<ImageGenerationStartReceipt> => {
      const input = parseInput(generationSchema, raw);
      return locked(async () => {
        // 先按原冻结输入回放，不依赖当前配置或当前凭据；删除连接后仍可安全读回执。
        const saved = store.snapshot(input.requestId);
        if (store.getRequest(input.requestId)) {
          // 旧版 v1 回执没有新字段快照，只能只读查询；任何新版请求复用已登记 ID 都不触发生成。
          if (!saved || (input.purpose === "test" && input.prompt !== undefined))
            throw new ImageGenerationError(
              "Request ID was already used with different input.",
              "request_conflict",
            );
          // 回放逐项比较调用方提交的全部字段；试生成的提示词由 Host 生成，但参数必须取自输入，
          // 否则冲突参数会在比较前被丢弃，错误地返回原回执而不是 request_conflict。
          const candidate: GenerationSnapshot = {
            ...saved,
            prompt: input.purpose === "test" ? testSample.prompt : (input.prompt ?? ""),
            connectionId: input.connectionId,
            modelKey: input.modelKey,
            revision: input.revision,
            purpose: input.purpose,
            sampleVersion: input.sampleVersion,
            callerParameters: input.parameters ?? {},
          };
          return { kind: "replayed", job: store.replay(candidate)! };
        }
        const c = current(input.connectionId, input.revision);
        const m = c.models.find((entry) => entry.modelKey === input.modelKey);
        if (!c.enabled || !m?.enabled)
          throw new ImageGenerationError("Select an available image model.", "model_unavailable");
        let prompt = input.prompt;
        if (input.purpose === "test") {
          if (
            input.prompt !== undefined ||
            input.sampleVersion !== testSample.version ||
            stableParameters(input.parameters ?? {}) !== stableParameters(m.parameters)
          )
            throw new ImageGenerationError(
              "Image configuration changed. Refresh and confirm again.",
              "revision_conflict",
            );
          prompt = testSample.prompt;
        } else if (!prompt || input.sampleVersion !== undefined)
          throw new ImageGenerationError("Invalid image generation input.");
        const snapshot: GenerationSnapshot = {
          requestId: input.requestId,
          prompt: prompt!,
          modelId: m.modelId,
          connectionId: c.connectionId,
          modelKey: m.modelKey,
          revision: c.revision,
          purpose: input.purpose,
          callerParameters: input.parameters ?? {},
          parameters:
            input.purpose === "test"
              ? { ...m.parameters }
              : { ...m.parameters, ...input.parameters },
          ...(input.sampleVersion ? { sampleVersion: input.sampleVersion } : {}),
          destinationFingerprint: destinationFingerprint(c),
          endpoint:
            options.fixtureEndpoint && c.officialPreset ? options.fixtureEndpoint : c.generationUrl,
          protocol: c.protocol,
          auth: c.auth,
          officialPreset: c.officialPreset,
        };
        validateProtocolParameters(snapshot.protocol, snapshot.parameters);
        if (!c.credentialRef)
          throw new ImageGenerationError(
            "Configure an image API key before generating.",
            "credential_required",
          );
        const key = await credential.get(c.credentialRef);
        if (!key)
          throw new ImageGenerationError(
            "Configure an image API key before generating.",
            "credential_required",
          );
        // 配置锁保护短暂的旧引用读取；受理再次 CAS 后网络仅使用内存快照，不持锁等待网络。
        return options.dispatch(snapshot, validateCredential(key));
      });
    },
    probeConnection: (raw: unknown) => {
      const input = parseInput(probeSchema, raw);
      const key = JSON.stringify(input);
      const active = probes.get(key);
      if (active) return active;
      const task = (async () => {
        const frozen = await locked(async () => {
          const c = current(input.connectionId, input.revision);
          if (
            !c.enabled ||
            (input.modelKey && !c.models.some((m) => m.modelKey === input.modelKey && m.enabled))
          )
            throw new ImageGenerationError("Select an available image model.", "model_unavailable");
          if (!c.credentialRef)
            throw new ImageGenerationError(
              "Configure an image API key before probing.",
              "credential_required",
            );
          const key = await credential.get(c.credentialRef);
          if (!key)
            throw new ImageGenerationError(
              "Configure an image API key before probing.",
              "credential_required",
            );
          return {
            c,
            key: validateCredential(key),
            sequence: store.beginProbe(c.connectionId, c.revision),
          };
        });
        const ranAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        timer.unref();
        let status: ImageGenerationTestResult["status"] = "unverified";
        let code: ImageGenerationTestResult["code"];
        try {
          const probeUrl = frozen.c.probeUrl;
          if (!probeUrl) code = "probe_unavailable";
          else {
            await withinDeadline(controller.signal, async () => {
              const endpoint =
                options.fixtureEndpoint && frozen.c.officialPreset
                  ? new URL("/v1/models", options.fixtureEndpoint).href
                  : probeUrl;
              const prepared = await options.prepare(endpoint, {
                officialPreset: frozen.c.officialPreset,
                fixtureOrigin: options.fixtureEndpoint
                  ? new URL(options.fixtureEndpoint).origin
                  : undefined,
                signal: controller.signal,
              });
              try {
                controller.signal.throwIfAborted();
                const response = await prepared.fetch({
                  method: "GET",
                  headers: { Authorization: `Bearer ${frozen.key}` },
                });
                if (!response.ok) {
                  if (
                    response.status === 404 ||
                    response.status === 405 ||
                    response.status === 501
                  ) {
                    void response.body?.cancel().catch(() => undefined);
                    code = "probe_unavailable";
                  } else {
                    code = await providerError(response, controller.signal);
                    status = "failed";
                  }
                } else {
                  const body = (await readResponseJson(
                    response,
                    controller.signal,
                    256 * 1024,
                  )) as {
                    data?: unknown;
                  };
                  if (!Array.isArray(body?.data)) code = "probe_unavailable";
                  else if (
                    input.modelKey &&
                    !body.data.some(
                      (entry) =>
                        entry &&
                        typeof entry === "object" &&
                        entry.id ===
                          frozen.c.models.find((m) => m.modelKey === input.modelKey)?.modelId,
                    )
                  )
                    code = "model_unverified";
                  else if (
                    body.data.every(
                      (entry) => entry && typeof entry === "object" && typeof entry.id === "string",
                    )
                  )
                    status = "succeeded";
                  else code = "probe_unavailable";
                }
              } finally {
                prepared.dispose();
              }
            });
          }
        } catch (error) {
          status = "failed";
          code = error instanceof ImageGenerationError ? error.code : imageNetworkCode(error);
        } finally {
          clearTimeout(timer);
        }
        const result: ImageGenerationTestResult = {
          operation: "probe",
          revision: input.revision,
          ...(input.modelKey ? { modelKey: input.modelKey } : {}),
          status,
          durationMs: Date.now() - ranAt,
          ranAt,
          ...(code ? { code } : {}),
        };
        store.finishProbe(input.connectionId, input.revision, frozen.sequence, result);
        return result;
      })();
      probes.set(key, task);
      void task
        .finally(() => {
          if (probes.get(key) === task) probes.delete(key);
        })
        .catch(() => undefined);
      return task;
    },
    readHistory: async (raw: unknown) => store.history(parseInput(historySchema, raw)),
    getRequest: async (raw: unknown) => ({
      job: store.getRequest(parseInput(requestSchema, raw).requestId),
    }),
  };
  return api;
}
