import { useCallback, useEffect, useRef, useState } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { booleanResult, callHost, readSnapshot } from "./app-transport.js";
import type { WorkspaceSnapshot } from "./app-transport.js";

export type OperationNotice = "cancelled" | "accepted" | "unknown" | "saved" | "saveCancelled" | "saveFailed" | "";

/**
 * Host 持久受理 → read 投影 → 页面显示；这里没有第二份任务队列或乐观成功节点。
 * 单飞读取避免旧响应覆盖，只有可见且 running 才每两秒查询；失活/卸载丢弃在途结果。
 * generate/export 只由一次手势调用，不自动重放；响应丢失后仅重新读取事实。
 */
export function useAppWorkspace(app: App) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [readError, setReadError] = useState(false);
  const [reading, setReading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<OperationNotice>("");
  const readRef = useRef<(() => Promise<void>) | null>(null);
  const mutation = useRef(false);
  const exportLock = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let readingNow = false;
    let pending = false;
    let epoch = 0;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timer); timer = undefined; };
    const read = async () => {
      if (disposed || document.hidden || readingNow) return;
      readingNow = true;
      const issued = epoch;
      setReading(true);
      clear();
      try {
        const next = readSnapshot(await callHost(app, "genimage_read", {}));
        if (disposed || document.hidden || epoch !== issued) return;
        running = next.jobs.some(job => job.status === "running");
        setSnapshot(next);
        setReadError(false);
      } catch {
        if (!disposed && !document.hidden && epoch === issued) {
          setReadError(true);
          running = false;
        }
      } finally {
        readingNow = false;
        if (!disposed) {
          setReading(false);
          if (pending && !document.hidden) { pending = false; void read(); }
          else if (running && !document.hidden) timer = setTimeout(() => { void read(); }, 2000);
        }
      }
    };
    const refresh = async () => {
      if (readingNow) { pending = true; return; }
      await read();
    };
    readRef.current = refresh;
    const visibility = () => {
      epoch++;
      clear();
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    void read();
    return () => {
      disposed = true;
      alive.current = false;
      readRef.current = null;
      clear();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [app]);

  const refresh = useCallback(async () => { await readRef.current?.(); }, []);
  const generate = useCallback(async (prompt: string) => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || cleanPrompt.length > 4000 || mutation.current || !snapshot?.settings.configured || snapshot.jobs.some(job => job.status === "running") || document.hidden) return;
    mutation.current = true;
    setSubmitting(true);
    setNotice("");
    // 一次用户动作冻结一份参数；异常不新建 ID 或重试，未知状态交回 read 恢复。
    const args = { requestId: crypto.randomUUID(), prompt: cleanPrompt, modelId: "gpt-image-1" };
    try {
      const accepted = booleanResult(await callHost(app, "genimage_generate", args), "accepted");
      if (alive.current) setNotice(accepted ? "accepted" : "cancelled");
    } catch {
      if (alive.current) setNotice("unknown");
    } finally {
      mutation.current = false;
      if (alive.current) { setSubmitting(false); await refresh(); }
    }
  }, [app, refresh, snapshot]);
  const exportImage = useCallback(async (assetId: string) => {
    if (exportLock.current || document.hidden) return;
    exportLock.current = true;
    setExporting(true);
    setNotice("");
    try {
      const saved = booleanResult(await callHost(app, "genimage_export", { assetId }), "saved");
      if (alive.current) setNotice(saved ? "saved" : "saveCancelled");
    } catch {
      if (alive.current) setNotice("saveFailed");
    } finally {
      exportLock.current = false;
      if (alive.current) setExporting(false);
    }
  }, [app]);
  return { snapshot, readError, reading, submitting, exporting, notice, refresh, generate, exportImage };
}
