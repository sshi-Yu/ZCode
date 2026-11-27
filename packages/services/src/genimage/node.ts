import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { z } from "zod";
import {
  GENIMAGE_BOARD_NODE_LIMIT,
  type GenImageBoard,
  type GenImageRatio,
  type IGenImageService,
} from "./contract.js";
import { renderSimulatedPng } from "./raster.js";
import {
  assetLimits,
  assetPath,
  cleanUncommittedFiles,
  publishAsset,
  publishManifest,
  readBoundedFile,
  readManifest,
  withBoardLock,
  type AssetVariant,
} from "./storage.js";

const ratio = z.enum(["4:3", "1:1", "3:4"]);
const coordinate = z
  .number()
  .min(-1_000_000)
  .max(1_000_000)
  .transform((value) => (value === 0 ? 0 : value));
const prompt = z.string().max(4000).trim().min(1);
const version = z.int().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nodeId = z.uuid().regex(/^[0-9a-f-]+$/);
const scope = z
  .string()
  .max(4096)
  .refine(
    (value) => !value.includes("\0") && !isRemoteWorkspaceIdentity(value.trim()),
    "Invalid local GenImage scope",
  );
const scopedInput = z.strictObject({ scope });
const nodeInput = scopedInput.extend({ nodeId });
const position = { x: coordinate, y: coordinate };
const moveInput = nodeInput.extend({ ...position, expectedVersion: version });
const assetInput = nodeInput.extend({ variant: z.enum(["original", "thumbnail"]) });
const generateInput = scopedInput.extend({
  ...position,
  requestId: nodeId,
  prompt,
  ratio,
  sourceId: nodeId.nullable(),
});

const storedEntry = z.strictObject({
  node: z.strictObject({
    ...position,
    id: nodeId,
    source: nodeId.nullable(),
    title: z.string().min(1).max(80),
    prompt,
    ratio,
    width: z.int().min(1).max(768),
    height: z.int().min(1).max(768),
    createdAt: z.int().min(0),
    version,
  }),
  requestHash: digest,
  hue: z.int().min(0).max(359),
  assets: z.strictObject({ original: digest, thumbnail: digest }),
});
const storedBoard = z.strictObject({
  revision: z.int().min(0),
  entries: z.array(storedEntry).max(GENIMAGE_BOARD_NODE_LIMIT),
});

type StoredEntry = z.infer<typeof storedEntry>;
type StoredBoard = z.infer<typeof storedBoard>;

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function imageDimensions(ratio: GenImageRatio, longEdge: number) {
  return {
    width: ratio === "3:4" ? (longEdge * 3) / 4 : longEdge,
    height: ratio === "4:3" ? (longEdge * 3) / 4 : longEdge,
  };
}

function boardView({ revision, entries }: StoredBoard): GenImageBoard {
  return { revision, nodes: entries.map(({ node }) => node) };
}

function nextVersion(current: number): number {
  if (current === Number.MAX_SAFE_INTEGER) throw new Error("GenImage version limit reached");
  return current + 1;
}

async function loadBoard(directory: string): Promise<StoredBoard> {
  return storedBoard.parse(await readManifest(directory));
}

function requireNode(board: StoredBoard, nodeId: string): StoredEntry {
  const entry = board.entries.find(({ node }) => node.id === nodeId);
  if (!entry) throw new Error("GenImage node is unavailable in this board");
  return entry;
}

async function loadAsset(directory: string, entry: StoredEntry, variant: AssetVariant) {
  const path = assetPath(await realpath(directory), entry.node.id, variant);
  const bytes = await readBoundedFile(path, assetLimits[variant]);
  if ((await realpath(path)) !== path) throw new Error("Invalid GenImage asset path");
  if (hash(bytes) !== entry.assets[variant]) throw new Error("GenImage asset is damaged");
  return { path, bytes };
}

export function createGenImageService(options: {
  dataDir: string;
  createPreviewUrl: (path: string) => Promise<string>;
}): IGenImageService {
  const root = resolve(options.dataDir);
  const boardDirectory = (scope: string) => resolve(root, hash(JSON.stringify(scope)));

  async function findAsset(scope: string, nodeId: string, variant: AssetVariant) {
    const directory = boardDirectory(scope);
    const entry = requireNode(await loadBoard(directory), nodeId);
    return loadAsset(directory, entry, variant);
  }

  return {
    async getBoard(input) {
      const { scope } = scopedInput.parse(input);
      return boardView(await loadBoard(boardDirectory(scope)));
    },

    async generate(input) {
      const { scope, requestId, prompt, ratio, sourceId, x, y } = generateInput.parse(input);
      const directory = boardDirectory(scope);
      const id = requestId;
      const requestHash = hash(JSON.stringify([prompt, ratio, sourceId, x, y]));
      return withBoardLock(directory, async () => {
        const board = await loadBoard(directory);
        const existing = board.entries.find(({ node }) => node.id === id);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new Error("GenImage request ID was used with different arguments");
          }
          return boardView(board);
        }
        if (board.entries.length >= GENIMAGE_BOARD_NODE_LIMIT) {
          throw new Error("GenImage board limit reached");
        }
        const source = sourceId === null ? null : requireNode(board, sourceId);
        if (source) await loadAsset(directory, source, "original");
        const seed = Buffer.from(
          hash(JSON.stringify([scope, id, prompt, ratio, source?.assets.original ?? null])),
          "hex",
        );
        const hue = source
          ? (source.hue + (seed.readUInt8(0) % 49) - 24 + 360) % 360
          : seed.readUInt16BE(0) % 360;
        const dimensions = imageDimensions(ratio, 768);
        const thumbnailDimensions = imageDimensions(ratio, 320);
        const revision = nextVersion(board.revision);
        await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
        const original = await renderSimulatedPng(dimensions, seed, hue);
        const thumbnail = await renderSimulatedPng(thumbnailDimensions, seed, hue);
        await publishAsset(directory, id, "original", original);
        await publishAsset(directory, id, "thumbnail", thumbnail);
        const next: StoredBoard = {
          revision,
          entries: [
            ...board.entries,
            {
              node: {
                id,
                source: sourceId,
                title: Array.from(prompt.replace(/\s+/g, " ")).slice(0, 40).join(""),
                prompt,
                ratio,
                x,
                y,
                ...dimensions,
                createdAt: Date.now(),
                version: 1,
              },
              requestHash,
              hue,
              assets: { original: hash(original), thumbnail: hash(thumbnail) },
            },
          ],
        };
        await publishManifest(directory, next, true);
        return boardView(next);
      });
    },

    async moveNode(input) {
      const { scope, nodeId, x, y, expectedVersion } = moveInput.parse(input);
      const directory = boardDirectory(scope);
      return withBoardLock(directory, async () => {
        const board = await loadBoard(directory);
        const entry = requireNode(board, nodeId);
        if (entry.node.version !== expectedVersion) {
          throw new Error("GenImage node version conflict");
        }
        const revision = nextVersion(board.revision);
        const version = nextVersion(entry.node.version);
        await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
        entry.node = { ...entry.node, x, y, version };
        board.revision = revision;
        await publishManifest(directory, board, false);
        return boardView(board);
      });
    },

    async getAsset(input) {
      const { scope, nodeId, variant } = assetInput.parse(input);
      const { path } = await findAsset(scope, nodeId, variant);
      return {
        url: await options.createPreviewUrl(path),
        name: `genimage-${nodeId.slice(0, 16)}.png`,
        mimeType: "image/png",
      };
    },

    async readOriginal(input) {
      const { scope, nodeId } = nodeInput.parse(input);
      const { bytes } = await findAsset(scope, nodeId, "original");
      return new Uint8Array(bytes);
    },
  };
}
