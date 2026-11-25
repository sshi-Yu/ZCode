import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ImageGenerationParameters,
  ImageGenerationProtocol,
  ImageGenerationSaveConnectionInput,
  ImageGenerationTestSample,
} from "./contract.js";
import { ImageGenerationError, invalidInput, parseInput } from "./validation.js";

export const OFFICIAL_CONNECTION_ID = "openai-official";
export const OFFICIAL_MODEL_KEY = "gpt-image-1";
export const testSample: ImageGenerationTestSample = {
  version: "image-generation-neutral-v1",
  prompt: "A small blue ceramic teapot on a plain white table, soft studio lighting.",
  parameters: {},
};
export const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const parametersSchema = z.strictObject({
  size: z.enum(["1024x1024", "1024x1536", "1536x1024", "2048x2048"]).optional(),
  quality: z.enum(["low", "medium", "high"]).optional(),
  background: z.enum(["auto", "transparent", "opaque"]).optional(),
});
const modelSchema = z.strictObject({
  modelKey: identifierSchema,
  modelId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[\x21-\x7e]+$/),
  name: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  parameters: parametersSchema,
});
export const selectionSchema = z.strictObject({
  connectionId: identifierSchema,
  modelKey: identifierSchema,
});
export const defaultInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
  selection: selectionSchema.nullable(),
});
export const saveConnectionSchema = z.strictObject({
  connectionId: identifierSchema.optional(),
  expectedRevision: revisionSchema.nullable(),
  name: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
  protocol: z.enum(["openai-images", "openai-images-b64"]),
  baseUrl: z.string().trim().min(1).max(2048),
  generationPath: z.string().min(1).max(512),
  probePath: z.string().min(1).max(512).nullable(),
  auth: z.literal("bearer"),
  credential: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("keep") }),
    z.strictObject({ action: z.literal("remove") }),
    z.strictObject({ action: z.literal("replace"), apiKey: z.string().trim().min(1).max(4096) }),
  ]),
  models: z.array(modelSchema).max(64),
  defaultSelection: defaultInputSchema.optional(),
});
export const deleteConnectionSchema = z.strictObject({
  connectionId: identifierSchema,
  expectedRevision: revisionSchema,
  defaultSelection: defaultInputSchema.optional(),
});
export const generationSchema = z.strictObject({
  requestId: identifierSchema,
  connectionId: identifierSchema,
  modelKey: identifierSchema,
  revision: revisionSchema,
  purpose: z.enum(["generation", "test"]),
  prompt: z.string().trim().min(1).max(4000).optional(),
  parameters: parametersSchema.optional(),
  sampleVersion: z.string().max(128).optional(),
});
export const probeSchema = z.strictObject({
  connectionId: identifierSchema,
  revision: revisionSchema,
  modelKey: identifierSchema.optional(),
});
export const historySchema = z.strictObject({
  cursor: z.string().max(1024).optional(),
  purpose: z.enum(["generation", "test"]).optional(),
});
export const requestSchema = z.strictObject({ requestId: identifierSchema });

function normalizePath(raw: string): string {
  // URL 解析会消解点段；先拒绝歧义路径，保证预览接收方与实际请求完全一致。
  if (
    !/^\/[A-Za-z0-9_./~-]+$/.test(raw) ||
    raw.includes("//") ||
    raw.split("/").some((part) => part === "." || part === "..")
  )
    invalidInput();
  return raw;
}
export function normalizeDestination(input: ImageGenerationSaveConnectionInput, fixture?: string) {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return invalidInput();
  }
  const fixtureOrigin = fixture ? new URL(fixture).origin : undefined;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && url.origin !== fixtureOrigin) ||
    !/^https?:\/\/[^/?#]+(?:\/[A-Za-z0-9_./~-]*)?$/.test(input.baseUrl) ||
    /[\s%]/.test(input.baseUrl) ||
    input.baseUrl.includes("\\") ||
    url.pathname.includes("//") ||
    input.baseUrl.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ImageGenerationError("Image destination is not allowed.", "destination_blocked");
  }
  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const generationPath = normalizePath(input.generationPath);
  const probePath = input.probePath === null ? null : normalizePath(input.probePath);
  return {
    baseUrl,
    generationPath,
    probePath,
    generationUrl: baseUrl + generationPath,
    probeUrl: probePath ? baseUrl + probePath : null,
  };
}
export function destinationFingerprint(input: {
  baseUrl: string;
  generationPath: string;
  probePath: string | null;
  protocol: string;
  auth: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.baseUrl,
        input.generationPath,
        input.probePath,
        input.protocol,
        input.auth,
      ]),
    )
    .digest("hex");
}
export function validateProtocolParameters(
  protocol: ImageGenerationProtocol,
  parameters: ImageGenerationParameters,
): void {
  // FrostFox 文档只接受 Base64 请求白名单；保存及受理均校验，防止未知字段造成付费请求被拒绝。
  if (protocol === "openai-images-b64") {
    if (
      parameters.background !== undefined ||
      (parameters.size !== undefined &&
        parameters.size !== "1024x1024" &&
        parameters.size !== "2048x2048")
    )
      invalidInput();
  } else if (protocol !== "openai-images" || parameters.size === "2048x2048") invalidInput();
}
export function normalizeConnection(raw: unknown, fixture?: string) {
  const input = parseInput(saveConnectionSchema, raw);
  for (const model of input.models) validateProtocolParameters(input.protocol, model.parameters);
  if (
    new Set(input.models.map((model) => model.modelKey)).size !== input.models.length ||
    new Set(input.models.map((model) => model.modelId)).size !== input.models.length
  )
    invalidInput();
  return { ...input, ...normalizeDestination(input, fixture) };
}
export function stableParameters(
  parameters: import("./contract.js").ImageGenerationParameters,
): string {
  return JSON.stringify({
    ...(parameters.size ? { size: parameters.size } : {}),
    ...(parameters.quality ? { quality: parameters.quality } : {}),
    ...(parameters.background ? { background: parameters.background } : {}),
  });
}
