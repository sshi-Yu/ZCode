import { createRoot } from "react-dom/client";
import { createHostThemeStore, ThemeProvider } from "@zcode-plugins/uis";
import "@zcode-plugins/uis/styles.css";
import "./canvas.css";
import { Canvas } from "./Canvas.js";

// 宿主在加载 HTML 前注入 data-theme；不在根 HTML 硬编码 light，确保深色首帧无白闪。
const themeStore = createHostThemeStore(document.documentElement.getAttribute("data-theme"));
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("GenImage root is missing");

createRoot(rootElement).render(
  <ThemeProvider store={themeStore}>
    <Canvas themeStore={themeStore} />
  </ThemeProvider>,
);
