import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { IImageGenerationService, ImageGenerationJob } from "./contract.js";
import {
  createImageGenerationStore,
  prepareImageGenerationDatabase,
  type ImageGenerationStore,
  type GenerationSnapshot,
} from "./storage.js";
import { withFileLock } from "@zcode/shared/node";
import {
  createConfigurationOwner,
  providerError,
  imageNetworkCode,
  type ImageGenerationCredentialPort,
  type PrepareImageGeneration,
} from "./configurationOwner.js";
import {
  assetSchema,
  decodeImageResponse,
  GENERATION_TIMEOUT_MS,
  ImageGenerationError,
  invalidInput,
  MAX_IMAGE_BYTES,
  parseInput,
  readResponseJson,
  resolveEndpoint,
  validatePng,
} from "./validation.js";

export interface CreateImageGenerationServiceOptions {
  appConfigDir: string;
  /** One main-process-generated identity shared by every Window Host in this app run. */
  appRunId: string;
  credential: ImageGenerationCredentialPort;
  prepareImageGeneration: PrepareImageGeneration;
  /** Fully decode PNG and return a <=384px, <=128KiB PNG preview using the host codec. */
  createPngPreview(png: Uint8Array): Promise<Uint8Array>;
  fixture?: { endpoint: string; mode: "development" | "test" };
}

interface Ready {
  store: ImageGenerationStore;
  assetDir: string;
  configuration: ReturnType<typeof createConfigurationOwner>;
}

const logger = createServiceLogger("image-generation");

/** 只保留形如 EIO/SQLITE_BUSY 的错误码；原始 message 可能含本机路径、上游正文或凭据。 */
function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : undefined;
}

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // 第三方网络、凭据和文件异常可能包含密钥/正文/本机路径，跨 RPC 只能返回固定安全错误。
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationError(
      "Image generation service is unavailable.",
      "service_unavailable",
    );
  }
}

async function writeOriginal(
  assetDir: string,
  id: string,
  png: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const temporary = join(assetDir, `.${id}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal.throwIfAborted();
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(png, { signal });
    await file.sync();
    await file.close();
    file = undefined;
    signal.throwIfAborted();
    await rename(temporary, join(assetDir, `${id}.png`));
    // POSIX directory fsync persists the rename before publishing success; Windows does not allow it.
    if (process.platform !== "win32") {
      const directory = await open(assetDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    signal.throwIfAborted();
  } finally {
    if (file) await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function readOriginal(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.size < 57) invalidInput();
    // Read through a bounded buffer even if another local writer grows the file after stat.
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used !== stat.size) invalidInput();
    const original = bytes.subarray(0, used);
    validatePng(original);
    return original;
  } finally {
    await file.close();
  }
}

export function createImageGenerationService(
  options: CreateImageGenerationServiceOptions,
): IImageGenerationService {
  if (
    !options ||
    !isAbsolute(options.appConfigDir) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.appRunId) ||
    typeof options.prepareImageGeneration !== "function" ||
    typeof options.createPngPreview !== "function" ||
    typeof options.credential?.get !== "function" ||
    typeof options.credential?.set !== "function" ||
    typeof options.credential?.delete !== "function"
  )
    invalidInput();
  const endpoint = resolveEndpoint(options.fixture);
  let ready: Promise<Ready> | undefined;
  async function initialize(): Promise<Ready> {
    const root = join(options.appConfigDir, "image-generation");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonical = await realpath(root);
    const assetDir = join(canonical, "assets");
    await mkdir(assetDir, { recursive: true, mode: 0o700 });
    const dbPath = join(canonical, "jobs.sqlite");
    const lockPath = join(canonical, "configuration");
    await withFileLock(lockPath, () => prepareImageGenerationDatabase(dbPath));
    // realpath + normalized Windows case make in-process ownership independent of path aliases.
    const store = createImageGenerationStore(
      process.platform === "win32" ? dbPath.toLowerCase() : dbPath,
      options.appRunId,
      {
        onStaleRecovered: (info) =>
          logger.warn(undefined, "stale running job reconciled", {
            status: info.status,
            dispatched: info.dispatched,
          }),
      },
    );
    const state = { store, assetDir } as Ready;
    state.configuration = createConfigurationOwner({
      store,
      lockPath,
      credential: options.credential,
      prepare: options.prepareImageGeneration,
      ...(options.fixture ? { fixtureEndpoint: endpoint } : {}),
      dispatch: async (snapshot, apiKey) => {
        const admitted = store.admit(snapshot);
        if (admitted.accepted) {
          store.track(admitted.job.id);
          void dispatch(state, admitted.job, apiKey, snapshot).catch((error: unknown) => {
            logger.error(undefined, "terminal job state could not be persisted", {
              jobId: admitted.job.id,
              code: safeErrorCode(error),
            });
            store.untrack(admitted.job.id);
          });
        }
        return { kind: admitted.accepted ? "accepted" : "replayed", job: admitted.job };
      },
    });
    await state.configuration.initialize();
    store.readActive();
    return state;
  }
  function ensureReady(): Promise<Ready> {
    if (!ready) {
      let attempt: Promise<Ready> | undefined;
      attempt = initialize().catch((error: unknown) => {
        // 根因：初始化的 rejected promise 被永久缓存，目录/数据库的瞬时故障解除后服务仍永远不可用。
        // 这里只丢弃本次失败的初始化；受理、发送与结果写入不经此路径重试，恢复写入在事务内失败即回滚。
        if (ready === attempt) ready = undefined;
        logger.warn(undefined, "initialization failed", { code: safeErrorCode(error) });
        throw error;
      });
      ready = attempt;
    }
    return ready;
  }

  async function dispatch(
    readyState: Ready,
    job: ImageGenerationJob,
    apiKey: string,
    snapshot: GenerationSnapshot,
  ): Promise<void> {
    const { store, assetDir } = readyState;
    let dispatched = false;
    const progress: { stage: "network" | "output" | "storage" } = { stage: "network" };
    let disposeRoute: (() => void) | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    timer.unref();
    let abortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abortListener = () =>
        reject(new ImageGenerationError("Generation deadline exceeded.", "network_error"));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      await Promise.race([
        deadline,
        (async () => {
          controller.signal.throwIfAborted();
          const prepared = await options.prepareImageGeneration(snapshot.endpoint, {
            officialPreset: snapshot.officialPreset,
            fixtureOrigin: options.fixture ? new URL(endpoint).origin : undefined,
            signal: controller.signal,
          });
          disposeRoute = prepared.dispose;
          if (controller.signal.aborted) {
            prepared.dispose();
            controller.signal.throwIfAborted();
          }
          // 先持久提交不可逆发送屏障，再调用网络；崩溃/重放只读此屏障，绝不自动补发。
          if (!store.fence(job.id)) return;
          dispatched = true;
          const response = await prepared.fetch({
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              ...(snapshot.protocol === "openai-images-b64"
                ? { "Idempotency-Key": snapshot.requestId }
                : {}),
            },
            body: JSON.stringify({
              model: job.modelId,
              prompt: job.prompt,
              n: 1,
              ...snapshot.parameters,
              // 严格兼容接口拒绝 output_format；根据已冻结协议选择格式，不能发送后再回退重试。
              ...(snapshot.protocol === "openai-images-b64"
                ? { response_format: "b64_json" }
                : { output_format: "png" }),
            }),
            redirect: "error",
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (!response.ok) {
            // 明确的客户端拒绝可证明未成功；5xx/重定向等结果保持未知，不推断无计费。
            // HTTP 408/499 仍表示超时或连接中断，不能据此证明上游未产生结果。
            const rejected =
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 408 &&
              response.status !== 499;
            const code = rejected
              ? await providerError(response, controller.signal)
              : "outcome_unknown";
            if (!rejected) void response.body?.cancel().catch(() => undefined);
            controller.signal.throwIfAborted();
            store.finish(
              job.id,
              rejected ? "failed" : "outcome_unknown",
              rejected
                ? "Image provider rejected the request. Check the image settings."
                : "Generation outcome is unknown. Create a new request to generate again.",
              undefined,
              code,
            );
            (rejected ? logger.info : logger.warn)(undefined, "provider response settled job", {
              jobId: job.id,
              status: rejected ? "failed" : "outcome_unknown",
            });
            return;
          }
          progress.stage = "output";
          const png = decodeImageResponse(await readResponseJson(response, controller.signal));
          controller.signal.throwIfAborted();
          // 解码器只接收副本，预览缩放不能改写随后持久化与导出的原始字节。
          const preview = await options.createPngPreview(Uint8Array.from(png));
          controller.signal.throwIfAborted();
          validatePng(preview, true);
          const assetId = randomUUID();
          progress.stage = "storage";
          await writeOriginal(assetDir, assetId, png, controller.signal);
          controller.signal.throwIfAborted();
          store.finish(job.id, "succeeded", undefined, {
            id: assetId,
            preview: `data:image/png;base64,${Buffer.from(preview).toString("base64")}`,
          });
          logger.info(undefined, "job succeeded", { jobId: job.id, status: "succeeded" });
        })(),
      ]);
    } catch (error) {
      const status = dispatched ? "outcome_unknown" : "failed";
      logger.warn(undefined, "dispatch ended without a confirmed result", {
        jobId: job.id,
        status,
        code: safeErrorCode(error),
      });
      store.finish(
        job.id,
        status,
        dispatched
          ? "Generation outcome is unknown. Create a new request to generate again."
          : "Generation stopped before dispatch.",
        undefined,
        progress.stage === "output"
          ? "invalid_output"
          : progress.stage === "storage"
            ? "storage_error"
            : imageNetworkCode(error),
      );
    } finally {
      clearTimeout(timer);
      disposeRoute?.();
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      store.untrack(job.id);
    }
  }

  return {
    getConfiguration: () =>
      safe(async () => (await ensureReady()).configuration.getConfiguration()),
    saveConnection: (raw) =>
      safe(async () => (await ensureReady()).configuration.saveConnection(raw)),
    deleteConnection: (raw) =>
      safe(async () => (await ensureReady()).configuration.deleteConnection(raw)),
    setDefaultSelection: (raw) =>
      safe(async () => (await ensureReady()).configuration.setDefaultSelection(raw)),
    probeConnection: (raw) =>
      safe(async () => (await ensureReady()).configuration.probeConnection(raw)),
    startGeneration: (raw) =>
      safe(async () => (await ensureReady()).configuration.startGeneration(raw)),
    getRequest: (raw) => safe(async () => (await ensureReady()).configuration.getRequest(raw)),
    readActive: () => safe(async () => ({ job: (await ensureReady()).store.readActive() })),
    readHistory: (raw) => safe(async () => (await ensureReady()).configuration.readHistory(raw)),
    readPreview: (raw) =>
      safe(async () => {
        const { assetId } = parseInput(assetSchema, raw);
        const preview = (await ensureReady()).store.preview(assetId);
        if (!preview)
          throw new ImageGenerationError("Image preview is unavailable.", "storage_error");
        return { preview };
      }),
    readImage: (raw) =>
      safe(async () => {
        const { assetId } = parseInput(assetSchema, raw);
        const state = await ensureReady();
        if (!state.store.hasAsset(assetId))
          throw new ImageGenerationError("Image asset is unavailable.");
        return readOriginal(join(state.assetDir, `${assetId}.png`));
      }),
  };
}
