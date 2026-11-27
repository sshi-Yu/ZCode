import type { IGenImageService } from "./contract.js";

export async function generatePersonalCanvasImage(
  service: IGenImageService,
  requestId: string,
  modelRevision: number,
) {
  return service.generate({
    scope: "",
    modelRevision,
    requestId,
    prompt: "An evening lake",
    x: 0,
    y: 0,
  });
}

export async function importPersonalImage(
  service: IGenImageService,
  requestId: string,
  bytes: Uint8Array,
) {
  return service.importAsset({ scope: "", requestId, name: "image.png", bytes, x: 0, y: 0 });
}
