export const genImageViewModule = {
  id: "ui-genimage-view",
  requires: ["ui", "services", "genimage", "image-preview-editor"],
  provides: ["ui-genimage-view"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
