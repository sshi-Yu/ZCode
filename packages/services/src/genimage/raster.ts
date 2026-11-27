import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";

type Rgb = readonly [number, number, number];

const compress = promisify(deflate);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const rgbChannels = [0, 1, 2] as const;

function color(hue: number, saturation: number, lightness: number): Rgb {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const sector = (offset + hue / 30) % 12;
    return 255 * (lightness - amplitude * Math.max(-1, Math.min(sector - 3, 9 - sector, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}

function mix(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const chunk = Buffer.allocUnsafe(body.length + 12);
  chunk.writeUInt32BE(body.length);
  chunk.write(type, 4, 4, "ascii");
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export async function renderSimulatedPng(
  { width, height }: { width: number; height: number },
  seed: Buffer,
  hue: number,
): Promise<Buffer> {
  const sky = color(hue, 0.48, 0.14);
  const horizon = color((hue + 32) % 360, 0.69, 0.59);
  const sun = color((hue + 70) % 360, 0.89, 0.87);
  const distantRidge = color((hue + 330) % 360, 0.33, 0.36);
  const nearRidge = color(hue, 0.42, 0.2);
  const shore = color((hue + 345) % 360, 0.43, 0.09);
  const sunX = 0.3 + (seed.readUInt8(2) / 255) * 0.4;
  const sunY = 0.29 + (seed.readUInt8(3) / 255) * 0.15;
  const sunRadius = 0.065 + (seed.readUInt8(4) / 255) * 0.065;
  const phase = (offset: number) => (seed.readUInt8(offset) / 255) * 2 * Math.PI;
  const farPhase = phase(5);
  const farDetailPhase = phase(6);
  const nearPhase = phase(7);
  const nearDetailPhase = phase(8);
  const bankPhase = phase(9);
  const bankDetailPhase = phase(10);
  const waterline = 0.72;
  const aspect = width / height;
  const stride = width * 3 + 1;
  const scanlines = Buffer.alloc(stride * height);
  const columns = Array.from({ length: width }, (_, column) => {
    const x = (column + 0.5) / width;
    return {
      sunDistance: (x - sunX) * aspect,
      far: 0.55 + Math.sin(x * 9 + farPhase) * 0.082 + Math.sin(x * 25 + farDetailPhase) * 0.031,
      near: 0.64 + Math.sin(x * 7 + nearPhase) * 0.058 + Math.sin(x * 21 + nearDetailPhase) * 0.026,
      bank: 0.9 + Math.sin(x * 6 + bankPhase) * 0.14 + Math.sin(x * 14 + bankDetailPhase) * 0.039,
    };
  });

  for (let row = 0; row < height; row += 1) {
    const y = (row + 0.5) / height;
    const skyFade = Math.min(1, Math.pow(y / waterline, 1.5));
    const aboveSun = y - sunY;
    const waterDepth = (y - waterline) / (1 - waterline);
    const ripple = 0.7 + 0.3 * Math.sin(y * 275 + nearPhase);
    const waterTint = 0.29 * Math.max(0, 1 - waterDepth);
    for (const [column, landscape] of columns.entries()) {
      const { sunDistance, far, near, bank } = landscape;
      const grain = (((column * 12347) ^ (row * 9739)) & 7) / 3 - 1;
      const distance = Math.sqrt(sunDistance * sunDistance + aboveSun * aboveSun);
      const glow = Math.max(0, 1 - distance / (sunRadius * 4));
      const disc = Math.max(0, Math.min(1, (sunRadius - distance) * height + 0.5));
      const reflection = Math.max(0, 1 - Math.abs(sunDistance) / (0.21 + waterDepth * 0.24));
      const pixel = row * stride + 1 + column * 3;

      for (const channel of rgbChannels) {
        let value = mix(sky[channel], horizon[channel], skyFade);
        value = mix(value, sun[channel], Math.max(glow * 0.32, disc));
        value = mix(value, distantRidge[channel], Math.max(0, Math.min(1, (y - far) * height)));
        value = mix(value, nearRidge[channel], Math.max(0, Math.min(1, (y - near) * height)));
        if (y > waterline) {
          value = mix(sky[channel], horizon[channel], waterTint + reflection * ripple * waterTint);
          value = mix(value, shore[channel], Math.max(0, Math.min(1, (y - bank) * height)));
        }
        scanlines[pixel + channel] = Math.round(Math.max(0, Math.min(255, value + grain)));
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", await compress(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
