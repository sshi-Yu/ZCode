import type { IImageGenerationService } from "./contract.js";

/** The caller freezes these values only after its user confirmation. */
export async function exampleImageGeneration(service: IImageGenerationService): Promise<void> {
  const configuration = await service.getConfiguration();
  const connection = configuration.connections.find(
    (entry) => entry.enabled && entry.configured && entry.models.some((model) => model.enabled),
  );
  const model = connection?.models.find((entry) => entry.enabled);
  if (!connection || !model) return;
  // Replaying this ID reads the original frozen job; a new generation requires a new request ID.
  const { job } = await service.startGeneration({
    requestId: "confirmed-request-example",
    connectionId: connection.connectionId,
    modelKey: model.modelKey,
    revision: connection.revision,
    purpose: "generation",
    prompt: "A small blue ceramic teapot on a white table",
  });
  let current = job;
  for (let attempt = 0; current.status === "running" && attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    current = (await service.getRequest({ requestId: "confirmed-request-example" })).job ?? current;
  }
  if (current.status === "succeeded" && current.asset) {
    await service.readPreview({ assetId: current.asset.id });
    await service.readImage({ assetId: current.asset.id });
  }
}
