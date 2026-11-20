import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  ExtensionError,
  grantsCover,
  turnFooterAnchorSchema,
  turnFooterGenerateResultSchema,
  turnFooterHistoryResultSchema,
  turnFooterResultSchema,
  turnFooterSubmitResultSchema,
  type CapabilityInput,
  type CapabilityOutput,
  type ContributionSnapshot,
  type ExtensionDeclaration,
  type ExtensionStaticTable,
  type IExtensionHostChannel,
  type TurnFooterAnchor,
  type TurnFooterChange,
  type TurnFooterCommandArgs,
  type TurnFooterRequest,
  type TurnFooterResponse,
  type TurnFooterResult,
  type TurnFooterTarget,
  type WorkspaceRef,
} from "@zcode/shared/extension-host";
import type { CapabilityCallContext } from "#src/extensions/capabilityTypes.js";
import type { WorkbenchState } from "#src/extensions/workbenchState.js";
import type { AuditLog } from "#src/extensions/auditLog.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";

const SLOT = "conversation.turnFooter";
const PERMIT_LIFETIME_MS = 120_000;
const MAX_PERMITS = 256;
const MAX_ANCHORS = 4096;
const MAX_REQUESTS_PER_ANCHOR = 512;

class TurnFooterUnavailableError extends ExtensionError {
  constructor() {
    super("conflict", "turn footer target is no longer available");
  }
}

interface Provider {
  gen: number;
  epoch: number;
  host: IExtensionHostChannel;
  pluginId: string;
  commandId: string;
  facts: string;
}

interface AnchorRecord {
  anchor: TurnFooterAnchor;
  workspace: WorkspaceRef;
  provider: Provider;
  watermark: { version: number; revision: number } | null;
  requests: Set<string>;
  submissions: Map<string, { version: number; suggestionId: string }>;
  pendingRequest: boolean;
  completedSeen: boolean;
}

interface Permit {
  provider: Provider;
  record: AnchorRecord;
  expiresAt: number;
  historyUsed: boolean;
  generationUsed: boolean;
}

export interface TurnFooterRelay {
  request(input: TurnFooterRequest): Promise<TurnFooterResponse>;
  readonly onDidChange: Event<TurnFooterChange | null>;
  history(
    input: CapabilityInput<"turnFooter.history">,
    call: CapabilityCallContext,
  ): Promise<CapabilityOutput<"turnFooter.history">>;
  generate(
    input: CapabilityInput<"turnFooter.generate">,
    call: CapabilityCallContext,
  ): Promise<CapabilityOutput<"turnFooter.generate">>;
  invalidate(
    input: CapabilityInput<"turnFooter.invalidate">,
    call: CapabilityCallContext,
  ): Promise<undefined>;
  /** 静态表、运行状态、授权或连接变化后重算；失去绑定的 nonce 立即作废。 */
  factsChanged(): void;
  assertGenericCommand(commandId: string): void;
  dispose(): void;
}

/** 只读/生成均沿 CLI 当前分支的公开端口；Host 不持推荐正文或另一份会话状态。 */
export function createTurnFooterRelay(deps: {
  connection(): { gen: number; host: IExtensionHostChannel } | null;
  staticTable(): ExtensionStaticTable;
  declarations(): readonly ExtensionDeclaration[];
  snapshot(): ContributionSnapshot | null;
  granted(pluginId: string, grant: "sessions.read" | "turnFooter.generate"): boolean;
  workbench: WorkbenchState;
  agent: Pick<
    IZCodeAgentService,
    | "onTurnFooterCompleted"
    | "resolveTurnFooterAnchor"
    | "readTurnFooterHistory"
    | "generateTurnFooterText"
    | "submitTurnFooterSuggestion"
  >;
  logger: Pick<ServiceLogger, "warn">;
  audit: Pick<AuditLog, "append">;
}): TurnFooterRelay {
  const changed = new Emitter<TurnFooterChange | null>();
  const permits = new Map<string, Permit>();
  const anchors = new Map<string, AnchorRecord>();
  const chains = new Map<string, Promise<unknown>>();
  const denialAudits = new Map<string, { count: number; since: number }>();
  let disposed = false;
  let providerEpoch = 0;
  let providerFacts: string | null = null;

  const workspaceKey = (workspace: WorkspaceRef) =>
    workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const local = (workspace: WorkspaceRef) =>
    !workspace.workspaceIdentity || !isRemoteWorkspaceIdentity(workspace.workspaceIdentity);
  const anchorKey = (anchor: TurnFooterAnchor) =>
    JSON.stringify([
      anchor.workspaceKey,
      anchor.sessionId,
      anchor.productTurnId,
      anchor.assistantMessageId,
    ]);
  const visible = (workspace: WorkspaceRef, sessionId: string) =>
    local(workspace) &&
    deps.workbench
      .sessions()
      .some(
        (session) =>
          !session.isDraft &&
          session.sessionId === sessionId &&
          local(session.workspace) &&
          workspaceKey(session.workspace) === workspaceKey(workspace) &&
          session.workspace.workspacePath === workspace.workspacePath,
      );

  const visibleSet = () =>
    JSON.stringify(
      deps.workbench
        .sessions()
        .filter((session) => !session.isDraft && local(session.workspace))
        .map((session) =>
          JSON.stringify([
            workspaceKey(session.workspace),
            session.workspace.workspacePath,
            session.sessionId,
          ]),
        )
        .sort(),
    );
  let visibleSessions = visibleSet();
  const workbenchSubscription = deps.workbench.onDidChangeSessions(() => {
    const next = visibleSet();
    if (next === visibleSessions) return;
    visibleSessions = next;
    // 子控件的初次读取可早于父层报告；报告后只使读取失效，不能顺带补生成。
    changed.fire(null);
  });

  const currentProvider = (): Provider | null => {
    const connection = deps.connection();
    const snapshot = deps.snapshot();
    if (disposed || !connection || snapshot?.gen !== connection.gen) return null;
    const candidates = deps.staticTable().plugins.flatMap((plugin) => {
      const extension = plugin.extension;
      if (
        plugin.activation ||
        extension?.state !== "ok" ||
        !extension.main ||
        !grantsCover(extension.grants, "sessions.read") ||
        !grantsCover(extension.grants, "turnFooter.generate") ||
        !deps.granted(plugin.pluginId, "sessions.read") ||
        !deps.granted(plugin.pluginId, "turnFooter.generate") ||
        !snapshot.extensions.some(
          (entry) => entry.pluginId === plugin.pluginId && entry.state === "active",
        )
      )
        return [];
      const declaration = deps.declarations().find((entry) => entry.pluginId === plugin.pluginId);
      if (!declaration) return [];
      return plugin.slotItems
        .filter((item) => item.slot === SLOT && item.target.kind === "command")
        .map((item) => ({ plugin, declaration, item }));
    });
    // 多个授权插件仍只有一条准入路径；顺序不依赖清单读取或 RPC 到达顺序。
    candidates.sort(
      (a, b) =>
        a.item.order - b.item.order ||
        compare(a.plugin.pluginId, b.plugin.pluginId) ||
        compare(a.item.id, b.item.id),
    );
    const candidate = candidates[0];
    if (!candidate) return null;
    return {
      gen: connection.gen,
      epoch: providerEpoch,
      host: connection.host,
      pluginId: candidate.plugin.pluginId,
      commandId: candidate.item.target.id,
      facts: JSON.stringify([
        connection.gen,
        candidate.plugin,
        candidate.declaration,
        candidate.item,
      ]),
    };
  };

  const assertProvider = (provider: Provider) => {
    const current = currentProvider();
    if (
      !current ||
      current.host !== provider.host ||
      current.facts !== provider.facts ||
      current.epoch !== provider.epoch
    ) {
      throw new TurnFooterUnavailableError();
    }
  };
  const assertCaller = (provider: Provider, call: CapabilityCallContext) => {
    assertProvider(provider);
    if (call.gen !== provider.gen || call.pluginId !== provider.pluginId) {
      throw new ExtensionError("forbidden", "turn footer request is not bound to this provider");
    }
  };
  const remember = (
    anchor: TurnFooterAnchor,
    workspace: WorkspaceRef,
    provider: Provider,
  ): AnchorRecord => {
    const key = anchorKey(anchor);
    const current = anchors.get(key);
    if (
      current?.provider.facts === provider.facts &&
      current.provider.host === provider.host &&
      current.provider.epoch === provider.epoch
    ) {
      return current;
    }
    if (!current && anchors.size >= MAX_ANCHORS) {
      throw new ExtensionError("limit-exceeded", "turn footer anchor limit reached");
    }
    const record: AnchorRecord = {
      anchor,
      workspace,
      provider,
      watermark: null,
      requests: new Set(),
      submissions: new Map(),
      pendingRequest: false,
      completedSeen: false,
    };
    anchors.set(key, record);
    return record;
  };
  const serial = <T>(anchor: TurnFooterAnchor, run: () => Promise<T>): Promise<T> => {
    const key = anchorKey(anchor);
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    chains.set(key, next);
    void next
      .finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      })
      .catch(() => undefined);
    return next;
  };
  const observe = (record: AnchorRecord, result: TurnFooterResult): boolean => {
    const current = record.watermark;
    if (!result) return current === null;
    if (
      current &&
      (result.version < current.version ||
        (result.version === current.version && result.revision < current.revision))
    )
      return false;
    record.watermark = { version: result.version, revision: result.revision };
    return true;
  };

  const resolveTarget = async (target: TurnFooterTarget, provider: Provider) => {
    assertProvider(provider);
    if (!visible(target, target.sessionId)) return null;
    const resolved = await deps.agent.resolveTurnFooterAnchor(target);
    assertProvider(provider);
    if (!resolved || !visible(target, target.sessionId)) return null;
    return turnFooterAnchorSchema.parse({
      workspaceKey: workspaceKey(target),
      sessionId: target.sessionId,
      productTurnId: resolved.productTurnId,
      assistantMessageId: resolved.assistantMessageId,
    });
  };
  const revalidate = async (target: TurnFooterTarget, record: AnchorRecord) => {
    const current = await resolveTarget(target, record.provider);
    return current !== null && anchorKey(current) === anchorKey(record.anchor);
  };
  const cliInput = (record: AnchorRecord) => ({
    ...record.workspace,
    sessionId: record.anchor.sessionId,
    productTurnId: record.anchor.productTurnId,
    assistantMessageId: record.anchor.assistantMessageId,
  });
  const invoke = async (record: AnchorRecord, args: TurnFooterCommandArgs) => {
    assertProvider(record.provider);
    const raw = await record.provider.host.executeCommand({
      commandId: record.provider.commandId,
      scope: { kind: "session", workspace: record.workspace, sessionId: record.anchor.sessionId },
      args,
    });
    assertProvider(record.provider);
    return turnFooterResultSchema.parse(raw);
  };
  const readLatest = async (record: AnchorRecord): Promise<TurnFooterResult> => {
    // invalidate 可与读取交错；按插件持久 version/revision 重读一次，绝不返回低于水位的旧读。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await invoke(record, { kind: "readLatest", anchor: record.anchor });
      if (observe(record, result)) return result;
    }
    throw new ExtensionError("conflict", "turn footer result changed while reading");
  };
  const issuePermit = (record: AnchorRecord) => {
    assertProvider(record.provider);
    const now = Date.now();
    for (const [nonce, permit] of permits) {
      if (permit.expiresAt <= now) permits.delete(nonce);
    }
    if (permits.size >= MAX_PERMITS) {
      throw new ExtensionError("limit-exceeded", "turn footer permit limit reached");
    }
    const nonce = randomUUID();
    permits.set(nonce, {
      provider: record.provider,
      record,
      expiresAt: now + PERMIT_LIFETIME_MS,
      historyUsed: false,
      generationUsed: false,
    });
    return nonce;
  };
  const requirePermit = (nonce: string, call: CapabilityCallContext) => {
    const permit = permits.get(nonce);
    if (!permit || permit.expiresAt <= Date.now()) {
      permits.delete(nonce);
      throw new ExtensionError("forbidden", "turn footer permit expired or unavailable");
    }
    assertCaller(permit.provider, call);
    return permit;
  };
  const auditPermitDenial = (
    call: CapabilityCallContext,
    capability: "turnFooter.history" | "turnFooter.generate",
  ) => {
    const key = JSON.stringify([call.gen, call.pluginId, capability]);
    const now = Date.now();
    let budget = denialAudits.get(key);
    if (!budget || now - budget.since >= 60_000) {
      if (denialAudits.size >= 128) denialAudits.clear();
      budget = { count: 0, since: now };
      denialAudits.set(key, budget);
    }
    if (budget.count >= 8) return;
    budget.count += 1;
    // 拒绝审计限频；不保存 nonce、锚点、提示词或错误原文。
    void deps.audit
      .append({
        gen: call.gen,
        pluginId: call.pluginId,
        capability,
        outcome: "error",
        errorCode: "forbidden",
      })
      .catch(warn);
  };
  const admitPermit = (
    nonce: string,
    call: CapabilityCallContext,
    capability: "turnFooter.history" | "turnFooter.generate",
  ) => {
    try {
      const permit = requirePermit(nonce, call);
      if (permit.generationUsed || (capability === "turnFooter.history" && permit.historyUsed)) {
        throw new ExtensionError("forbidden", "turn footer permit was already consumed");
      }
      return permit;
    } catch (error) {
      auditPermitDenial(call, capability);
      throw error;
    }
  };
  const generate = async (
    record: AnchorRecord,
    kind: "completed" | "refresh",
    requestId: string,
    target?: TurnFooterTarget,
  ): Promise<TurnFooterResult> => {
    assertProvider(record.provider);
    if (record.requests.has(requestId)) return readLatest(record);
    const latest = await readLatest(record);
    if (latest?.status === "generating" || (kind === "completed" && latest !== null)) return latest;
    if (target && !(await revalidate(target, record))) {
      throw new TurnFooterUnavailableError();
    }
    if (record.requests.size >= MAX_REQUESTS_PER_ANCHOR) {
      throw new ExtensionError("limit-exceeded", "turn footer request limit reached");
    }
    const permit = issuePermit(record);
    // 在跨进程调用前记受理；失联时也不重发。持久去重继续由插件的事务认领负责。
    record.requests.add(requestId);
    const result = await invoke(record, { kind, anchor: record.anchor, requestId, permit });
    return observe(record, result) ? result : readLatest(record);
  };
  const warn = () => deps.logger.warn(undefined, "turn footer operation unavailable");

  const completed = deps.agent.onTurnFooterCompleted((event) => {
    const provider = currentProvider();
    if (!provider || !local(event)) return;
    const parsed = turnFooterAnchorSchema.safeParse({
      workspaceKey: workspaceKey(event),
      sessionId: event.sessionId,
      productTurnId: event.productTurnId,
      assistantMessageId: event.assistantMessageId,
    });
    if (!parsed.success) return;
    // 订阅回调不等待插件或模型；已接受的生成不因 Renderer 切走而取消。
    try {
      const record = remember(
        parsed.data,
        {
          workspacePath: event.workspacePath,
          ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
        },
        provider,
      );
      if (record.completedSeen) return;
      record.completedSeen = true;
      if (record.pendingRequest) return;
      record.pendingRequest = true;
      void serial(record.anchor, () => generate(record, "completed", randomUUID()))
        .catch(warn)
        .finally(() => {
          record.pendingRequest = false;
        });
    } catch {
      warn();
    }
  });

  return {
    async request(input) {
      const unavailable: TurnFooterResponse =
        input.kind === "submit" ? { kind: "submitted", status: "stale" } : { kind: "unavailable" };
      try {
        const provider = currentProvider();
        if (!provider) return unavailable;
        const anchor = await resolveTarget(input.target, provider);
        if (!anchor) return unavailable;
        const record = remember(
          anchor,
          {
            workspacePath: input.target.workspacePath,
            ...(input.target.workspaceIdentity
              ? { workspaceIdentity: input.target.workspaceIdentity }
              : {}),
          },
          provider,
        );
        if (input.kind === "refresh" && record.pendingRequest) {
          const result = await readLatest(record);
          return (await revalidate(input.target, record)) && observe(record, result)
            ? { kind: "view", result }
            : unavailable;
        }
        const refreshOwner = input.kind === "refresh";
        if (refreshOwner) record.pendingRequest = true;
        try {
          return await serial(anchor, async (): Promise<TurnFooterResponse> => {
            if (!(await revalidate(input.target, record))) return unavailable;
            if (input.kind === "submit") {
              const previous = record.submissions.get(input.commandId);
              if (previous) {
                return {
                  kind: "submitted",
                  status:
                    previous.version === input.version &&
                    previous.suggestionId === input.suggestionId
                      ? "accepted"
                      : "stale",
                };
              }
              if (record.submissions.size >= MAX_REQUESTS_PER_ANCHOR) {
                return { kind: "submitted", status: "blocked" };
              }
              const latest = await readLatest(record);
              if (latest?.status !== "ready" || latest.version !== input.version)
                return unavailable;
              const suggestion = latest.items.find((item) => item.id === input.suggestionId);
              if (!suggestion || !(await revalidate(input.target, record))) return unavailable;
              // revalidate 期间可能到达新版本的 invalidate，旧版本不得进入输入准入。
              if (
                record.watermark?.version !== latest.version ||
                record.watermark.revision !== latest.revision
              ) {
                return unavailable;
              }
              const result = turnFooterSubmitResultSchema.parse(
                await deps.agent.submitTurnFooterSuggestion({
                  ...cliInput(record),
                  text: suggestion.prompt,
                  commandId: input.commandId,
                  pluginId: provider.pluginId,
                }),
              );
              assertProvider(provider);
              if (result.status === "accepted") {
                record.submissions.set(input.commandId, {
                  version: input.version,
                  suggestionId: input.suggestionId,
                });
              }
              return { kind: "submitted", status: result.status };
            }
            const result =
              input.kind === "readLatest"
                ? await readLatest(record)
                : await generate(record, "refresh", input.requestId, input.target);
            return (await revalidate(input.target, record)) && observe(record, result)
              ? { kind: "view", result }
              : unavailable;
          });
        } finally {
          if (refreshOwner) record.pendingRequest = false;
        }
      } catch (error) {
        if (error instanceof TurnFooterUnavailableError) return unavailable;
        warn();
        if (input.kind === "submit") return { kind: "submitted", status: "blocked" };
        throw new ExtensionError("host-unavailable", "turn footer request could not be completed");
      }
    },
    onDidChange: changed.event,
    async history(input, call) {
      const permit = admitPermit(input.permit, call, "turnFooter.history");
      permit.historyUsed = true;
      const result = await deps.agent.readTurnFooterHistory(cliInput(permit.record));
      assertCaller(permit.provider, call);
      return turnFooterHistoryResultSchema.parse({ messages: result });
    },
    async generate(input, call) {
      const permit = admitPermit(input.permit, call, "turnFooter.generate");
      // 必须在 await 前消耗 nonce；同一版本最多发出一次模型请求，未知结果也不补发。
      permit.generationUsed = true;
      try {
        const result = await deps.agent.generateTurnFooterText({
          ...cliInput(permit.record),
          text: input.text,
          maxOutputTokens: input.maxOutputTokens,
        });
        assertCaller(permit.provider, call);
        return turnFooterGenerateResultSchema.parse(result);
      } finally {
        permits.delete(input.permit);
      }
    },
    async invalidate(input, call) {
      const record = anchors.get(anchorKey(input.anchor));
      if (!record) throw new ExtensionError("forbidden", "turn footer anchor is not bound");
      assertCaller(record.provider, call);
      const current = record.watermark;
      if (
        current &&
        (input.version < current.version ||
          (input.version === current.version && input.revision <= current.revision))
      )
        return undefined;
      record.watermark = { version: input.version, revision: input.revision };
      if (visible(record.workspace, record.anchor.sessionId)) changed.fire(input);
      return undefined;
    },
    factsChanged() {
      const provider = currentProvider();
      const next = provider?.facts ?? null;
      if (providerFacts !== next) {
        // 撤权再授权可能恢复相同清单；epoch 阻止旧 await 在绑定恢复后复活。
        providerEpoch += 1;
        providerFacts = next;
        anchors.clear();
        changed.fire(null);
      }
      for (const [nonce, permit] of permits) {
        if (
          !provider ||
          permit.provider.host !== provider.host ||
          permit.provider.facts !== next ||
          permit.provider.epoch !== providerEpoch
        ) {
          permits.delete(nonce);
        }
      }
    },
    assertGenericCommand(commandId) {
      if (
        deps
          .staticTable()
          .plugins.some((plugin) =>
            plugin.slotItems.some(
              (item) =>
                item.slot === SLOT &&
                item.target.kind === "command" &&
                item.target.id === commandId,
            ),
          )
      )
        throw new ExtensionError("forbidden", "turn footer commands require host admission");
    },
    dispose() {
      disposed = true;
      completed.dispose();
      workbenchSubscription.dispose();
      permits.clear();
      anchors.clear();
      denialAudits.clear();
      chains.clear();
      changed.dispose();
    },
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
