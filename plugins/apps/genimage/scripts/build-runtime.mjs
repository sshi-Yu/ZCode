import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * 产物自产：esbuild 打包 Node stdio 服务（零运行时依赖，仅 Node 内建），
 * Vite + vite-plugin-singlefile 产出自包含画布 HTML。两者先写入临时目录，
 * 校验通过后才进入目标目录；失败不发布半成品。
 *
 * `buildRuntime(targetDir)` 供市场发布回调复用（目标即临时插件根下的 dist/）。
 */

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

async function bundleServer(targetDir) {
  const outfile = path.join(targetDir, "server.mjs");
  const result = await build({
    absWorkingDir: appRoot,
    entryPoints: [path.join(appRoot, "src/node/server.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
  });
  for (const output of Object.values(result.metafile.outputs)) {
    // 安装产物不带 node_modules：外部依赖只允许 Node 内建模块。
    const external = output.imports.filter((entry) => entry.external && !NODE_BUILTINS.has(entry.path));
    if (external.length > 0) {
      throw new Error(`Server bundle must not depend on runtime packages: ${external.map((e) => e.path).join(", ")}`);
    }
  }
}

async function bundleCanvas(targetDir) {
  const { build: viteBuild } = await import("vite");
  const outDir = await mkdtemp(path.join(tmpdir(), "genimage-canvas-"));
  try {
    await viteBuild({
      root: appRoot,
      configFile: path.join(appRoot, "vite.config.ts"),
      logLevel: "warn",
      build: { outDir },
    });
    const files = await readdir(outDir);
    const htmlFiles = files.filter((file) => file.endsWith(".html"));
    // 单文件产物只应有一个 HTML；多余 chunk 说明内联失败。
    if (!htmlFiles.includes("canvas.html") || htmlFiles.length !== 1) {
      throw new Error(`vite build must produce exactly canvas.html, got: ${files.join(", ")}`);
    }
    await copyFile(path.join(outDir, "canvas.html"), path.join(targetDir, "canvas.html"));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

export async function buildRuntime(targetDir) {
  // 修复依据：OS temp 与仓库可能分属不同卷，跨卷 rename 会 EXDEV。
  // 在目标父目录建立隐藏暂存，所有验证完成后才同卷发布，不暴露半成品。
  const targetParent = path.dirname(targetDir);
  await mkdir(targetParent, { recursive: true });
  const staging = await mkdtemp(path.join(targetParent, ".genimage-runtime-"));
  try {
    await bundleServer(staging);
    await bundleCanvas(staging);
    const files = (await readdir(staging)).sort();
    if (files.join(",") !== "canvas.html,server.mjs") {
      throw new Error(`runtime staging is incomplete: ${files.join(", ")}`);
    }
    await mkdir(targetDir, { recursive: true });
    for (const file of files) {
      await rename(path.join(staging, file), path.join(targetDir, file));
    }
    return files;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// 直接运行时：只替换本包 dist 下的两个运行时文件，保留 dist/market 等其他产物。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildRuntime(path.join(appRoot, "dist"));
  console.log(`GenImage runtime built: ${files.map((file) => `dist/${file}`).join(" + ")} (self-contained, no runtime deps).`);
}
