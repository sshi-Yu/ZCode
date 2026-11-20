// 独立人工检查服务器，仅提供隔离浏览器夹具，不启动或修改 Desktop。
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/nextstep-turn-footer-visual.fixture.tsx";
const server = await createServer({
  root,
  configFile: false,
  plugins: [
    {
      name: "nextstep-review",
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/fixture")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await vite.transformIndexHtml(
              req.url,
              `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
            ),
          );
        });
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": `${root}packages/ui/src` } },
  optimizeDeps: { entries: [entry.slice(1)] },
  server: { host: "127.0.0.1", port: 5188, strictPort: true, hmr: false },
});
await server.listen();
console.log(`${server.resolvedUrls.local[0]}fixture?locale=zh-CN&theme=light`);
