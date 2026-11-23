import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.mjs";
import { publishMarket } from "../../../scripts/package-market.mjs";

/**
 * 市场交付：manifest/plugin.json + manifest/marketplace.json 由 publishMarket 校验并复制，
 * 回调只在临时插件根下自建 dist/server.mjs 与 dist/canvas.html；验证通过后原子发布 dist/market。
 */

const appRoot = fileURLToPath(new URL("../", import.meta.url));

const market = await publishMarket({
  appRoot,
  build: (pluginDir) => buildRuntime(path.join(pluginDir, "dist")),
});
// 同一份验证过的运行时也放在 app/dist，供本地 stdio / browser 验收使用，不再重复构建。
await mkdir(path.join(appRoot, "dist"), { recursive: true });
for (const file of ["server.mjs", "canvas.html"]) {
  await copyFile(path.join(market, "genimage/dist", file), path.join(appRoot, "dist", file));
}

console.log(`GenImage market published: ${path.relative(appRoot, market)} (genimage@genimage-local 0.1.1).`);
