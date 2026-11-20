export const turnFooterTransportModule = {
  id: "turn-footer-transport",
  requires: [
    "extension-host-protocol",
    "rpc",
    "services",
    "shared",
    "zcode-cli",
    "cli-active-transcript",
  ],
  provides: ["turn-footer-transport"],
  publicEntrypoints: ["contract.ts"],
} as const;
