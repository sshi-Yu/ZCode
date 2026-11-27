import { crc32 } from "node:zlib";
import { PNG } from "pngjs";
import { decode as decodeJpeg } from "jpeg-js";
import { GENIMAGE_ASSET_MAX_BYTES } from "./contract.js";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const originalLimit = GENIMAGE_ASSET_MAX_BYTES;

function invalid(): never {
  throw new Error("genimage.response-invalid");
}

export async function decodeGeneratedImage(encoded: string) {
  if (
    !encoded.length ||
    encoded.length > Math.ceil(originalLimit / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    invalid();
  const original = Buffer.from(encoded, "base64");
  if (original.toString("base64") !== encoded) invalid();
  return decodePng(original);
}

async function decodePng(original: Buffer) {
  if (
    original.length > originalLimit ||
    original.length < 45 ||
    !original.subarray(0, 8).equals(signature) ||
    original.readUInt32BE(8) !== 13 ||
    original.toString("ascii", 12, 16) !== "IHDR"
  )
    invalid();
  const width = original.readUInt32BE(16);
  const height = original.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_777_216) invalid();
  let offset = 8;
  let ended = false;
  while (offset < original.length) {
    if (offset + 12 > original.length) invalid();
    const length = original.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > original.length) invalid();
    if (crc32(original.subarray(offset + 4, end - 4)) !== original.readUInt32BE(end - 4)) invalid();
    const kind = original.toString("ascii", offset + 4, offset + 8);
    if (kind === "IHDR" && offset !== 8) invalid();
    if (kind === "IEND") {
      if (length !== 0 || end !== original.length) invalid();
      ended = true;
    }
    offset = end;
  }
  if (!ended) invalid();
  const decoded = await new Promise<PNG>((resolve, reject) => {
    new PNG({ checkCRC: true }).parse(original, (error, image) => {
      if (error) reject(new Error("genimage.response-invalid"));
      else resolve(image);
    });
  });
  return { original, thumbnail: await makeThumbnail(decoded), width, height };
}

async function makeThumbnail({
  width,
  height,
  data,
}: {
  width: number;
  height: number;
  data: Uint8Array;
}) {
  const scale = Math.min(1, 240 / Math.max(width, height));
  const thumbnailImage = new PNG({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  });
  for (let row = 0; row < thumbnailImage.height; row += 1) {
    for (let column = 0; column < thumbnailImage.width; column += 1) {
      const sourceRow = Math.min(height - 1, Math.floor(row / scale));
      const sourceColumn = Math.min(width - 1, Math.floor(column / scale));
      const sourceOffset = (sourceRow * width + sourceColumn) * 4;
      thumbnailImage.data.set(
        data.subarray(sourceOffset, sourceOffset + 4),
        (row * thumbnailImage.width + column) * 4,
      );
    }
  }
  const thumbnail = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    thumbnailImage
      .pack()
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", () => reject(new Error("genimage.response-invalid")));
  });
  if (thumbnail.length > 256 * 1024) invalid();
  return thumbnail;
}

export async function decodeImportedImage(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > originalLimit) throw new Error("genimage.import-invalid");
  const original = Buffer.from(bytes);
  try {
    if (original.subarray(0, 8).equals(signature)) {
      return { ...(await decodePng(original)), mimeType: "image/png" as const };
    }
    if (
      original.readUInt16BE(0) !== 0xffd8 ||
      original.readUInt16BE(original.length - 2) !== 0xffd9
    )
      invalid();
    const image = decodeJpeg(original, {
      tolerantDecoding: false,
      maxResolutionInMP: 16.8,
      maxMemoryUsageInMB: 384,
    });
    if (!image.width || !image.height || image.width > 4096 || image.height > 4096) invalid();
    return {
      original,
      thumbnail: await makeThumbnail(image),
      width: image.width,
      height: image.height,
      mimeType: "image/jpeg" as const,
    };
  } catch {
    throw new Error("genimage.import-invalid");
  }
}
