export const imageGenerationModule = {
  id: "image-generation",
  requires: ["services", "shared"],
  provides: ["image-generation"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
