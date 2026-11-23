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

const resourceUri = "ui://genimage/canvas.html";
const mimeType = "text/html;profile=mcp-app";
const canvasUrl = new URL("../ui/canvas.html", import.meta.url);
const server = new Server(
  { name: "genimage", version: "0.1.0" },
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
            maxLength: 2000,
            description:
              "Optional plain-text draft, at most 2,000 Unicode code points. Opening never generates an image.",
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
      _meta: { ui: { resourceUri, surface: "canvas", visibility: ["model"] } },
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
      (typeof args.brief !== "string" || Array.from(args.brief).length > 2000))
  ) {
    // JSON Schema 的长度按 Unicode 码点定义；不能用 UTF-16 length 错拒合法的补充平面字符。
    throw new McpError(
      ErrorCode.InvalidParams,
      "Expected only an optional brief of at most 2,000 Unicode code points",
    );
  }
  return {
    content: [
      {
        type: "text",
        text: "GenImage development canvas is ready. The brief is an editable draft; no image was generated or saved.",
      },
    ],
    structuredContent: { brief: args.brief ?? "" },
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: resourceUri, name: "genimage-canvas", title: "GenImage canvas", mimeType }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  if (params.uri !== resourceUri) {
    throw new McpError(-32002, "Unknown resource");
  }
  let text;
  try {
    text = await readFile(canvasUrl, "utf8");
  } catch {
    throw new McpError(ErrorCode.InternalError, "Canvas resource is unavailable");
  }
  return { contents: [{ uri: resourceUri, mimeType, text }] };
});

// stdout 专用于 SDK stdio 协议；不记录请求、草稿、环境变量或本地路径。
await server.connect(new StdioServerTransport());
