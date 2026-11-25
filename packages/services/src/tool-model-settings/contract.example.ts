import type { IToolModelSettingsService } from "./contract.js";
export async function resetGitToolModel(service: IToolModelSettingsService) {
  const view = await service.getView();
  return service.saveBinding({
    toolId: "git-commit-message",
    expectedRevision: view.revision,
    selection: null,
  });
}
