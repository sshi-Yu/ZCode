import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GitGenerateCommitMessageRequest } from "@zcode/shared";
import { useServices } from "./useServices.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useConfirmDialog } from "./useConfirmDialog.js";
import type { GitChangeSourceId } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export function formatToolModelError(error: unknown, locale: string): string | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const zh = locale.startsWith("zh");
  switch (code) {
    case "tool-model.reconfirm-required":
      return zh
        ? "配置、会话或提交内容已变化，请重新生成并确认。"
        : "The configuration, conversation or changes have changed. Generate and confirm again.";
    case "tool-model.revision-conflict":
      return zh
        ? "设置已被另一窗口修改。草稿已保留，请刷新配置后重试。"
        : "Another window changed these settings. Your draft is preserved; refresh and retry.";
    case "tool-model.model-unavailable":
      return zh
        ? "指定模型已不可用，请在工具模型设置中修复或恢复默认。"
        : "The selected model is unavailable. Repair the tool binding or restore its default.";
    default:
      return null;
  }
}

export function useGitToolModelGeneration(
  scope: unknown,
  active: boolean,
  target: {
    sessionId?: string;
    sessionWorkspacePath?: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
) {
  const { gitService } = useServices();
  const base = useBaseWorkspaceServices();
  const { sessionId, sessionWorkspacePath, workspaceIdentity, remoteSessionId } = target;
  const service =
    sessionId &&
    sessionWorkspacePath &&
    !workspaceIdentity?.trim() &&
    !remoteSessionId &&
    gitService === base.gitService
      ? base.toolModelSettingsService
      : undefined;
  const requestConfirmation = useConfirmDialog();
  const { locale } = useZCodeIntl();
  const lifetime = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    if (!active) controller.abort();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, [active, scope]);
  return useCallback(
    async (request: GitGenerateCommitMessageRequest) => {
      const signal = lifetime.current?.signal;
      if (signal?.aborted) return null;
      const toolRequest = {
        ...request,
        sessionId: sessionId!,
        sessionWorkspacePath: sessionWorkspacePath!,
        ...(remoteSessionId ? { remoteSessionId } : {}),
      };
      const preparation = service
        ? await service.prepareGitGeneration(toolRequest)
        : { kind: "default" as const };
      if (signal?.aborted) return null;
      if (preparation.kind === "default") {
        const result = await gitService.generateCommitMessage(request);
        return signal?.aborted ? null : { ...result, requiresReview: false };
      }
      const zh = locale.startsWith("zh");
      const confirmed = await requestConfirmation(
        {
          intent: "git-tool-model-generation",
          explicitConfirm: true,
          title: zh ? "使用指定模型生成提交说明？" : "Generate with the selected model?",
          description: `${preparation.providerName} · ${preparation.modelName}\n${request.includeUnstaged !== false ? (zh ? "范围：包含已暂存与未暂存更改。" : "Scope: staged and unstaged changes.") : zh ? "范围：仅已暂存更改。" : "Scope: staged changes only."} ${zh ? "将发送本次提交 diff 和文件摘要" : "Sends commit diffs and file summaries"}${preparation.hasConversationContext ? (zh ? "，以及调用方提供的当前会话上下文" : ", plus current conversation context provided by the caller") : zh ? "；不附加会话正文" : "; no additional conversation content"}${zh ? "。可能产生费用。生成后请检查草稿并另行提交。" : ". Charges may apply. Review the generated draft and submit separately."}`,
        },
        signal,
      );
      if (!confirmed || signal?.aborted) return null;
      const result = await service!.confirmGitGeneration({
        confirmationId: preparation.confirmationId,
        request: toolRequest,
      });
      return signal?.aborted ? null : { ...result, requiresReview: true };
    },
    [
      gitService,
      locale,
      remoteSessionId,
      requestConfirmation,
      service,
      sessionId,
      sessionWorkspacePath,
    ],
  );
}

export function useGitActions(options: { workspacePath: string }) {
  const { workspacePath } = options;
  const { intl } = useZCodeIntl();
  const [refreshVersion, setRefreshVersion] = useState(0);

  const announcePlaceholder = useCallback(
    (action: string, detail: Record<string, unknown>) => {
      logger.info(`[GitPane] ${action} workspace=${workspacePath}`, detail);
      toast(intl.formatMessage({ id: "diff.placeholder.toast" }));
    },
    [intl, workspacePath],
  );

  const refresh = useCallback(
    async (sourceId: GitChangeSourceId) => {
      setRefreshVersion((value) => value + 1);
      announcePlaceholder("refresh", { sourceId });
    },
    [announcePlaceholder],
  );

  const stagePaths = useCallback(
    async (paths: string[]) => {
      announcePlaceholder("stagePaths", { count: paths.length, paths });
    },
    [announcePlaceholder],
  );

  const unstagePaths = useCallback(
    async (paths: string[]) => {
      announcePlaceholder("unstagePaths", { count: paths.length, paths });
    },
    [announcePlaceholder],
  );

  const discardPaths = useCallback(
    async (paths: string[]) => {
      announcePlaceholder("discardPaths", { count: paths.length, paths });
    },
    [announcePlaceholder],
  );

  const commit = useCallback(
    async (message: string) => {
      announcePlaceholder("commit", { messageLength: message.trim().length });
    },
    [announcePlaceholder],
  );

  return {
    refreshVersion,
    refresh,
    stagePaths,
    unstagePaths,
    discardPaths,
    commit,
  };
}
