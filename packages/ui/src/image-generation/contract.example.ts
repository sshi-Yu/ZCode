import type { GenImageWorkspaceProps, ImageGenerationSettingsProps } from "./contract.js";

export function exampleImageGenerationSettingsProps(
  setNavigationDirty: (dirty: boolean) => void,
): ImageGenerationSettingsProps {
  return { onDirtyChange: setNavigationDirty };
}

export function exampleGenImageWorkspaceProps(
  openImageSettings: () => void,
): GenImageWorkspaceProps {
  return { onOpenSettings: openImageSettings, showWindowControls: true };
}
