import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * 无计费示例画布的 stdio MCP 服务：
 * - 唯一工具 `open_canvas` 只回传可编辑 brief，不创建生成任务；
 * - 唯一资源 `ui://genimage/canvas.html` 返回随插件发布的自包含画布页；
 * - stdout 专用于协议，不写日志；本服务不联网、不落盘、不保存任何状态。
 */

const RESOURCE_URI = "ui://genimage/canvas.html";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const SERVER_NAME = "genimage";
const SERVER_VERSION = "0.1.1";
/** JSON Schema 的字符串长度按 Unicode 码点计；代理平面字符不能按 UTF-16 长度误拒。 */
const BRIEF_MAX_CODE_POINTS = 2000;
/** server.mjs 与 canvas.html 同在插件 dist/ 目录；产物不允许依赖源码树或 node_modules。 */
const CANVAS_URL = new URL("./canvas.html", import.meta.url);

const OPEN_CANVAS_RESULT_TEXT =
  "GenImage development canvas is ready. The brief is an editable draft; no image was generated or saved.";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "open_canvas",
      title: "Open GenImage canvas",
      description:
        "Open the GenImage development canvas with an optional editable brief. This scaffold does not generate images, contact providers, or save data.",
      inputSchema: {
        type: "object",
        properties: {
          brief: {
            type: "string",
            maxLength: BRIEF_MAX_CODE_POINTS,
            description: `Optional plain-text draft, at most ${BRIEF_MAX_CODE_POINTS.toLocaleString("en-US")} Unicode code points. Opening never generates an image.`,
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, surface: "canvas", visibility: ["model"] } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== "open_canvas") {
    throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
  }
  const args = params.arguments ?? {};
  if (
    Object.keys(args).some((key) => key !== "brief") ||
    (args.brief !== undefined &&
      (typeof args.brief !== "string" || Array.from(args.brief).length > BRIEF_MAX_CODE_POINTS))
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Expected only an optional brief of at most ${BRIEF_MAX_CODE_POINTS.toLocaleString("en-US")} Unicode code points`,
    );
  }
  return {
    content: [{ type: "text", text: OPEN_CANVAS_RESULT_TEXT }],
    structuredContent: { brief: args.brief ?? "" },
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: RESOURCE_URI,
      name: "genimage-canvas",
      title: "GenImage canvas",
      mimeType: RESOURCE_MIME_TYPE,
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  if (params.uri !== RESOURCE_URI) {
    throw new McpError(-32002, "Unknown resource");
  }
  let text: string;
  try {
    text = await readFile(CANVAS_URL, "utf8");
  } catch {
    // 画布缺失是安装产物损坏：返回有界错误，不泄漏本地路径或堆栈。
    throw new McpError(ErrorCode.InternalError, "Canvas resource is unavailable");
  }
  return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text }] };
});

await server.connect(new StdioServerTransport());
