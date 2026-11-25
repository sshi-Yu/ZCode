import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const IMAGE_GENERATION_FIXTURE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAI0lEQVR4AYXBAQEAMAiAME6394+kDWR7/BkOEiRIkCBBgoQFVvsCUyvaXNIAAAAASUVORK5CYII=";
export interface ImageGenerationFixtureRequest {
  method: string;
  path: string;
  body: unknown;
  /** Only synthetic fixture credentials belong here; never print this value. */
  authorization: string | undefined;
}
export type ImageGenerationFixtureReply =
  | { status: number; json: unknown }
  | { disconnect: true }
  | { redirect: string };

/** A controlled loopback provider for normal Desktop Host RPC acceptance, never a real request. */
export async function createImageGenerationV2Fixture(port = 0): Promise<{
  baseUrl: string;
  endpoint: string;
  requests: ImageGenerationFixtureRequest[];
  enqueue(path: string, reply: ImageGenerationFixtureReply): void;
  hold(path: string): { entered: Promise<void>; release(reply: ImageGenerationFixtureReply): void };
  close(): Promise<void>;
}> {
  const requests: ImageGenerationFixtureRequest[] = [];
  const replies = new Map<
    string,
    Array<{ result: Promise<ImageGenerationFixtureReply>; enter?: () => void }>
  >();
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 32 * 1024) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(bytes);
    }
    const path = request.url ?? "";
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method ?? "",
      path,
      body: raw ? JSON.parse(raw) : null,
      authorization: request.headers.authorization,
    });
    const next = replies.get(path)?.shift();
    next?.enter?.();
    const reply = await (next?.result ??
      Promise.resolve(
        path.endsWith("/models")
          ? { status: 200, json: { data: [{ id: "gpt-image-1" }] } }
          : { status: 200, json: { data: [{ b64_json: IMAGE_GENERATION_FIXTURE_PNG }] } },
      ));
    if ("disconnect" in reply) {
      request.socket.destroy();
    } else if ("redirect" in reply) {
      response.writeHead(302, { location: reply.redirect });
      response.end();
    } else {
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.json));
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  function enqueue(path: string, result: Promise<ImageGenerationFixtureReply>, enter?: () => void) {
    const queue = replies.get(path) ?? [];
    queue.push({ result, enter });
    replies.set(path, queue);
  }
  return {
    baseUrl,
    endpoint: `${baseUrl}/v1/images/generations`,
    requests,
    enqueue: (path, reply) => enqueue(path, Promise.resolve(reply)),
    hold(path) {
      let signalEntered!: () => void;
      let release!: (reply: ImageGenerationFixtureReply) => void;
      const entry = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      enqueue(
        path,
        new Promise((resolve) => {
          release = resolve;
        }),
        signalEntered,
      );
      return { entered: entry, release };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
