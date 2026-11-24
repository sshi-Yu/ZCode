import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * 对脱离源码树的产物做 stdio MCP 冒烟：initialize/list/call/resources、Unicode 校验、
 * 缺资源错误、以及“运行不写工作区、不依赖源码目录或 node_modules”的安装边界。
 */

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const resourceUri = "ui://genimage/canvas.html";
const marketRoot = process.env.GENIMAGE_MARKET_DIR ? path.resolve(process.env.GENIMAGE_MARKET_DIR) : path.join(appRoot, "dist/market");
const mimeType = "text/html;profile=mcp-app";

async function expectInvalid(operation) {
  await assert.rejects(operation, (error) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
}

/** 连接 stdio 服务并收集协议错误与 stderr；断言放在各用例末尾经 closeWithChecks 完成。 */
async function connectServer(serverPath, cwd, name = "genimage-smoke") {
  const client = new Client({ name, version: "0.1.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    stderr: "pipe",
  });
  const protocolErrors = [];
  const stderrChunks = [];
  transport.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
  client.onerror = (error) => protocolErrors.push(error);
  await client.connect(transport, { timeout: 10000 });
  const closeWithChecks = async () => {
    await client.close();
    assert.deepEqual(protocolErrors, [], "stdout must contain MCP protocol only");
    assert.equal(stderrChunks.join(""), "", "Healthy stdio service must be silent on stderr");
  };
  return { client, closeWithChecks };
}

async function checkServer(serverPath, expectedHtml, cwd) {
  const { client, closeWithChecks } = await connectServer(serverPath, cwd);
  try {
    assert.equal(client.getServerVersion().name, "genimage");
    assert.equal(client.getServerVersion().version, "0.1.1");
    assert.ok(client.getServerCapabilities().tools);
    assert.ok(client.getServerCapabilities().resources);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 1, "Only the side-effect-free opener may be registered");
    const [tool] = tools;
    assert.equal(tool.name, "open_canvas");
    assert.equal(tool.title, "Open GenImage canvas");
    assert.deepEqual(tool._meta.ui, { resourceUri, surface: "canvas", visibility: ["model"] });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ["brief"]);
    assert.equal(tool.inputSchema.properties.brief.type, "string");
    assert.equal(tool.inputSchema.properties.brief.maxLength, 2000);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);

    for (const brief of ["画一片森林 / a forest", "", "😀".repeat(2000)]) {
      const result = await client.callTool({ name: "open_canvas", arguments: { brief } });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.structuredContent, { brief });
      assert.ok(result.content.some((item) => item.type === "text"));
    }
    const empty = await client.callTool({ name: "open_canvas", arguments: {} });
    assert.deepEqual(empty.structuredContent, { brief: "" });
    const missing = await client.request(
      { method: "tools/call", params: { name: "open_canvas" } },
      CallToolResultSchema,
    );
    assert.deepEqual(missing.structuredContent, { brief: "" }, "Omitting optional input must be supported");
    for (const args of [
      { brief: "a".repeat(2001) },
      { brief: "😀".repeat(2001) },
      { brief: 1 },
      { brief: null },
      { workspacePath: "../escape" },
    ]) {
      await expectInvalid(() => client.callTool({ name: "open_canvas", arguments: args }));
    }
    await expectInvalid(() => client.callTool({ name: "start_generation", arguments: {} }));
    const afterInvalid = await client.callTool({ name: "open_canvas", arguments: {} });
    assert.deepEqual(afterInvalid.structuredContent, { brief: "" }, "Calls must not persist drafts");

    const { resources } = await client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, resourceUri);
    assert.equal(resources[0].mimeType, mimeType);
    const { contents } = await client.readResource({ uri: resourceUri });
    assert.deepEqual(
      contents.map(({ uri, mimeType: type, text }) => ({ uri, mimeType: type, text })),
      [{ uri: resourceUri, mimeType, text: expectedHtml }],
    );
    await assert.rejects(
      () => client.readResource({ uri: "file:///etc/passwd" }),
      (error) => error instanceof McpError && error.code === -32002,
    );
  } finally {
    await closeWithChecks();
  }
}

await test("installed runtime serves canvas and validates brief without touching the workspace", async () => {
  const stage = await mkdtemp(path.join(tmpdir(), "genimage-mcp-smoke-"));
  try {
    const sourceServer = path.join(appRoot, "dist/server.mjs");
    const html = await readFile(path.join(appRoot, "dist/canvas.html"), "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.ok(html.length > 1000, "canvas.html must be a self-contained page, not a stub");

    // 安装快照只含 manifest + dist：不得依赖源码树、node_modules 或调用方 cwd。
    const artifact = path.join(stage, "artifact");
    await mkdir(path.join(artifact, ".zcode-plugin"), { recursive: true });
    await mkdir(path.join(artifact, "dist"), { recursive: true });
    await copyFile(path.join(appRoot, "manifest/plugin.json"), path.join(artifact, ".zcode-plugin/plugin.json"));
    await copyFile(sourceServer, path.join(artifact, "dist/server.mjs"));
    await copyFile(path.join(appRoot, "dist/canvas.html"), path.join(artifact, "dist/canvas.html"));
    const workspace = path.join(stage, "empty-workspace");
    await mkdir(workspace);
    await checkServer(path.join(artifact, "dist/server.mjs"), html, workspace);
    assert.deepEqual(await readdir(workspace), [], "MCP calls must never write into the workspace");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

await test("a missing installed canvas is a bounded protocol error without leaking local paths", async () => {
  const stage = await mkdtemp(path.join(tmpdir(), "genimage-missing-ui-"));
  try {
    const broken = path.join(stage, "broken/dist");
    await mkdir(broken, { recursive: true });
    await copyFile(path.join(appRoot, "dist/server.mjs"), path.join(broken, "server.mjs"));
    const client = new Client({ name: "genimage-missing-ui", version: "0.1.1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(broken, "server.mjs")],
      stderr: "pipe",
    });
    try {
      await client.connect(transport, { timeout: 10000 });
      await assert.rejects(
        () => client.readResource({ uri: resourceUri }),
        (error) =>
          error instanceof McpError &&
          error.code === ErrorCode.InternalError &&
          error.message.includes("Canvas resource is unavailable") &&
          !error.message.includes(stage),
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

await test("published market snapshot carries manifest, listing, and runtime files", async () => {
  const market = marketRoot;
  const manifestText = await readFile(path.join(market, "marketplace.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.name, "genimage-local");
  assert.equal(manifest.plugins.length, 1);
  const [entry] = manifest.plugins;
  assert.equal(entry.name, "genimage");
  assert.equal(entry.version, "0.1.1");
  assert.equal(entry.source, "./genimage");
  const plugin = JSON.parse(await readFile(path.join(market, "genimage/.zcode-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.version, entry.version);
  assert.equal(plugin.mcpServers.genimage.command, "node");
  assert.equal(plugin.mcpServers.genimage.args[0], "${ZCODE_PLUGIN_ROOT}/dist/server.mjs");
  // 先验证安装内容，避免旧市场 HTML 与新 runtime 不同掩盖缺失的扩展入口。
  assert.deepEqual((await readdir(path.join(market, "genimage/dist"))).sort(), ["canvas.html", "extension.mjs", "server.mjs"]);
  const html = await readFile(path.join(appRoot, "dist/canvas.html"), "utf8");
  const workspace = await mkdtemp(path.join(tmpdir(), "genimage-market-run-"));
  try {
    await checkServer(path.join(market, "genimage/dist/server.mjs"), html, workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
  // 产物不得夹带开发文件；清单内也不承诺源码树里没有的能力。
  const runtimeFiles = (await readdir(path.join(market, "genimage"))).sort();
  assert.deepEqual(runtimeFiles, [".zcode-plugin", "dist"]);
  const distFiles = (await readdir(path.join(market, "genimage/dist"))).sort();
  assert.deepEqual(distFiles, ["canvas.html", "extension.mjs", "server.mjs"]);
});

await test("app workspace is declared and activates from the installed snapshot without source dependencies", async () => {
  const source = JSON.parse(await readFile(path.join(appRoot, "manifest/plugin.json"), "utf8"));
  assert.equal(source.extension?.main, "./dist/extension.mjs", "App view entry is missing from manifest");
  assert.deepEqual(source.extension.contributes.views, [{
    id: "workspace", title: { en: "GenImage", "zh-CN": "GenImage 生图画布" }, icon: "image", scope: "app",
  }]);
  const pluginDir = path.join(marketRoot, "genimage");
  const installed = JSON.parse(await readFile(path.join(pluginDir, ".zcode-plugin/plugin.json"), "utf8"));
  assert.deepEqual(installed, source);
  const { activate } = await import(pathToFileURL(path.join(pluginDir, "dist/extension.mjs")).href);
  const registered = [];
  activate({ views: { register: (id, definition) => registered.push({ id, definition }) } });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, "workspace");
  assert.deepEqual(registered[0].definition, { entry: "./dist/canvas.html" });
  assert.ok((await readFile(path.join(pluginDir, "dist/extension.mjs"), "utf8")).includes("activate"));
});

await test("server bundle stays offline: no network, provider, or generation surface", async () => {
  const bundle = await readFile(path.join(appRoot, "dist/server.mjs"), "utf8");
  // SDK 含协议文档 URL 与 HTTP transport 的通用 schema；字面量不是网络行为。
  // 此处只验证没有供应商/付费工具入口，真实请求次数由 browser-smoke 离线 CSP 场景取证。
  for (const banned of ["api.openai.com", "start_generation", "export_image"]) {
    assert.ok(!bundle.includes(banned), `server bundle must not contain ${banned}`);
  }
  assert.ok(bundle.includes('"open_canvas"'));
});

await test("canvas artifact is self-contained for the sandboxed host", async () => {
  const html = await readFile(path.join(appRoot, "dist/canvas.html"), "utf8");
  // 单文件产物：不引用外部脚本/样式/图片，也不发起网络请求。
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  assert.doesNotMatch(html, /<img[^>]+src=/i);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i);
  // 宿主首帧主题注入要求根 <html> 标签紧跟 doctype 前导区。
  assert.match(html, /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype html>\s*<html[\s>]/i);
  // 握手与画布骨架：官方 App SDK、teardown、fullscreen、brief 回填。
  assert.match(html, /ui\/initialize/);
  assert.match(html, /ui\/request-display-mode/);
});
