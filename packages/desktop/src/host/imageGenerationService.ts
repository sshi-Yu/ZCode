import { Jimp } from "jimp";
import type { ICredentialService, IImageGenerationService } from "@zcode/services";
import {
  createImageGenerationService,
  getAppConfigDir,
  type HostApiNetworkTransport,
} from "@zcode/services/node";

const credentialKey = "image-generation.openai.api-key";
const maxPreviewBytes = 128 * 1024;
// Main 在 fork 时覆盖应用运行身份；捕获后移除，避免 Agent/工具继承宿主装配参数。
const appRunId = process.env.ZCODE_IMAGE_GENERATION_APP_RUN_ID ?? "";
const fixtureEndpoint =
  process.env.ZCODE_E2E_RUN_ID?.trim() && process.env.ZCODE_E2E_HOME_DIR?.trim()
    ? process.env.ZCODE_E2E_GENIMAGE_ENDPOINT?.trim()
    : undefined;
delete process.env.ZCODE_IMAGE_GENERATION_APP_RUN_ID;
delete process.env.ZCODE_E2E_GENIMAGE_ENDPOINT;

/** Fully decode the original PNG; only the derived preview is resized/re-encoded. */
export async function createImageGenerationPngPreview(png: Uint8Array): Promise<Uint8Array> {
  const image = await Jimp.read(Buffer.from(png));
  // 噪声图片即使缩至 384px 仍可超过 128KiB；逐级降低预览尺寸，原图字节保持不变。
  for (const edge of [384, 256, 192, 128, 64]) {
    const scale = Math.min(1, edge / image.width, edge / image.height);
    if (scale < 1) {
      image.resize({
        w: Math.max(1, Math.round(image.width * scale)),
        h: Math.max(1, Math.round(image.height * scale)),
      });
    }
    const preview = await image.getBuffer("image/png", { deflateLevel: 9 });
    if (preview.byteLength <= maxPreviewBytes) return preview;
  }
  throw new Error("Image preview is unavailable.");
}

/** Local Window Host composition; this service never belongs to remote service collections. */
export function createWindowHostImageGenerationService(options: {
  credentialService: ICredentialService;
  networkTransport: HostApiNetworkTransport;
}): IImageGenerationService {
  const { credentialService, networkTransport } = options;
  if (!networkTransport.prepareImageGeneration)
    throw new Error("Image generation network transport is unavailable");
  const privateKey = (ref?: string) => {
    if (ref !== undefined && !/^image-generation\.credential\.[0-9a-f-]{36}$/.test(ref)) {
      throw new Error("Invalid private image credential reference");
    }
    return ref ?? credentialKey;
  };
  return createImageGenerationService({
    appConfigDir: getAppConfigDir(),
    appRunId,
    credential: {
      get: (ref) => credentialService.load(privateKey(ref)),
      set: (value, ref) => credentialService.save(privateKey(ref), value),
      delete: (ref) => credentialService.delete(privateKey(ref)),
    },
    prepareImageGeneration: networkTransport.prepareImageGeneration.bind(networkTransport),
    createPngPreview: createImageGenerationPngPreview,
    ...(fixtureEndpoint ? { fixture: { endpoint: fixtureEndpoint, mode: "test" as const } } : {}),
  });
}
