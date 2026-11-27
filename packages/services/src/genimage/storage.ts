import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withAtomicFileLock } from "../fs/atomicFileUtils.js";

const manifestName = "board.json";
const manifestLimit = 16 * 1024 * 1024;
const stagedName = ".genimage.tmp";
const assetPattern = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-(?:original|thumbnail)\.png$/;

export const assetLimits = {
  original: 2 * 1024 * 1024,
  thumbnail: 256 * 1024,
} as const;

export type AssetVariant = keyof typeof assetLimits;

export function assetPath(directory: string, nodeId: string, variant: AssetVariant): string {
  return join(directory, `${nodeId}-${variant}.png`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function assertBoardDirectory(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Invalid GenImage board directory");
  }
}

export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > limit) {
    throw new Error("Invalid GenImage file");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) {
      throw new Error("Invalid GenImage file");
    }
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("GenImage file changed during read");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readManifest(directory: string): Promise<unknown> {
  try {
    await assertBoardDirectory(directory);
    const content = await readBoundedFile(join(directory, manifestName), manifestLimit);
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return { revision: 0, entries: [] };
    throw error;
  }
}

export async function withBoardLock<Result>(
  directory: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertBoardDirectory(directory);
  if (firstCreated && process.platform !== "win32") {
    const existingParent = dirname(firstCreated);
    for (let parent = dirname(directory); ; parent = dirname(parent)) {
      await syncDirectory(parent);
      if (parent === existingParent || parent === dirname(parent)) break;
    }
  }
  return withAtomicFileLock(join(directory, manifestName), operation);
}

export async function cleanUncommittedFiles(
  directory: string,
  committedIds: ReadonlySet<string>,
): Promise<void> {
  for (const entry of await readdir(directory)) {
    const nodeId = assetPattern.exec(entry)?.[1];
    if (entry === stagedName || (nodeId && !committedIds.has(nodeId))) {
      await unlink(join(directory, entry));
    }
  }
}

async function publish(directory: string, target: string, content: Buffer): Promise<void> {
  const staged = join(directory, stagedName);
  await writeFile(staged, content, { flag: "wx", flush: true, mode: 0o600 });
  await rename(staged, target);
}

export async function publishAsset(
  directory: string,
  nodeId: string,
  variant: AssetVariant,
  png: Buffer,
): Promise<void> {
  if (png.length > assetLimits[variant]) throw new Error("GenImage PNG exceeds the size limit");
  await publish(directory, assetPath(directory, nodeId, variant), png);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishManifest(
  directory: string,
  manifest: object,
  assetsChanged: boolean,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(manifest), "utf8");
  if (body.length > manifestLimit) throw new Error("GenImage manifest exceeds the size limit");
  if (assetsChanged) {
    await syncDirectory(dirname(directory));
    await syncDirectory(directory);
  }
  await publish(directory, join(directory, manifestName), body);
  await syncDirectory(directory);
}
