import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isRemoteWorkspaceIdentity, type ModelSelection } from "@zcode/shared";
import { z } from "zod";
import {
  GENIMAGE_BOARD_NODE_LIMIT,
  GENIMAGE_ASSET_MAX_BYTES,
  type GenImageBoard,
  type GenImageRatio,
  type IGenImageService,
} from "./contract.js";
import { decodeImportedImage } from "./image.js";
import { generateRemoteImage, type ExecutableImageModel } from "./adapter.js";
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
  modelRevision: z.int().min(0),
});
const importInput = scopedInput.extend({
  ...position,
  requestId: nodeId,
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^/\\\p{Cc}]+$/u),
  bytes: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.length > 0 && bytes.length <= GENIMAGE_ASSET_MAX_BYTES),
});
const extractInput = nodeInput.extend({
  requestId: nodeId,
  modelRevision: z.int().min(0),
  routeKey: digest,
});
const featureContent = z.strictObject({
  summary: z.string().trim().min(1).max(600),
  tags: z.array(z.string().trim().min(1).max(32)).min(1).max(8),
});
const storedFeatures = featureContent.extend({
  modelRevision: z.int().min(0),
  providerId: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256),
  routeKey: digest.optional(),
});
const featureLeaseMs = 120_000;

const storedEntry = z.strictObject({
  node: z.strictObject({
    ...position,
    id: nodeId,
    source: nodeId.nullable(),
    title: z.string().min(1).max(80),
    prompt: z.union([prompt, z.literal("")]),
    ratio,
    width: z.int().min(1).max(4096),
    height: z.int().min(1).max(4096),
    createdAt: z.int().min(0),
    version,
    modelName: z.string().max(100).optional(),
    fileName: z.string().min(1).max(255).optional(),
    features: storedFeatures.optional(),
  }),
  requestHash: digest,
  hue: z.int().min(0).max(359).optional(),
  mimeType: z.enum(["image/png", "image/jpeg"]).optional(),
  assets: z.strictObject({ original: digest, thumbnail: digest }),
});
const storedBoard = z.strictObject({
  revision: z.int().min(0),
  entries: z.array(storedEntry).max(GENIMAGE_BOARD_NODE_LIMIT),
  jobs: z
    .array(
      z.strictObject({ id: nodeId, requestHash: digest, error: z.string().max(100).optional() }),
    )
    .max(GENIMAGE_BOARD_NODE_LIMIT)
    .default([]),
  featureJobs: z
    .array(
      z.strictObject({
        digest,
        key: digest.optional(),
        requestId: nodeId,
        expiresAt: z.int().min(0),
      }),
    )
    .max(GENIMAGE_BOARD_NODE_LIMIT)
    .default([]),
});

type StoredEntry = z.infer<typeof storedEntry>;
type StoredBoard = z.infer<typeof storedBoard>;

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function imageRatio(width: number, height: number): GenImageRatio {
  return width === height ? "1:1" : width > height ? "4:3" : "3:4";
}

function boardView({ revision, entries, jobs }: StoredBoard): GenImageBoard {
  return {
    revision,
    nodes: entries.map(({ node }) => node),
    unconfirmed: jobs.filter(({ error }) => !error || error === "genimage.result-unknown").length,
  };
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
  const path = assetPath(await realpath(directory), entry.node.id, variant, entry.mimeType);
  const bytes = await readBoundedFile(path, assetLimits[variant]);
  if ((await realpath(path)) !== path) throw new Error("Invalid GenImage asset path");
  if (hash(bytes) !== entry.assets[variant]) throw new Error("GenImage asset is damaged");
  return {
    path,
    bytes,
    mimeType: variant === "thumbnail" ? ("image/png" as const) : (entry.mimeType ?? "image/png"),
    node: entry.node,
  };
}

export function createGenImageService(options: {
  dataDir: string;
  resolveModel?: (expectedRevision: number) => Promise<ExecutableImageModel>;
  generateImage?: typeof generateRemoteImage;
  resolveFeatureModel?: (
    expectedRevision: number,
    expectedRouteKey: string,
  ) => Promise<ModelSelection>;
  extractImageFeatures?: (input: {
    selection: ModelSelection;
    image: Uint8Array;
    routeKey: string;
  }) => Promise<{ summary: string; tags: string[] }>;
  createPreviewUrl: (path: string) => Promise<string>;
}): IGenImageService {
  const root = resolve(options.dataDir);
  const boardDirectory = (scope: string) => resolve(root, hash(JSON.stringify(scope.trim())));

  async function findAsset(scope: string, nodeId: string, variant: AssetVariant) {
    const directory = boardDirectory(scope);
    const entry = requireNode(await loadBoard(directory), nodeId);
    return loadAsset(directory, entry, variant);
  }

  async function generateLive(input: z.infer<typeof generateInput>): Promise<GenImageBoard> {
    const { scope, requestId: id, prompt, x, y, modelRevision } = input;
    if (!options.resolveModel) throw new Error("genimage.model-unavailable");
    const directory = boardDirectory(scope);
    const requestHash = hash(JSON.stringify([prompt, "4:3", null, x, y, modelRevision]));
    const admission = await withBoardLock(directory, async () => {
      const board = await loadBoard(directory);
      const existing = board.entries.find(({ node }) => node.id === id);
      const job = board.jobs.find((job) => job.id === id);
      if (
        (existing || job)?.requestHash !== undefined &&
        (existing || job)?.requestHash !== requestHash
      )
        throw new Error("genimage.request-conflict");
      if (existing) return { snapshot: boardView(board) };
      if (job) throw new Error(job.error ?? "genimage.result-unknown");
      if (board.entries.length + board.jobs.length >= GENIMAGE_BOARD_NODE_LIMIT)
        throw new Error("GenImage board limit reached");
      const model = await options.resolveModel!(modelRevision);
      board.jobs.push({ id, requestHash });
      board.revision = nextVersion(board.revision);
      await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
      await publishManifest(directory, board, false);
      return { model };
    });
    if (admission.snapshot) return admission.snapshot;
    try {
      const generated = await (options.generateImage ?? generateRemoteImage)(
        admission.model!,
        prompt,
      );
      return await withBoardLock(directory, async () => {
        const board = await loadBoard(directory);
        const job = board.jobs.find((job) => job.id === id);
        if (!job || job.requestHash !== requestHash) throw new Error("genimage.result-unknown");
        await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
        await publishAsset(directory, id, "original", generated.original);
        await publishAsset(directory, id, "thumbnail", generated.thumbnail);
        board.entries.push({
          node: {
            id,
            source: null,
            title: Array.from(prompt.replace(/\s+/g, " ")).slice(0, 40).join(""),
            prompt,
            ratio: imageRatio(generated.width, generated.height),
            x,
            y,
            width: generated.width,
            height: generated.height,
            createdAt: Date.now(),
            version: 1,
            modelName: admission.model!.name,
          },
          requestHash,
          assets: { original: hash(generated.original), thumbnail: hash(generated.thumbnail) },
        });
        board.jobs = board.jobs.filter((job) => job.id !== id);
        board.revision = nextVersion(board.revision);
        await publishManifest(directory, board, true);
        return boardView(board);
      });
    } catch (error) {
      const code =
        error instanceof Error &&
        /^genimage\.(authentication|quota|rejected|response-invalid|destination-unavailable|result-unknown)$/.test(
          error.message,
        )
          ? error.message
          : "genimage.result-unknown";
      await withBoardLock(directory, async () => {
        const board = await loadBoard(directory);
        const job = board.jobs.find((job) => job.id === id);
        if (!job) return;
        job.error = code;
        board.revision = nextVersion(board.revision);
        await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
        await publishManifest(directory, board, false);
      }).catch(() => undefined);
      throw new Error(code);
    }
  }

  return {
    async getBoard(input) {
      const { scope } = scopedInput.parse(input);
      return boardView(await loadBoard(boardDirectory(scope)));
    },

    async generate(input) {
      return generateLive(generateInput.parse(input));
    },

    async importAsset(input) {
      const { scope, requestId: id, name, bytes, x, y } = importInput.parse(input);
      const image = await decodeImportedImage(bytes);
      const originalDigest = hash(image.original);
      const directory = boardDirectory(scope);
      const requestHash = hash(JSON.stringify(["import", originalDigest, name, x, y]));
      return withBoardLock(directory, async () => {
        const board = await loadBoard(directory);
        const existing = board.entries.find(({ node }) => node.id === id);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new Error("genimage.request-conflict");
          }
          return boardView(board);
        }
        if (board.jobs.some((job) => job.id === id)) throw new Error("genimage.request-conflict");
        if (board.entries.length + board.jobs.length >= GENIMAGE_BOARD_NODE_LIMIT) {
          throw new Error("GenImage board limit reached");
        }
        const features = board.entries.find(
          (entry) => entry.assets.original === originalDigest && entry.node.features,
        )?.node.features;
        await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
        await publishAsset(directory, id, "original", image.original, image.mimeType);
        await publishAsset(directory, id, "thumbnail", image.thumbnail);
        board.revision = nextVersion(board.revision);
        board.entries.push({
          node: {
            id,
            source: null,
            title: name.slice(0, 80),
            fileName: name,
            prompt: "",
            ratio: imageRatio(image.width, image.height),
            x,
            y,
            width: image.width,
            height: image.height,
            createdAt: Date.now(),
            version: 1,
            features,
          },
          requestHash,
          mimeType: image.mimeType,
          assets: { original: originalDigest, thumbnail: hash(image.thumbnail) },
        });
        await publishManifest(directory, board, true);
        return boardView(board);
      });
    },

    async extractFeatures(input) {
      const { scope, nodeId, requestId, modelRevision, routeKey } = extractInput.parse(input);
      const { resolveFeatureModel, extractImageFeatures } = options;
      if (!resolveFeatureModel || !extractImageFeatures)
        throw new Error("genimage.feature-unavailable");
      const directory = boardDirectory(scope);
      const admission = await withBoardLock(directory, async () => {
        const board = await loadBoard(directory);
        const entry = requireNode(board, nodeId);
        const selection = await resolveFeatureModel(modelRevision, routeKey);
        const digest = entry.assets.original;
        const key = hash(JSON.stringify([digest, modelRevision, routeKey]));
        const related = board.entries.filter((entry) => entry.assets.original === digest);
        const cached = related.find(
          ({ node }) =>
            node.features?.modelRevision === modelRevision &&
            node.features.routeKey === routeKey &&
            node.features.providerId === selection.providerId &&
            node.features.modelId === selection.modelId,
        )?.node.features;
        const saveFeatures = async (features: z.infer<typeof storedFeatures>) => {
          for (const entry of related) entry.node.features = features;
          board.revision = nextVersion(board.revision);
          await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
          await publishManifest(directory, board, false);
        };
        if (cached) {
          if (entry.node.features !== cached) await saveFeatures(cached);
          return { snapshot: boardView(board) } as const;
        }
        const now = Date.now();
        const active = board.featureJobs.find((job) => job.key === key);
        if (active && (active.requestId === requestId || active.expiresAt > now)) {
          throw new Error("genimage.feature-busy");
        }
        const { bytes } = await loadAsset(directory, entry, "thumbnail");
        board.featureJobs = board.featureJobs.filter((job) => job.expiresAt > now);
        if (board.featureJobs.length >= GENIMAGE_BOARD_NODE_LIMIT)
          throw new Error("genimage.feature-busy");
        board.featureJobs.push({ digest, key, requestId, expiresAt: now + featureLeaseMs });
        await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
        await publishManifest(directory, board, false);
        return { digest, key, bytes, selection } as const;
      });
      if ("snapshot" in admission) return admission.snapshot!;
      try {
        const { selection } = admission;
        const ready = await resolveFeatureModel(modelRevision, routeKey);
        if (ready.providerId !== selection.providerId || ready.modelId !== selection.modelId) {
          throw new Error("genimage.feature-stale");
        }
        const result = featureContent.parse(
          await extractImageFeatures({ selection, image: admission.bytes, routeKey }),
        );
        return await withBoardLock(directory, async () => {
          const board = await loadBoard(directory);
          const job = board.featureJobs.find((job) => job.key === admission.key);
          const entry = requireNode(board, nodeId);
          const current = await resolveFeatureModel(modelRevision, routeKey);
          if (
            job?.requestId !== requestId ||
            entry.assets.original !== admission.digest ||
            current.providerId !== selection.providerId ||
            current.modelId !== selection.modelId
          ) {
            throw new Error("genimage.feature-stale");
          }
          const features = storedFeatures.parse({
            ...result,
            tags: [...new Set(result.tags)],
            modelRevision,
            providerId: selection.providerId,
            modelId: selection.modelId,
            routeKey,
          });
          for (const entry of board.entries) {
            if (entry.assets.original === admission.digest) entry.node.features = features;
          }
          board.featureJobs = board.featureJobs.filter((candidate) => candidate !== job);
          board.revision = nextVersion(board.revision);
          await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
          await publishManifest(directory, board, false);
          return boardView(board);
        });
      } catch (error) {
        await withBoardLock(directory, async () => {
          const board = await loadBoard(directory);
          const job = board.featureJobs.find((job) => job.key === admission.key);
          if (job?.requestId !== requestId) return;
          job.expiresAt = 0;
          await cleanUncommittedFiles(directory, new Set(board.entries.map(({ node }) => node.id)));
          await publishManifest(directory, board, false);
        }).catch(() => undefined);
        if (
          error instanceof Error &&
          error.message === "specialized-model-settings.revision-conflict"
        )
          throw error;
        throw new Error("genimage.feature-failed");
      }
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
      const { path, node, mimeType } = await findAsset(scope, nodeId, variant);
      return {
        url: await options.createPreviewUrl(path),
        name:
          (variant === "original" ? node.fileName : undefined) ??
          `image-${nodeId.slice(0, 16)}.png`,
        mimeType,
      };
    },

    async readOriginal(input) {
      const { scope, nodeId } = nodeInput.parse(input);
      const { bytes } = await findAsset(scope, nodeId, "original");
      return new Uint8Array(bytes);
    },
  };
}
