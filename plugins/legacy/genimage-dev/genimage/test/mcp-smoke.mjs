import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const resourceUri = "ui://genimage/canvas.html";
const mimeType = "text/html;profile=mcp-app";
const stage = await mkdtemp(path.join(tmpdir(), "genimage-mcp-smoke-"));

async function expectInvalid(operation) {
  await assert.rejects(
    operation,
    (error) => error instanceof McpError && error.code === ErrorCode.InvalidParams,
  );
}

async function checkServer(serverPath, expectedHtml, cwd) {
  const client = new Client({ name: "genimage-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    stderr: "pipe",
  });
  const protocolErrors = [];
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  client.onerror = (error) => protocolErrors.push(error);
  try {
    await client.connect(transport, { timeout: 10000 });
    assert.equal(client.getServerVersion().name, "genimage");
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
    assert.deepEqual(
      missing.structuredContent,
      { brief: "" },
      "Omitting optional input must be supported",
    );
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
    assert.deepEqual(
      afterInvalid.structuredContent,
      { brief: "" },
      "Calls must not persist drafts",
    );

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
    assert.deepEqual(protocolErrors, [], "stdout must contain MCP protocol only");
    assert.equal(stderr, "", "Healthy stdio service must be silent on stderr");
  } finally {
    await client.close();
  }
}

try {
  await access(path.join(root, "dist/server.mjs"));
  const html = await readFile(path.join(root, "ui/canvas.html"), "utf8");
  assert.match(html, /<!doctype html>/i);
  await checkServer(path.join(root, "dist/server.mjs"), html, stage);

  // Install snapshots must not need the source tree, node_modules, a compiler, or the caller's cwd.
  const artifact = path.join(stage, "artifact");
  await execFileAsync(
    process.execPath,
    [path.join(root, "scripts/build.mjs"), "--stage", artifact],
    { cwd: stage },
  );
  await access(path.join(artifact, ".zcode-plugin/plugin.json"));
  assert.deepEqual((await readdir(artifact)).sort(), [".zcode-plugin", "dist", "ui"]);
  const workspace = path.join(stage, "empty-workspace");
  await mkdir(workspace);
  await checkServer(path.join(artifact, "dist/server.mjs"), html, workspace);
  assert.deepEqual(await readdir(workspace), [], "MCP calls must never write into the workspace");

  // A missing installed UI is a bounded protocol error, not a stack trace or leaked local path.
  const broken = path.join(stage, "broken/dist");
  await mkdir(broken, { recursive: true });
  await copyFile(path.join(root, "dist/server.mjs"), path.join(broken, "server.mjs"));
  const client = new Client({ name: "genimage-missing-ui", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(broken, "server.mjs")],
    cwd: workspace,
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
  console.log(
    "GenImage MCP smoke passed: initialize/list/call/resources, Unicode validation, isolated runtime stage, and missing UI.",
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
