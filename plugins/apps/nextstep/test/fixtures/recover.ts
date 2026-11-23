// owner fence 夹具：另一进程开启同一数据库，换代 owner 并将遗留 generating 结算 unknown。
const entry = process.argv[3];
if (!entry?.startsWith("file:")) throw new Error("installed entry URL is required");
const { activate, deactivate } = (await import(entry)) as typeof import("../../src/index.js");

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
