import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

async function requireEntry(pluginDir, name) {
  const normalized = typeof name === "string" ? name.replace(/^\.\//, "") : "";
  const path = resolve(pluginDir, normalized);
  const child = relative(pluginDir, path);
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized.includes("\\") ||
    !child ||
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    !(await stat(path).catch(() => null))?.isFile()
  ) {
    throw new Error(`Missing or invalid plugin entry: ${String(name)}`);
  }
}

async function validateFiles(root, atRoot = true) {
  const files = await readdir(root, { withFileTypes: true });
  for (const file of files) {
    const path = join(root, file.name);
    if (
      file.isSymbolicLink() ||
      (atRoot && ![".zcode-plugin", "dist"].includes(file.name)) ||
      ["node_modules", "src", "test", ".git"].includes(file.name) ||
      (!file.isDirectory() &&
        !(file.isFile() && /\.(?:mjs|html|json|png|jpe?g|webp|svg|woff2?)$/i.test(file.name)))
    ) {
      throw new Error(`Unexpected installation file: ${file.name}`);
    }
    if (file.isDirectory()) await validateFiles(path, false);
  }
}

async function hasSameFiles(prepared, target) {
  const [staged, published] = await Promise.all([
    readdir(prepared, { withFileTypes: true }),
    readdir(target, { withFileTypes: true }),
  ]);
  if (staged.length !== published.length) return false;
  const byName = new Map(published.map((entry) => [entry.name, entry]));
  for (const entry of staged) {
    const prior = byName.get(entry.name);
    const from = join(prepared, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory() && prior?.isDirectory()) {
      if (!(await hasSameFiles(from, to))) return false;
    } else if (entry.isFile() && prior?.isFile()) {
      const [left, right] = await Promise.all([readFile(from), readFile(to)]);
      if (!left.equals(right)) return false;
    } else {
      return false;
    }
  }
  return true;
}

export async function publishMarket({ appRoot, build }) {
  const manifestPath = join(appRoot, "manifest/plugin.json");
  const catalogPath = join(appRoot, "manifest/marketplace.json");
  const [manifestText, catalogText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(catalogPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const catalog = JSON.parse(catalogText);
  const entry = catalog.plugins?.[0];
  if (
    !/^[a-z][a-z0-9-]*$/.test(manifest.name) ||
    !/^[a-z][a-z0-9-]*$/.test(catalog.name) ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    catalog.plugins?.length !== 1 ||
    entry?.source !== `./${manifest.name}` ||
    entry.name !== manifest.name ||
    entry.version !== manifest.version
  ) {
    throw new Error("Plugin manifest and market must agree on name, version, and relative source");
  }
  const output = join(appRoot, "dist");
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(join(output, ".market-"));
  const prepared = join(staging, "market");
  const previous = join(staging, "previous");
  const target = join(output, "market");
  const pluginDir = join(prepared, manifest.name);
  let cleanup = true;
  try {
    const metadata = join(pluginDir, ".zcode-plugin");
    await mkdir(metadata, { recursive: true });
    await copyFile(manifestPath, join(metadata, "plugin.json"), constants.COPYFILE_EXCL);
    await copyFile(catalogPath, join(prepared, "marketplace.json"), constants.COPYFILE_EXCL);
    await build(pluginDir);
    if (manifest.extension) await requireEntry(pluginDir, manifest.extension.main);
    for (const server of Object.values(manifest.mcpServers ?? {})) {
      const prefix = "${ZCODE_PLUGIN_ROOT}/";
      const script = server.args?.[0];
      if (server.command !== "node" || typeof script !== "string" || !script.startsWith(prefix)) {
        throw new Error("Expected a bundled Node MCP entry under ZCODE_PLUGIN_ROOT");
      }
      await requireEntry(pluginDir, script.slice(prefix.length));
    }
    if (!manifest.extension && !manifest.mcpServers) throw new Error("Plugin entry is missing");
    await validateFiles(pluginDir);
    const published = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    // Windows 上重复替换完整目录可能报 EPERM；字节未变化时无需触碰已发布目录。
    if (published?.isDirectory() && (await hasSameFiles(prepared, target))) return target;
    let backedUp = false;
    try {
      await rename(target, previous);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(prepared, target);
    } catch (error) {
      if (backedUp) {
        cleanup = false;
        await rename(previous, target);
        cleanup = true;
      }
      throw error;
    }
    return target;
  } finally {
    if (cleanup) await rm(staging, { recursive: true, force: true });
  }
}
