import { mkdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { publishMarket } from "../../../scripts/package-market.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
await publishMarket({
  appRoot,
  async build(pluginDir) {
    const outdir = join(pluginDir, "dist");
    await mkdir(outdir, { recursive: true });
    // worker 是独立入口，new URL("./storage-worker.mjs", import.meta.url) 保持安装后的相对关系。
    const result = await build({
      absWorkingDir: appRoot,
      entryPoints: {
        index: "src/index.ts",
        storage: "src/storage.ts",
        "storage-worker": "src/storage-worker.ts",
      },
      outdir,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      splitting: false,
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: false,
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
    });
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some((entry) => entry.external && !isBuiltin(entry.path))) {
        throw new Error("NextStep installation must only depend on Node builtins");
      }
    }
  },
});
console.log("NextStep market published (nextstep@dev-zcode-1b53af4a 0.1.2).");
