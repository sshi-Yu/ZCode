import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, type LookupFunction } from "node:net";
import { Agent, fetch, type Dispatcher } from "undici";
import type { ImageModelInput } from "../specialized-model-settings/contract.js";
import { decodeGeneratedImage } from "./image.js";

export type ExecutableImageModel = ImageModelInput & {
  id: string;
  generationUrl: string;
  apiKey: string;
};

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

export function buildImageGenerationBody(model: ExecutableImageModel, prompt: string) {
  return {
    model: model.modelId,
    prompt,
    n: 1,
    ...(model.size ? { size: model.size } : {}),
    ...(model.quality ? { quality: model.quality } : {}),
    ...(model.protocol === "base64" ? { response_format: "b64_json" } : {}),
  };
}

interface ImageTransport {
  resolveAddresses?: (hostname: string) => Promise<LookupAddress[]>;
  createDispatcher?: (lookup: LookupFunction) => Dispatcher;
  timeoutMs?: number;
}

export async function generateRemoteImage(
  model: ExecutableImageModel,
  prompt: string,
  transport: ImageTransport = {},
) {
  const signal = AbortSignal.timeout(transport.timeoutMs ?? 120_000);
  let url: URL;
  try {
    url = new URL(model.generationUrl);
  } catch {
    throw new Error("genimage.destination-unavailable");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  )
    throw new Error("genimage.destination-unavailable");
  const addresses = await Promise.race([
    (
      transport.resolveAddresses ??
      ((hostname: string) => lookup(hostname, { all: true, verbatim: true }))
    )(hostname),
    new Promise<never>((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("genimage.destination-unavailable")),
        { once: true },
      ),
    ),
  ]).catch(() => {
    throw new Error("genimage.destination-unavailable");
  });
  if (
    signal.aborted ||
    !addresses.length ||
    addresses.some(({ address, family }) => blocked.check(address, family === 6 ? "ipv6" : "ipv4"))
  )
    throw new Error("genimage.destination-unavailable");
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
  const dispatcher =
    transport.createDispatcher?.(pinnedLookup) ?? new Agent({ connect: { lookup: pinnedLookup } });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(buildImageGenerationBody(model, prompt)),
      dispatcher,
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? "genimage.authentication"
          : response.status === 429
            ? "genimage.quota"
            : response.status >= 400 && response.status < 500
              ? "genimage.rejected"
              : "genimage.result-unknown",
      );
    }
    const limit = 24 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit || !response.body)
      throw new Error("genimage.response-invalid");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("genimage.response-invalid");
      chunks.push(Buffer.from(chunk));
    }
    let encoded: string;
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        data?: Array<{ b64_json?: unknown }>;
      };
      if (
        !Array.isArray(result.data) ||
        result.data.length !== 1 ||
        typeof result.data[0]?.b64_json !== "string"
      )
        throw new Error();
      encoded = result.data[0].b64_json;
    } catch {
      throw new Error("genimage.response-invalid");
    }
    return await decodeGeneratedImage(encoded);
  } catch (error) {
    if (
      error instanceof Error &&
      /^genimage\.(authentication|quota|rejected|response-invalid|result-unknown)$/.test(
        error.message,
      )
    )
      throw error;
    throw new Error("genimage.result-unknown");
  } finally {
    await Promise.resolve()
      .then(() => dispatcher.destroy())
      .catch(() => undefined);
  }
}
