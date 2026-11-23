import { useEffect, useRef } from "react";
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
 * teardown 回复前清理本页订阅/计时器，不改变任何已受理任务（本轮无后端任务）。
 */
export function useHostBridge({ themeStore, onBrief, onStatus, onTeardown }: UseHostBridgeOptions): void {
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
      handlers.current.onBrief(brief, result.isError);
    };
    app.onteardown = async () => {
      disposed = true;
      handlers.current.onTeardown();
      return {};
    };
    void app.connect().then(async () => {
      if (disposed) return;
      updateContext(app.getHostContext());
      handlers.current.onStatus("connected");
      const context = app.getHostContext();
      if (
        context?.displayMode !== "fullscreen" &&
        (context?.availableDisplayModes === undefined || context.availableDisplayModes.includes("fullscreen"))
      ) {
        try {
          const result = await app.requestDisplayMode({ mode: "fullscreen" });
          if (!disposed && result.mode !== "fullscreen") handlers.current.onStatus("fullscreen-denied");
        } catch {
          if (!disposed) handlers.current.onStatus("fullscreen-denied");
        }
      }
    }).catch(() => {
      if (!disposed) handlers.current.onStatus("handshake-failed");
    });
    return () => {
      disposed = true;
      void app.close();
    };
  }, [themeStore]);
}
