import type { IGenImageService } from "./contract.js";

export async function generatePersonalCanvasImage(service: IGenImageService, requestId: string) {
  return service.generate({
    scope: "",
    requestId,
    prompt: "An evening lake framed by mountain silhouettes",
    ratio: "4:3",
    sourceId: null,
    x: 0,
    y: 0,
  });
}
