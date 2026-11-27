import { createServiceDescriptor } from "../descriptors.js";

export type GenImageScope = string;
export type GenImageRatio = "4:3" | "1:1" | "3:4";
export const GENIMAGE_BOARD_NODE_LIMIT = 500;
export const GENIMAGE_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export type GenImageMimeType = "image/png" | "image/jpeg";

export interface GenImageFeatures {
  summary: string;
  tags: string[];
  modelRevision: number;
  providerId: string;
  modelId: string;
  routeKey?: string;
}

export interface GenImageNode {
  id: string;
  source: string | null;
  title: string;
  prompt: string;
  ratio: GenImageRatio;
  x: number;
  y: number;
  width: number;
  height: number;
  createdAt: number;
  version: number;
  modelName?: string;
  fileName?: string;
  features?: GenImageFeatures;
}

export interface GenImageBoard {
  revision: number;
  nodes: GenImageNode[];
  unconfirmed?: number;
}

export interface IGenImageService {
  getBoard(input: { scope: GenImageScope }): Promise<GenImageBoard>;
  generate(input: {
    scope: GenImageScope;
    requestId: string;
    prompt: string;
    x: number;
    y: number;
    modelRevision: number;
  }): Promise<GenImageBoard>;
  importAsset(input: {
    scope: GenImageScope;
    requestId: string;
    name: string;
    bytes: Uint8Array;
    x: number;
    y: number;
  }): Promise<GenImageBoard>;
  extractFeatures(input: {
    scope: GenImageScope;
    nodeId: string;
    requestId: string;
    modelRevision: number;
    routeKey: string;
  }): Promise<GenImageBoard>;
  moveNode(input: {
    scope: GenImageScope;
    nodeId: string;
    x: number;
    y: number;
    expectedVersion: number;
  }): Promise<GenImageBoard>;
  getAsset(input: {
    scope: GenImageScope;
    nodeId: string;
    variant: "thumbnail" | "original";
  }): Promise<{ url: string; name: string; mimeType: GenImageMimeType }>;
  readOriginal(input: { scope: GenImageScope; nodeId: string }): Promise<Uint8Array>;
}

export const IGenImageService = createServiceDescriptor<IGenImageService>("genimage");
