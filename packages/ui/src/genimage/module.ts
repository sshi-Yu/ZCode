export const genImageViewModule = {
  id: "ui-genimage-view",
  requires: ["ui"],
  provides: ["ui-genimage-view"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
