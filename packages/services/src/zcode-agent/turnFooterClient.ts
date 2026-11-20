import { Emitter, type Event } from "@zcode/rpc";
import {
  isRemoteWorkspaceIdentity,
  zcodeProtocolMethods,
  zcodeRuntimeCapabilitiesSchema,
} from "@zcode/shared";
import {
  TURN_FOOTER_LIMITS,
  V4_METHODS,
  V4_NOTIFICATIONS,
  turnFooterAnchorSchema,
  turnFooterGenerateTextParamsSchema,
  turnFooterGenerateTextResultSchema,
  turnFooterHistoryParamsSchema,
  turnFooterHistoryResultSchema,
  turnFooterResolveAnchorParamsSchema,
  turnFooterResolveAnchorResultSchema,
  turnFooterSubmitSuggestionParamsSchema,
  type CommandAck,
  type CommandEnvelope,
  type TurnFooterCompleted,
  type TurnFooterGenerateTextParams,
  type TurnFooterGenerateTextResult,
  type TurnFooterHistoryParams,
  type TurnFooterResolveAnchorParams,
  type TurnFooterSubmitSuggestionParams,
  type TurnFooterWorkspace,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";

export interface TurnFooterClientDeps {
  getReadClient(target: TurnFooterWorkspace): Promise<ZCodeProtocolClient>;
  getModelClient(target: TurnFooterWorkspace): Promise<ZCodeProtocolClient>;
  sendCommand(input: TurnFooterWorkspace & { envelope: CommandEnvelope }): Promise<CommandAck>;
}

function assertLocal(target: TurnFooterWorkspace): void {
  if (
    isRemoteWorkspaceIdentity(target.workspaceIdentity ?? "") ||
    (target as { remoteSessionId?: string }).remoteSessionId
  ) {
    throw new Error("turnFooter.localOnly");
  }
}

export function createTurnFooterClient(deps: TurnFooterClientDeps) {
  const completed = new Emitter<TurnFooterCompleted>();
  return {
    onTurnFooterCompleted: completed.event as Event<TurnFooterCompleted>,
    async resolveTurnFooterAnchor(input: TurnFooterResolveAnchorParams) {
      assertLocal(input);
      const params = turnFooterResolveAnchorParamsSchema.parse(input);
      const client = await deps.getReadClient(params);
      return client.request(
        V4_METHODS.turnFooterResolveAnchor,
        params,
        turnFooterResolveAnchorResultSchema,
      );
    },
    async readTurnFooterHistory(input: TurnFooterHistoryParams) {
      assertLocal(input);
      const params = turnFooterHistoryParamsSchema.parse(input);
      const client = await deps.getReadClient(params);
      return client.request(
        V4_METHODS.turnFooterReadHistory,
        params,
        turnFooterHistoryResultSchema,
      );
    },
    async generateTurnFooterText(
      input: TurnFooterGenerateTextParams,
    ): Promise<TurnFooterGenerateTextResult> {
      assertLocal(input);
      const params = turnFooterGenerateTextParamsSchema.parse(input);
      const client = await deps.getModelClient(params);
      try {
        // 只有这一次请求；断线/超时不能走任何重试或 legacy 生成入口。
        return await client.request(
          V4_METHODS.turnFooterGenerateText,
          params,
          turnFooterGenerateTextResultSchema,
          {
            timeoutMs: TURN_FOOTER_LIMITS.requestTimeoutMs,
            invalidateConnectionOnTimeout: false,
          },
        );
      } catch {
        return { status: "unknown", code: "turnFooter.transportUnknown" };
      }
    },
    async submitTurnFooterSuggestion(
      input: TurnFooterSubmitSuggestionParams,
    ): Promise<{ status: "accepted" | "stale" | "blocked" }> {
      assertLocal(input);
      const params = turnFooterSubmitSuggestionParamsSchema.parse(input);
      const client = await deps.getReadClient(params);
      try {
        const capabilities = await client.request(
          zcodeProtocolMethods.runtimeCapabilities,
          {},
          zcodeRuntimeCapabilitiesSchema,
        );
        // 旧 CLI 的 sendText 会静默剥掉 guard；绝不降级为无锚点发送。
        if (capabilities.turnFooterAnchorGuard !== true) return { status: "blocked" };
      } catch {
        return { status: "blocked" };
      }
      const ack = await deps.sendCommand({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        envelope: {
          commandId: params.commandId,
          clientId: `turn-footer:${params.pluginId}`,
          sessionId: params.sessionId,
          type: "sendText",
          issuedAt: Date.now(),
          payload: {
            text: params.text,
            source: { kind: "extension", pluginId: params.pluginId },
            expectedTurnFooterAnchor: turnFooterAnchorSchema.parse({
              sessionId: params.sessionId,
              productTurnId: params.productTurnId,
              assistantMessageId: params.assistantMessageId,
            }),
          },
        },
      });
      return {
        status:
          ack.status === "accepted" || ack.status === "duplicate"
            ? "accepted"
            : ack.status === "stale"
              ? "stale"
              : "blocked",
      };
    },
    handleNotification(
      workspace: TurnFooterWorkspace,
      message: { method: string; params?: unknown },
    ) {
      if (message.method !== V4_NOTIFICATIONS.turnFooterCompleted) return false;
      const parsed = turnFooterAnchorSchema.safeParse(message.params);
      if (
        parsed.success &&
        !isRemoteWorkspaceIdentity(workspace.workspaceIdentity ?? "") &&
        !(workspace as { remoteSessionId?: string }).remoteSessionId
      ) {
        completed.fire({ ...workspace, ...parsed.data });
      }
      return true;
    },
    dispose: () => completed.dispose(),
  };
}
