import { useEffect, useRef, useState } from "react";
import { App } from "@modelcontextprotocol/ext-apps";
import type { HostStatus } from "./types.js";
import type { HostThemeStore } from "@zcode-plugins/uis";

export interface UseHostBridgeOptions {
  themeStore: HostThemeStore;
  onBrief: (brief: unknown, isError: unknown) => void;
  onStatus: (status: HostStatus) => void;
  onTeardown: () => void;
}

/**
 * 宿主为外观唯一权威；桥接仅转交官方 hostContext 给 uis store，不自行解析样式。
 * 处理器先于 connect 注册，避免宿主在 initialized 后立即重放 tool-result 时丢 brief。
 * App 只声明 fullscreen，autoResize:false，避免全视口画布反向驱动宿主 inline 高度。
 * teardown 先停止桥接通知并将页面切为 unavailable；订阅/计时器由页面卸载后的 effect cleanup 清理，
 * 不依赖 CanvasPage 的空回调，也不保证清理早于 teardown 回复；宿主已受理任务保持不变。
 */
export type PageMode = "pending" | "legacy" | "app" | "unavailable";
export interface PageBridge { app: App | null; mode: PageMode; status: HostStatus; brief: { value: unknown; isError: unknown } | null }

export function useHostBridge({ themeStore, onBrief, onStatus, onTeardown }: UseHostBridgeOptions): PageBridge {
  const [bridge, setBridge] = useState<PageBridge>(() => ({ app: null, mode: window.parent === window ? "legacy" : "pending", status: "standalone", brief: null }));
  // 回调总是读最新已提交值，连接只由稳定的主题 store 生命周期持有，避免主题更新重建画布。
  const handlers = useRef({ onBrief, onStatus, onTeardown });
  useEffect(() => {
    handlers.current = { onBrief, onStatus, onTeardown };
  }, [onBrief, onStatus, onTeardown]);

  useEffect(() => {
    if (window.parent === window) {
      handlers.current.onStatus("standalone");
      return;
    }
    const app = new App(
      { name: "genimage", version: "0.1.1", title: "GenImage" },
      { availableDisplayModes: ["fullscreen"] },
      { autoResize: false },
    );
    let disposed = false;
    const updateContext = (context: unknown) => {
      if (disposed) return;
      themeStore.update(context);
    };
    app.onhostcontextchanged = updateContext;
    app.ontoolresult = (result) => {
      if (disposed) return;
      const structuredContent: unknown = result.structuredContent;
      const brief = structuredContent && typeof structuredContent === "object" && "brief" in structuredContent
        ? structuredContent.brief : undefined;
      setBridge((previous) => ({ ...previous, brief: { value: brief, isError: result.isError } }));
      handlers.current.onBrief(brief, result.isError);
    };
    app.onteardown = async () => {
      disposed = true;
      setBridge((previous) => ({ ...previous, app: null, mode: "unavailable" }));
      handlers.current.onTeardown();
      return {};
    };
    void app.connect().then(async () => {
      if (disposed) return;
      updateContext(app.getHostContext());
      handlers.current.onStatus("connected");
      const context = app.getHostContext();
      // 只接受可信初始化上下文的显式标志；标题及后续外观通知都不能切换业务模式。
      const mode = context && "zcodeGenImage" in context && context.zcodeGenImage === true ? "app" : "legacy";
      setBridge((previous) => ({ ...previous, app, mode, status: "connected" }));
      if (
        context?.displayMode !== "fullscreen" &&
        (context?.availableDisplayModes === undefined || context.availableDisplayModes.includes("fullscreen"))
      ) {
        try {
          const result = await app.requestDisplayMode({ mode: "fullscreen" });
          if (!disposed && result.mode !== "fullscreen") {
            handlers.current.onStatus("fullscreen-denied");
            setBridge((previous) => ({ ...previous, status: "fullscreen-denied" }));
          }
        } catch {
          if (!disposed) {
            handlers.current.onStatus("fullscreen-denied");
            setBridge((previous) => ({ ...previous, status: "fullscreen-denied" }));
          }
        }
      }
    }).catch(() => {
      if (!disposed) {
        handlers.current.onStatus("handshake-failed");
        setBridge((previous) => ({ ...previous, mode: "unavailable", status: "handshake-failed" }));
      }
    });
    return () => {
      disposed = true;
      void app.close();
    };
  }, [themeStore]);
  return bridge;
}
