import { activate } from "../../index.mjs";

const anchor = {
  workspaceKey: "workspace-identity",
  sessionId: "session-one",
  productTurnId: "turn-one",
  assistantMessageId: "assistant-one",
};
let command;
await activate({
  extension: { dataPath: process.argv[2] },
  log: { info() {}, warn() {}, error() {} },
  commands: {
    register(id, run) {
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
      process.send({ type: "generating" });
      return new Promise(() => {});
    },
    async invalidate() {},
  },
});
await command({ args: { kind: "completed", anchor, requestId: "interrupted", permit: "permit" } });
