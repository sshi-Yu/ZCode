export const genImageModule = {
  id: "genimage",
  requires: ["services", "shared", "specialized-model-settings"],
  provides: ["genimage"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
