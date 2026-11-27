import type { ISpecializedModelSettingsService } from "./contract.js";

export async function readSpecializedModelDefaults(service: ISpecializedModelSettingsService) {
  const [image, tools] = await Promise.all([service.getImageSettings(), service.getToolModelSettings()]);
  return { image: image.defaultId, toolModel: tools.selection };
}
