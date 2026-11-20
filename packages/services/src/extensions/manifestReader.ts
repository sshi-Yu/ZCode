import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLUGIN_MANIFEST_CANDIDATES,
  resolvePluginManifest,
  type PluginManifestRead,
} from "@zcode/shared/extension-host";
import type { IPluginManagementService } from "#src/plugins/pluginManagement.js";

// 读插件的 plugin.json（docs/plugins/extension-host.md §16.1）：异步 IO，只在 Window Host 运行。
// 校验与静态表生成在协议模块的纯函数 resolvePluginManifest 里，这里只负责找到并解析 JSON。

/** 启用确认只看本机用户清单里真正带可执行扩展代码的插件。 */
export async function hasUserExtensionCode(
  plugins: Pick<IPluginManagementService, "listPlugins">,
  workspacePath: string,
  pluginId: string,
): Promise<boolean> {
  const result = await plugins.listPlugins({ workspacePath, configScope: "user" });
  const plugin = result.plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin || plugin.packageStatus === "missing") return false;
  const { entry } = resolvePluginManifest(
    { pluginId, name: plugin.name, rootPath: plugin.rootPath },
    await readPluginManifest(plugin.rootPath),
  );
  return entry.extension?.state === "ok" && Boolean(entry.extension.main);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 按 CLI 的清单目录优先级找第一个存在的 plugin.json；都不存在时为 missing。 */
export async function readPluginManifest(rootPath: string): Promise<PluginManifestRead> {
  for (const segments of PLUGIN_MANIFEST_CANDIDATES) {
    const path = segments.join("/");
    let text: string;
    try {
      text = await readFile(join(rootPath, ...segments), "utf8");
    } catch (error) {
      if (isMissing(error)) continue;
      return { status: "unreadable", path, reason: describe(error) };
    }
    try {
      return { status: "ok", manifest: JSON.parse(text) as unknown };
    } catch (error) {
      return { status: "unreadable", path, reason: `invalid JSON: ${describe(error)}` };
    }
  }
  return { status: "missing" };
}
