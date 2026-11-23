import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.GENIMAGE_DEV_PORT ?? "4786");
const canvas = new URL("../ui/canvas.html", import.meta.url);

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new RangeError("GENIMAGE_DEV_PORT must be an integer from 0 to 65535.");
}

await readFile(canvas);

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const address = server.address();
  if (
    typeof address !== "object" ||
    !address ||
    request.headers.host !== `${host}:${address.port}`
  ) {
    response.writeHead(421).end("Use the loopback address published at startup.");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ service: "genimage", mode: "fixture" }));
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    const html = await readFile(canvas);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(html);
  } catch {
    response.writeHead(503).end("Canvas source is not available.");
  }
});

server.listen(port, host, () => {
  process.stdout.write(`GenImage fixture preview: http://${host}:${server.address().port}/\n`);
});
