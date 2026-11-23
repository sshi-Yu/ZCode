import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 产物是 MCP resources/read 返回的自包含 HTML：dist/canvas.html 必须内联全部 JS/CSS，
// 不引用任何同源文件或网络资源（宿主沙箱 connect-src 缺省 none）。
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    // 只构建画布页；根 index.html 是开发预览的模拟宿主，不入产物。
    rollupOptions: { input: { canvas: "canvas.html" } },
    target: "es2022",
    outDir: "dist/vite-out",
    emptyOutDir: true,
  },
});
