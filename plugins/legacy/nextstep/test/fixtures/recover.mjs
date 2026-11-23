import { activate, deactivate } from "../../index.mjs";

await activate({
  extension: { dataPath: process.argv[2] },
  log: { info() {}, warn() {}, error() {} },
  commands: {
    register() {
      return { dispose() {} };
    },
  },
  turnFooter: {
    async history() {
      throw new Error("Recovery must not read history");
    },
    async generate() {
      throw new Error("Recovery must not generate");
    },
    async invalidate() {},
  },
});
await deactivate();
