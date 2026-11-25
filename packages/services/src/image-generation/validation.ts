import { crc32 } from "node:zlib";
import { z } from "zod";
import type { ImageGenerationErrorCode } from "./contract.js";

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 128 * 1024;
export const MAX_RESPONSE_BYTES = 23 * 1024 * 1024;
export const GENERATION_TIMEOUT_MS = 120_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class ImageGenerationError extends Error {
  constructor(
    message: string,
    readonly code: ImageGenerationErrorCode = "invalid_input",
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export function invalidInput(): never {
  throw new ImageGenerationError("Invalid image generation input.");
}

export const assetSchema = z.strictObject({ assetId: z.string().uuid() });

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalidInput();
  return result.data;
}

export function validateCredential(key: unknown): string {
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key)) invalidInput();
  return key;
}

/** Validate allocation bounds before the injected PNG decoder ever sees the bytes. */
export function validatePng(bytes: Uint8Array, preview = false): void {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxBytes = preview ? MAX_PREVIEW_BYTES : MAX_IMAGE_BYTES;
  const maxEdge = preview ? 384 : 2048;
  if (png.length < 57 || png.length > maxBytes || !png.subarray(0, 8).equals(pngSignature)) {
    invalidInput();
  }
  let offset = 8;
  let chunks = 0;
  let sawData = false;
  let endedData = false;
  while (offset + 12 <= png.length) {
    if (++chunks > 4096) invalidInput();
    const length = png.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > png.length) invalidInput();
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(kind)) invalidInput();
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) invalidInput();
    if (chunks === 1) {
      if (kind !== "IHDR" || length !== 13) invalidInput();
      const width = png.readUInt32BE(offset + 8);
      const height = png.readUInt32BE(offset + 12);
      const depth = png[offset + 16];
      const color = png[offset + 17];
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !width ||
        !height ||
        width > maxEdge ||
        height > maxEdge ||
        width * height > 4_194_304 ||
        !validDepths[color!]?.includes(depth!) ||
        png[offset + 18] !== 0 ||
        png[offset + 19] !== 0 ||
        png[offset + 20]! > 1
      ) {
        invalidInput();
      }
    } else if (kind === "IHDR") invalidInput();
    if (kind === "IDAT") {
      if (endedData) invalidInput();
      sawData = true;
    } else if (sawData) endedData = true;
    if (kind === "IEND") {
      if (length !== 0 || !sawData || end !== png.length) invalidInput();
      return;
    }
    // APNG/unknown critical chunks are outside the single static PNG contract.
    if (
      ["acTL", "fcTL", "fdAT"].includes(kind) ||
      (!/[a-z]/.test(kind[0]!) && !["IHDR", "PLTE", "IDAT"].includes(kind))
    )
      invalidInput();
    offset = end;
  }
  invalidInput();
}

export function decodeImageResponse(value: unknown): Uint8Array {
  const parsed = z.object({ data: z.tuple([z.object({ b64_json: z.string() })]) }).safeParse(value);
  if (!parsed.success) invalidInput();
  const encoded = parsed.data.data[0].b64_json;
  if (
    !encoded ||
    encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    invalidInput();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) invalidInput();
  validatePng(bytes);
  return bytes;
}

export function resolveEndpoint(fixture?: {
  endpoint: string;
  mode: "development" | "test";
}): string {
  if (!fixture) return "https://api.openai.com/v1/images/generations";
  if (!["development", "test"].includes(fixture.mode) || process.env.NODE_ENV === "production")
    invalidInput();
  let url: URL;
  try {
    url = new URL(fixture.endpoint);
  } catch {
    return invalidInput();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalidInput();
  return url.href;
}

export async function readResponseJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  if (!response.body) invalidInput();
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel();
    invalidInput();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) invalidInput();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Cover preparation/body work that cannot itself be interrupted; it must still check the signal before sending. */
export async function withinDeadline<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = () =>
      reject(new ImageGenerationError("Image operation deadline exceeded.", "network_error"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([deadline, run()]);
  } finally {
    if (cancel) signal.removeEventListener("abort", cancel);
  }
}
