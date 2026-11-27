import type { ModelSelection } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const IMAGE_MODEL_PROTOCOLS = ["openai", "base64"] as const;
export const IMAGE_MODEL_QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;

export interface ImageModelInput {
  name: string;
  modelId: string;
  protocol: (typeof IMAGE_MODEL_PROTOCOLS)[number];
  baseUrl: string;
  size: string;
  quality: "" | (typeof IMAGE_MODEL_QUALITIES)[number];
}

export interface ImageModelView extends ImageModelInput {
  id: string;
  generationUrl: string;
  configured: boolean;
}

export interface ImageModelSettingsView {
  revision: number;
  models: ImageModelView[];
  defaultId: string | null;
}

export type ToolModelRef = Pick<ModelSelection, "providerId" | "modelId">;

export interface ToolModelSettingsView {
  revision: number;
  selection: ToolModelRef | null;
  candidates: ToolModelRef[];
}

export interface FeatureModelSettingsView extends ToolModelSettingsView {
  available: boolean;
  routeKey: string | null;
  endpointHost: string | null;
}

export interface ISpecializedModelSettingsService {
  getImageSettings(): Promise<ImageModelSettingsView>;
  saveImageModel(input: {
    expectedRevision: number;
    id?: string;
    model: ImageModelInput;
    apiKey?: string;
  }): Promise<ImageModelSettingsView>;
  deleteImageModel(input: {
    expectedRevision: number;
    id: string;
  }): Promise<ImageModelSettingsView>;
  setDefaultImageModel(input: {
    expectedRevision: number;
    id: string;
  }): Promise<ImageModelSettingsView>;
  getToolModelSettings(): Promise<ToolModelSettingsView>;
  setToolModel(input: {
    expectedRevision: number;
    selection: ToolModelRef | null;
  }): Promise<ToolModelSettingsView>;
  getFeatureModelSettings(): Promise<FeatureModelSettingsView>;
  setFeatureModel(input: {
    expectedRevision: number;
    selection: ToolModelRef | null;
  }): Promise<FeatureModelSettingsView>;
}

export const ISpecializedModelSettingsService =
  createServiceDescriptor<ISpecializedModelSettingsService>("specialized-model-settings");

export function imageGenerationUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return `${normalized}${normalized.endsWith("/v1") ? "" : "/v1"}/images/generations`;
}

export function toolModelKey(model: ToolModelRef | null): string {
  return model ? JSON.stringify([model.providerId, model.modelId]) : "";
}
