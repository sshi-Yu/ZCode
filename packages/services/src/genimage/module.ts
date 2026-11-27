export const genImageModule = {
  id: "genimage",
  requires: ["services", "shared"],
  provides: ["genimage"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
