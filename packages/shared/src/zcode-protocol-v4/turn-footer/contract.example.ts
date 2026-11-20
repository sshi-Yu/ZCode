import { turnFooterCommandArgsSchema } from "#src/extension-host/contract.js";

// 读取最新记录时没有一次性生成许可。
export const readLatestFooterExample = turnFooterCommandArgsSchema.parse({
  kind: "readLatest",
  anchor: {
    workspaceKey: "/example/workspace",
    sessionId: "sess_example",
    productTurnId: "turn_example",
    assistantMessageId: "message_example",
  },
});
