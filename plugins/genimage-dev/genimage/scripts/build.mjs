import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const sdkRoot = path.resolve(
  path.dirname(require.resolve("@modelcontextprotocol/sdk/server/index.js")),
  "../../..",
);
for (const [name, packageFile] of [
  ["@modelcontextprotocol/sdk", path.join(sdkRoot, "package.json")],
  ["esbuild", require.resolve("esbuild/package.json")],
]) {
  const installed = JSON.parse(await readFile(packageFile, "utf8"));
  if (installed.version !== pkg.devDependencies[name]) {
    throw new Error(
      `Build requires ${name} ${pkg.devDependencies[name]}; found ${installed.version}`,
    );
  }
}

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--stage")) {
  throw new Error("Usage: node scripts/build.mjs [--stage <empty-output-directory>]");
}
// Both MCP and development HTTP serve this same source asset; never embed a stale HTML copy.
await readFile(path.join(root, "ui/canvas.html"), "utf8");
const outfile = path.join(root, "dist/server.mjs");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/server.mjs"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  logLevel: "silent",
  metafile: true,
  banner: {
    js: 'import { createRequire as __genimageCreateRequire } from "node:module"; const require = __genimageCreateRequire(import.meta.url);',
  },
});
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some((entry) => entry.external && !builtins.has(entry.path))) {
    throw new Error("Server bundle must not depend on runtime packages");
  }
}

if (args.length) {
  const target = path.resolve(args[1]);
  const relative = path.relative(root, target);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("Stage directory must be outside the plugin source directory");
  }
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length !== 0) throw new Error("Stage directory must be empty");
  for (const file of pkg.files) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(target, file));
  }
  console.log(
    "GenImage runtime staged: bundled server, installed UI, and plugin manifest; no runtime dependencies.",
  );
} else {
  console.log(
    "GenImage server bundled. Installation requires dist/server.mjs and ui/canvas.html alongside the plugin manifest.",
  );
}
