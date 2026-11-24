import { useSyncExternalStore } from "react";
import type { HostThemeStore } from "@zcode-plugins/uis";
import { Canvas } from "./Canvas.js";
import { AppWorkspace } from "./AppWorkspace.js";
import { appStringsFor } from "./app-strings.js";
import { localeFromHost } from "./strings.js";
import { useHostBridge } from "./use-host-bridge.js";

const ignore = () => {};
export function CanvasPage({ themeStore }: { themeStore: HostThemeStore }) {
  const bridge = useHostBridge({ themeStore, onBrief: ignore, onStatus: ignore, onTeardown: ignore });
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot);
  const strings = appStringsFor(localeFromHost(theme.locale));
  if (bridge.mode === "app" && bridge.app) return <AppWorkspace app={bridge.app} themeStore={themeStore} />;
  if (bridge.mode === "legacy") return <Canvas themeStore={themeStore} bridge={bridge} />;
  // 握手完成之前不挂载模拟节点，应用画布首帧不会闪现开发夹具。
  return <div className="canvas-app text-ui-base"><p className="panel-body small muted" role="status">{bridge.mode === "pending" ? strings.loading : strings.unavailable}</p></div>;
}
