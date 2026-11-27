import { createServiceDescriptor } from "../descriptors.js";

export type GenImageScope = string;
export type GenImageRatio = "4:3" | "1:1" | "3:4";
export const GENIMAGE_BOARD_NODE_LIMIT = 500;

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
}

export interface GenImageBoard {
  revision: number;
  nodes: GenImageNode[];
}

export interface IGenImageService {
  getBoard(input: { scope: GenImageScope }): Promise<GenImageBoard>;
  generate(input: {
    scope: GenImageScope;
    requestId: string;
    prompt: string;
    ratio: GenImageRatio;
    sourceId: string | null;
    x: number;
    y: number;
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
  }): Promise<{ url: string; name: string; mimeType: "image/png" }>;
  readOriginal(input: { scope: GenImageScope; nodeId: string }): Promise<Uint8Array>;
}

export const IGenImageService = createServiceDescriptor<IGenImageService>("genimage");
