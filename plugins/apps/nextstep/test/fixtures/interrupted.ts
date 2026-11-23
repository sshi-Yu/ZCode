// 崩溃恢复夹具：认领后停在 generate 途中被 SIGKILL，留下 generating 记录。
const entry = process.argv[3];
if (!entry?.startsWith("file:")) throw new Error("installed entry URL is required");
const { activate } = (await import(entry)) as typeof import("../../src/index.js");

const anchor = {
  workspaceKey: "workspace-identity",
  sessionId: "session-one",
  productTurnId: "turn-one",
  assistantMessageId: "assistant-one",
};
let command: ((call: unknown) => unknown) | undefined;
await activate({
  extension: { dataPath: process.argv[2] },
  log: { info() {}, warn() {}, error() {} },
  commands: {
    register(_id: string, run: (call: unknown) => unknown) {
      command = run;
      return { dispose() {} };
    },
  },
  turnFooter: {
    async history() {
      return {
        messages: [
          { role: "user", text: "task" },
          { role: "assistant", text: "answer" },
        ],
      };
    },
    async generate() {
      process.send?.({ type: "generating" });
      return new Promise<never>(() => {});
    },
    async invalidate() {},
  },
});
if (!command) throw new Error("command must be registered");
await command({ args: { kind: "completed", anchor, requestId: "interrupted", permit: "permit" } });
