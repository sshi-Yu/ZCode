import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TurnFooterResponse, TurnFooterResult } from "@zcode/shared/extension-host";
import { logger } from "@/logger.js";
import { useExtensionsService } from "@/extension-slots/adapters/useExtensionSlots.js";
import type { TurnFooterSlotModel, TurnFooterSlotProps } from "@/extension-slots/contract.js";

interface FooterView {
  key: string;
  available: boolean | null;
  result: TurnFooterResult;
  pending: TurnFooterSlotModel["pending"];
  submitted: boolean;
  error: TurnFooterSlotModel["error"];
}

interface FooterController {
  key: string;
  read(): void;
  refresh(): void;
  submit(suggestionId: string, version: number): void;
}

type FooterRevision = { version: number; revision: number };

function compareRevision(left: FooterRevision, right: FooterRevision): number {
  return left.version - right.version || left.revision - right.revision;
}

function emptyView(key: string): FooterView {
  return { key, available: null, result: null, pending: "read", submitted: false, error: null };
}

/** 只投影当前挂载目标；推荐的持久状态和发送准入均由 Host/插件拥有。 */
export function useTurnFooterSlot({
  target: { workspacePath, workspaceIdentity, sessionId, rowId },
  productTurnId,
  submissionBlocked,
}: TurnFooterSlotProps): TurnFooterSlotModel | null {
  const service = useExtensionsService();
  const target = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId,
      rowId,
    }),
    [rowId, sessionId, workspaceIdentity, workspacePath],
  );
  const key = JSON.stringify([workspacePath, workspaceIdentity, sessionId, productTurnId, rowId]);
  const [view, setView] = useState<FooterView>(() => emptyView(key));
  const controllerRef = useRef<FooterController | null>(null);

  useEffect(() => {
    if (!service) return;
    let active = true;
    let generation = 0;
    let issued = 0;
    let reading = false;
    let readFailed = false;
    let actionPending: "refresh" | "submit" | null = null;
    let submitted = false;
    let result: TurnFooterResult = null;
    let latestRevision: FooterRevision | null = null;
    const workspaceKey = workspaceIdentity?.trim() || workspacePath;
    const publish = (patch: Partial<FooterView>) => {
      if (!active) return;
      setView((current) => ({
        ...(current.key === key ? current : emptyView(key)),
        pending: actionPending ?? (reading ? "read" : null),
        ...patch,
      }));
    };
    const apply = (response: TurnFooterResponse, seq: number) => {
      if (!active || seq !== issued) return;
      if (response.kind === "unavailable") {
        readFailed = false;
        result = null;
        publish({ available: false, result: null, error: null });
        return;
      }
      if (response.kind !== "view") return;
      // 通知可先于旧读返回；持久版本/revision 的水位防止旧状态覆盖新状态。
      if (
        latestRevision &&
        (!response.result || compareRevision(response.result, latestRevision) < 0)
      )
        return;
      const newerVersion = result && response.result && response.result.version > result.version;
      result = response.result;
      latestRevision = result;
      if (newerVersion) submitted = false;
      readFailed = false;
      publish({ available: true, result, submitted });
      setView((current) =>
        current.key === key &&
        (current.error === "read" || (newerVersion && current.error === "stale"))
          ? { ...current, error: null }
          : current,
      );
    };
    const read = () => {
      const seq = ++issued;
      reading = true;
      publish({});
      void service.turnFooter({ kind: "readLatest", target }).then(
        (response) => {
          if (!active || seq !== issued) return;
          reading = false;
          apply(response, seq);
          publish({});
        },
        (error: unknown) => {
          if (!active || seq !== issued) return;
          reading = false;
          readFailed = true;
          logger.lifecycle.warn("[extension-slots] turn footer read failed", {
            name: error instanceof Error ? error.name : typeof error,
          });
          publish({ available: true, error: "read" });
        },
      );
    };
    const run = (kind: "refresh" | "submit", suggestionId?: string, version?: number) => {
      if (!active || actionPending || reading || result?.status === "generating" || readFailed)
        return;
      if (
        kind === "submit" &&
        (submitted || result?.status !== "ready" || result.version !== version)
      )
        return;
      const seq = ++issued;
      const actionGeneration = generation;
      actionPending = kind;
      publish({ error: null });
      // 每次用户动作分配一次标识；同一受理等待期间不会重新分配或重复发送。
      const command =
        kind === "refresh"
          ? ({ kind, target, requestId: crypto.randomUUID() } as const)
          : ({
              kind,
              target,
              version: version!,
              suggestionId: suggestionId!,
              commandId: crypto.randomUUID(),
            } as const);
      void service.turnFooter(command).then(
        (response) => {
          if (!active || actionGeneration !== generation) return;
          actionPending = null;
          // 新版本可能先于旧提交回执到达；旧动作不能给新版本加上已提交/拒绝状态。
          if (kind === "submit" && result?.version !== version) {
            publish({});
            return;
          }
          if (response.kind === "submitted") {
            submitted = response.status === "accepted";
            publish({
              submitted,
              error: submitted ? null : response.status === "stale" ? "stale" : "blocked",
            });
            if (!submitted) read();
          } else {
            if (kind === "refresh") submitted = false;
            apply(response, seq);
            publish({ submitted });
          }
        },
        (error: unknown) => {
          if (!active || actionGeneration !== generation) return;
          actionPending = null;
          if (seq !== issued) {
            publish({});
            return;
          }
          logger.lifecycle.warn("[extension-slots] turn footer action failed", {
            kind,
            name: error instanceof Error ? error.name : typeof error,
          });
          publish({ error: kind });
        },
      );
    };
    setView(emptyView(key));
    controllerRef.current = {
      key,
      read,
      refresh: () => run("refresh"),
      submit: (suggestionId, version) => run("submit", suggestionId, version),
    };
    // 必须先订阅再初读；通知只使读取失效，永不触发 refresh/额外模型请求。
    const subscription = service.onDynamicTurnFooterChanged(undefined)((change) => {
      if (!change) {
        generation += 1;
        latestRevision = null;
        actionPending = null;
        // reset 也可能只是可见会话集合变化：只读确认期间保留同版本布局和提交收据。
        publish({ available: result ? true : null, error: null });
        read();
        return;
      }
      if (
        change.anchor.workspaceKey !== workspaceKey ||
        change.anchor.sessionId !== sessionId ||
        change.anchor.productTurnId !== productTurnId ||
        (latestRevision && compareRevision(change, latestRevision) <= 0)
      )
        return;
      latestRevision = change;
      read();
    });
    read();
    return () => {
      active = false;
      issued += 1;
      subscription.dispose();
      if (controllerRef.current?.key === key) controllerRef.current = null;
    };
  }, [key, productTurnId, service, sessionId, target, workspaceIdentity, workspacePath]);

  const retryRead = useCallback(() => {
    if (controllerRef.current?.key === key) controllerRef.current.read();
  }, [key]);
  const refresh = useCallback(() => {
    if (controllerRef.current?.key === key) controllerRef.current.refresh();
  }, [key]);
  const submit = useCallback(
    (suggestionId: string, version: number) => {
      if (!submissionBlocked && controllerRef.current?.key === key) {
        controllerRef.current.submit(suggestionId, version);
      }
    },
    [key, submissionBlocked],
  );
  // 初读的资格尚未确定，必须回传等待态；只有 Host 明确 unavailable 才隐藏。
  return service && view.key === key && view.available !== false
    ? {
        result: view.result,
        pending: view.pending,
        submitted: view.submitted,
        error: view.error,
        retryRead,
        refresh,
        submit,
      }
    : null;
}
