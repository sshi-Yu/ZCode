import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.mjs";
import { publishMarket } from "../../../scripts/package-market.mjs";

// 默认遵循仓库市场发布器；--out-dir 给桌面验收新路径，避免覆盖仍被 Electron 使用的旧目录。
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out-dir")) throw new Error("Usage: build-market.mjs [--out-dir <new market directory>]");
const isolatedTarget = args.length ? path.resolve(args[1]) : process.env.GENIMAGE_MARKET_DIR ? path.resolve(process.env.GENIMAGE_MARKET_DIR) : null;
let staging;
try {
  const buildRoot = isolatedTarget ? await (async () => {
    await mkdir(path.dirname(isolatedTarget), { recursive: true });
    staging = await mkdtemp(path.join(tmpdir(), "genimage-market-"));
    await mkdir(path.join(staging, "manifest"));
    for (const file of ["plugin.json", "marketplace.json"]) await copyFile(path.join(appRoot, "manifest", file), path.join(staging, "manifest", file));
    return staging;
  })() : appRoot;
  const prepared = await publishMarket({ appRoot: buildRoot, build: pluginDir => buildRuntime(path.join(pluginDir, "dist")) });
  const market = isolatedTarget ?? prepared;
  if (isolatedTarget) await rename(prepared, isolatedTarget);
  await mkdir(path.join(appRoot, "dist"), { recursive: true });
  for (const file of ["server.mjs", "extension.mjs", "canvas.html"]) {
    await copyFile(path.join(market, "genimage/dist", file), path.join(appRoot, "dist", file));
  }
  console.log(`GenImage market published: ${market} (genimage@genimage-local 0.1.1).`);
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
