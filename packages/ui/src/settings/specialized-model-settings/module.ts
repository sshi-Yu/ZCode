export const specializedModelSettingsUiModule = {
  id: "specialized-model-settings-ui",
  requires: ["services", "ui"],
  provides: ["specialized-model-settings-ui"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
