export const specializedModelSettingsModule = {
  id: "specialized-model-settings",
  requires: ["services", "shared"],
  provides: ["specialized-model-settings"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
