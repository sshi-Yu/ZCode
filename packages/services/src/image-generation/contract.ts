import { createServiceDescriptor } from "../descriptors.js";

export type ImageGenerationModelId = string;
export type ImageGenerationProtocol = "openai-images" | "openai-images-b64";
export type ImageGenerationStatus = "running" | "succeeded" | "failed" | "outcome_unknown";
export type ImageGenerationPurpose = "generation" | "test";
export type ImageGenerationErrorCode =
  | "invalid_input"
  | "revision_conflict"
  | "request_conflict"
  | "model_unavailable"
  | "credential_required"
  | "busy"
  | "destination_blocked"
  | "proxy_unsupported"
  | "authentication_failed"
  | "endpoint_unsupported"
  | "rate_limited"
  | "quota_exceeded"
  | "content_rejected"
  | "provider_rejected"
  | "network_error"
  | "invalid_output"
  | "storage_error"
  | "outcome_unknown"
  | "probe_unavailable"
  | "model_unverified"
  | "service_unavailable";

export interface ImageGenerationParameters {
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "2048x2048";
  quality?: "low" | "medium" | "high";
  background?: "auto" | "transparent" | "opaque";
}
export interface ImageGenerationModelConfig {
  modelKey: string;
  modelId: string;
  name: string;
  enabled: boolean;
  parameters: ImageGenerationParameters;
}
export interface ImageGenerationTestResult {
  operation: "probe" | "trial";
  revision: number;
  modelKey?: string;
  status: "succeeded" | "failed" | "unverified" | "outcome_unknown";
  durationMs: number;
  ranAt: number;
  code?: ImageGenerationErrorCode;
}
export interface ImageGenerationPublicConnection {
  connectionId: string;
  revision: number;
  name: string;
  enabled: boolean;
  protocol: ImageGenerationProtocol;
  baseUrl: string;
  generationPath: string;
  probePath: string | null;
  auth: "bearer";
  generationUrl: string;
  probeUrl: string | null;
  officialPreset: boolean;
  configured: boolean;
  models: ImageGenerationModelConfig[];
  lastProbe?: ImageGenerationTestResult;
  lastTrial?: ImageGenerationTestResult;
}
export interface ImageGenerationSelection {
  connectionId: string;
  modelKey: string;
}
export interface ImageGenerationDefaultSelection {
  revision: number;
  selection: ImageGenerationSelection | null;
}
export interface ImageGenerationTestSample {
  version: "image-generation-neutral-v1";
  prompt: string;
  /** Merge with model parameters; n=1 and the selected protocol's inline output format are fixed. */
  parameters: ImageGenerationParameters;
}
export interface ImageGenerationConfiguration {
  connections: ImageGenerationPublicConnection[];
  defaultSelection: ImageGenerationDefaultSelection;
  testSample: ImageGenerationTestSample;
}
export type ImageGenerationCredentialIntent =
  | { action: "keep" }
  | { action: "replace"; apiKey: string }
  | { action: "remove" };
export interface ImageGenerationSaveConnectionInput {
  connectionId?: string;
  expectedRevision: number | null;
  name: string;
  enabled: boolean;
  protocol: ImageGenerationProtocol;
  baseUrl: string;
  generationPath: string;
  probePath: string | null;
  auth: "bearer";
  credential: ImageGenerationCredentialIntent;
  models: ImageGenerationModelConfig[];
  defaultSelection?: { expectedRevision: number; selection: ImageGenerationSelection | null };
}
export interface ImageGenerationStartInput {
  requestId: string;
  connectionId: string;
  modelKey: string;
  revision: number;
  purpose: ImageGenerationPurpose;
  prompt?: string;
  parameters?: ImageGenerationParameters;
  sampleVersion?: string;
}
export interface ImageGenerationJob {
  id: string;
  prompt: string;
  modelId: ImageGenerationModelId;
  status: ImageGenerationStatus;
  /** Legacy v1 rows predate per-connection models and carry the frozen official identifiers. */
  connectionId: string;
  modelKey: string;
  revision?: number;
  purpose?: ImageGenerationPurpose;
  createdAt?: number;
  parameters?: ImageGenerationParameters;
  /** History omits inline previews; readPreview loads a bounded derived PNG on demand. */
  asset?: { id: string; preview?: string };
  error?: string;
  errorCode?: ImageGenerationErrorCode;
}

/** Acceptance and replay return the same job projection, but only acceptance may dispatch. */
export type ImageGenerationStartReceipt =
  | { kind: "accepted"; job: ImageGenerationJob }
  | { kind: "replayed"; job: ImageGenerationJob };

/** Local Desktop only. Credential references and raw provider diagnostics never cross this contract. */
export interface IImageGenerationService {
  getConfiguration(): Promise<ImageGenerationConfiguration>;
  saveConnection(
    input: ImageGenerationSaveConnectionInput,
  ): Promise<ImageGenerationPublicConnection>;
  deleteConnection(input: {
    connectionId: string;
    expectedRevision: number;
    defaultSelection?: { expectedRevision: number; selection: ImageGenerationSelection | null };
  }): Promise<void>;
  setDefaultSelection(input: {
    expectedRevision: number;
    selection: ImageGenerationSelection | null;
  }): Promise<ImageGenerationDefaultSelection>;
  probeConnection(input: {
    connectionId: string;
    revision: number;
    modelKey?: string;
  }): Promise<ImageGenerationTestResult>;
  startGeneration(input: ImageGenerationStartInput): Promise<ImageGenerationStartReceipt>;
  getRequest(input: { requestId: string }): Promise<{ job: ImageGenerationJob | null }>;
  readActive(): Promise<{ job: ImageGenerationJob | null }>;
  readHistory(input: { cursor?: string; purpose?: ImageGenerationPurpose }): Promise<{
    jobs: ImageGenerationJob[];
    nextCursor: string | null;
  }>;
  readPreview(input: { assetId: string }): Promise<{ preview: string }>;
  /** Trusted local Renderer only; it owns the platform save dialog. */
  readImage(input: { assetId: string }): Promise<Uint8Array>;
}
export const IImageGenerationService =
  createServiceDescriptor<IImageGenerationService>("image-generation");
