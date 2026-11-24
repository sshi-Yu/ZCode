import { createServiceDescriptor } from "../descriptors.js";

export type ImageGenerationModelId = "gpt-image-1";
export type ImageGenerationStatus = "running" | "succeeded" | "failed" | "outcome_unknown";

export interface ImageGenerationJob {
  id: string;
  prompt: string;
  modelId: ImageGenerationModelId;
  status: ImageGenerationStatus;
  asset?: { id: string; preview: string };
  error?: string;
}

/** Local Desktop only. Never expose credentials or original bytes to the extension guest. */
export interface IImageGenerationService {
  getSettings(): Promise<{ modelId: ImageGenerationModelId; configured: boolean }>;
  /** An empty key removes the dedicated image credential. */
  saveSettings(input: { apiKey: string }): Promise<void>;
  /** Latest 24 jobs, including the active job. Reading never dispatches a request. */
  read(): Promise<{ jobs: ImageGenerationJob[] }>;
  /** Durable admission returns running; identical request replay returns its existing projection. */
  start(input: {
    requestId: string;
    prompt: string;
    modelId: ImageGenerationModelId;
  }): Promise<ImageGenerationJob>;
  /** Trusted Renderer only; it owns the platform save dialog. */
  readImage(input: { assetId: string }): Promise<Uint8Array>;
}

export const IImageGenerationService =
  createServiceDescriptor<IImageGenerationService>("image-generation");
