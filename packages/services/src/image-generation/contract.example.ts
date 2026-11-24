import type { IImageGenerationService } from "./contract.js";

/** The caller freezes these values only after its user confirmation. */
export async function exampleImageGeneration(service: IImageGenerationService): Promise<void> {
  const settings = await service.getSettings();
  if (!settings.configured) return;
  const job = await service.start({
    requestId: "confirmed-request-example",
    prompt: "A small blue ceramic teapot on a white table",
    modelId: "gpt-image-1",
  });
  // Replaying this ID reads the original job; a new generation requires a new request ID.
  const projection = await service.read();
  const completed = projection.jobs.find((entry) => entry.id === job.id);
  if (completed?.asset) await service.readImage({ assetId: completed.asset.id });
}
