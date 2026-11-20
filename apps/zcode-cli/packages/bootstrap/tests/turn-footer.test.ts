import { afterEach, describe, expect, it } from "vitest";
import type { EventId, MessageWithParts, SessionEvent, SessionId, TraceId, TurnId } from "@zcode/contracts";
import { readBoundedTurnFooterHistory } from "../src/zcode-protocol-v4/turn-footer.js";
import { SessionEventType } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const anchor = {
  sessionId: "session-1",
  productTurnId: "user-1",
  assistantMessageId: "assistant-1",
};

class Transcript {
  readonly events: SessionEvent[] = [];

  push(type: SessionEvent["type"], payload: unknown, turnId = "runtime-1"): SessionEvent {
    const seq = this.events.length + 1;
    const event = {
      id: `event-${seq}` as EventId,
      sessionId: "session-1" as SessionId,
      turnId: turnId as TurnId,
      traceId: "trace-1" as TraceId,
      timestamp: new Date(1_700_000_000_000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    };
    this.events.push(event);
    return event;
  }

  start(messageId = "user-1", turnId = "runtime-1") {
    return this.push(SessionEventType.TurnStarted, { turnNumber: 1, input: "question", messageId }, turnId);
  }

  answer(messageId = "assistant-1", text = "answer", turnId = "runtime-1") {
    return [
      this.push(SessionEventType.ModelStreaming, { kind: "text_start", delta: "", done: false, assistantMessageId: messageId }, turnId),
      this.push(SessionEventType.ModelStreaming, { kind: "text_delta", delta: text, done: false, assistantMessageId: messageId }, turnId),
      this.push(SessionEventType.ModelStreaming, { kind: "text_end", delta: "", done: false, assistantMessageId: messageId }, turnId),
    ];
  }

  complete(resultType = "success", turnId = "runtime-1") {
    return this.push(SessionEventType.TurnComplete, { response: "answer", tokenCount: 2, toolCallCount: 0, duration: 1, resultType }, turnId);
  }
}

const gateways: ConversationV4Gateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.dispose();
});

function fixture(overrides: Partial<V4GatewayHost> = {}) {
  const completed: unknown[] = [];
  const executed: CommandEnvelope[] = [];
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true,
    emitWireFrame: () => undefined,
    emitTurnFooterCompleted: (fact) => completed.push(fact),
    isTurnFooterSessionEligible: () => true,
    executeCommand: async (envelope) => { executed.push(envelope); },
    ...overrides,
  });
  gateways.push(gateway);
  const log = new Transcript();
  gateway.ingest("session-1", log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 }));
  const ingest = (...events: SessionEvent[]) => events.forEach((event) => gateway.ingest("session-1", event));
  const reply = () => { ingest(log.start(), ...log.answer(), log.complete()); };
  return { gateway, log, completed, executed, ingest, reply };
}

function send(commandId: string, expected = anchor) {
  return {
    commandId,
    clientId: "turn-footer",
    sessionId: "session-1",
    type: "sendText",
    issuedAt: 1,
    payload: { text: "/goal literal suggestion", expectedTurnFooterAnchor: expected },
  };
}

describe("turn footer live completion", () => {
  it("publishes one persistent anchor only after the successful product turn commits", () => {
    const f = fixture();
    f.ingest(f.log.start(), ...f.log.answer());
    expect(f.completed).toEqual([]);
    const terminal = f.log.complete();
    f.ingest(terminal, terminal);
    expect(f.completed).toEqual([anchor]);
  });

  it("publishes the previous successful product turn at queue drain, but guide does not split", () => {
    const f = fixture();
    f.ingest(f.log.start(), ...f.log.answer());
    for (const [id, delivery] of [["guide-1", "guide"], ["user-2", "queue"]] as const) {
      f.ingest(f.log.push(SessionEventType.TurnSteerQueued, {
        pendingInputId: id, input: "next", inputPreview: "next", inputSize: 4,
        delivery, targetTurnId: "runtime-1", queueLength: 1,
      }));
      f.ingest(f.log.push(SessionEventType.TurnSteerDrained, {
        pendingInputIds: [id], injectedMessageIds: [id],
        drainedInputs: [{ pendingInputId: id, messageId: id, text: "next", delivery }],
        targetTurnId: "runtime-1",
      }));
      expect(f.completed).toEqual(delivery === "guide" ? [] : [anchor]);
    }
    f.ingest(...f.log.answer("assistant-2"), f.log.complete());
    expect(f.completed).toEqual([anchor, { ...anchor, productTurnId: "user-2", assistantMessageId: "assistant-2" }]);
  });

  it.each(["interrupted", "error"])("does not publish %s completion", (result) => {
    const f = fixture();
    f.ingest(f.log.start(), ...f.log.answer(), f.log.complete(result));
    expect(f.completed).toEqual([]);
  });

  it("does not publish empty or unmapped answers, or nonregular sessions", () => {
    for (const [messageId, text, eligible] of [["assistant-1", "", true], ["", "answer", true], ["assistant-1", "answer", false]] as const) {
      const f = fixture({ isTurnFooterSessionEligible: () => eligible });
      f.ingest(f.log.start(), ...f.log.answer(messageId, text), f.log.complete());
      expect(f.completed).toEqual([]);
    }
  });

  it("history hydration and repeated history reads never publish live completion", async () => {
    const log = new Transcript();
    log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
    log.start(); log.answer(); log.complete();
    const f = fixture({ loadPersistedEvents: async () => ({ events: log.events, synthesized: true }) });
    await f.gateway.subscribe({ topic: "conversation/session-1", connectionId: "history", clientMode: "desktop-continuous" });
    await f.gateway.rowsRange({ sessionId: "session-1", limit: 100 });
    expect(f.completed).toEqual([]);
  });
});

describe("turn footer bounded reads and generation", () => {
  it("resolves only the latest eligible assistant via the persistent mapping", async () => {
    const f = fixture(); f.reply();
    const page = await f.gateway.rowsRange({ sessionId: "session-1", limit: 100 });
    const row = page.rows.find((row) => row.kind === "assistantText");
    expect(row).toBeDefined();
    const input = { workspacePath: "/work", sessionId: "session-1", rowId: row!.rowId };
    expect(await f.gateway.resolveTurnFooterAnchor(input)).toEqual(anchor);
    expect(await f.gateway.resolveTurnFooterAnchor({ ...input, rowId: 999 })).toBeNull();
    f.ingest(f.log.start("user-2", "runtime-2"));
    expect(await f.gateway.resolveTurnFooterAnchor(input)).toBeNull();
  });

  it("history stops at the original reply, excluding hidden content and future input", () => {
    const history = readBoundedTurnFooterHistory([
      message("user-1", "user", "question"),
      { ...message("hidden", "user", "secret reminder"), info: { ...message("hidden", "user", "").info, synthetic: true } },
      message("assistant-1", "assistant", "answer"),
      message("future", "user", "must not leak"),
    ], anchor);
    expect(history).toEqual([{ role: "user", text: "question" }, { role: "assistant", text: "answer" }]);
  });

  it("history is limited to 40 text rows and 24000 aggregate characters", () => {
    const history = readBoundedTurnFooterHistory([
      ...Array.from({ length: 60 }, (_, index) => message(`earlier-${index}`, index % 2 ? "assistant" : "user", "a".repeat(700))),
      message("assistant-1", "assistant", "final answer"),
    ], anchor);
    expect(history.length).toBeLessThanOrEqual(40);
    expect(history.reduce((total, row) => total + row.text.length, 0)).toBe(24_000);
    expect(history.at(-1)).toEqual({ role: "assistant", text: "final answer" });
  });

  it("calls the standalone runtime once and does not admit a chat input", async () => {
    const calls: unknown[] = [];
    const f = fixture({ generateTurnFooterText: async (sessionId, input) => {
      calls.push({ sessionId, ...input });
      return { status: "ok", text: "generated", model: { providerId: "fixture", modelId: "model-1" } };
    } });
    f.reply();
    const result = await f.gateway.generateTurnFooterText({ workspacePath: "/work", ...anchor, text: "bounded request", maxOutputTokens: 1600 });
    expect(result).toEqual({ status: "ok", text: "generated", model: { providerId: "fixture", modelId: "model-1" } });
    expect(calls).toEqual([{ sessionId: "session-1", text: "bounded request", maxOutputTokens: 1600 }]);
    expect(f.executed).toEqual([]);
    f.ingest(f.log.start("user-2", "runtime-2"));
    expect(await f.gateway.generateTurnFooterText({ workspacePath: "/work", ...anchor, text: "bounded request", maxOutputTokens: 1600 }))
      .toMatchObject({ status: "ok", text: "generated" });
    expect(calls).toHaveLength(2);
  });

  it("reserves context for the recent user task when the final reply alone exhausts the budget", () => {
    const history = readBoundedTurnFooterHistory([message("user-1", "user", "critical recent task"), message("assistant-1", "assistant", "a".repeat(30_000))], anchor);
    expect(history[0]).toEqual({ role: "user", text: "critical recent task" });
    expect(history.at(-1)?.role).toBe("assistant");
    expect(history.reduce((sum, row) => sum + row.text.length, 0)).toBe(24_000);
  });

  it("reads and generates for the original stable anchor after queue split, without future input", async () => {
    const f = fixture({
      loadPersistedMessages: async () => [message("user-1", "user", "question"), message("assistant-1", "assistant", "answer"), message("user-2", "user", "future")],
      generateTurnFooterText: async () => ({ status: "ok", text: "generated", model: { providerId: "fixture", modelId: "model-1" } }),
    });
    f.ingest(f.log.start(), ...f.log.answer());
    f.ingest(f.log.push(SessionEventType.TurnSteerQueued, { pendingInputId: "q2", input: "future", delivery: "queue", targetTurnId: "runtime-1", queueLength: 1 }));
    f.ingest(f.log.push(SessionEventType.TurnSteerDrained, { pendingInputIds: ["q2"], injectedMessageIds: ["user-2"], drainedInputs: [{ pendingInputId: "q2", messageId: "user-2", text: "future", delivery: "queue" }], targetTurnId: "runtime-1" }));
    expect(await f.gateway.readTurnFooterHistory({ workspacePath: "/work", ...anchor })).toEqual([{ role: "user", text: "question" }, { role: "assistant", text: "answer" }]);
    expect(await f.gateway.generateTurnFooterText({ workspacePath: "/work", ...anchor, text: "request", maxOutputTokens: 200 })).toMatchObject({ status: "ok" });
    expect(await f.gateway.handleCommand(send("split-old-footer"))).toMatchObject({ status: "stale" });
  });

  it.each(["retry", "edit"])("excludes append-only abandoned history after %s branch cut", (kind) => {
    const messages = [message("user-1", "user", "old question"), message("old-assistant", "assistant", "old answer"), message("new-user", "user", "edited question"), message("assistant-1", "assistant", "new answer")];
    const options = {
      rewindTargetMessageId: (kind === "retry" ? messages[1]!.info.id : messages[0]!.info.id),
      rewindKeptMessageIds: kind === "retry" ? [messages[0]!.info.id] : [],
      branchCutAfterMessageId: messages[1]!.info.id,
    };
    expect(readBoundedTurnFooterHistory(messages, anchor, options)).toEqual([
      ...(kind === "retry" ? [{ role: "user", text: "old question" }] : []),
      { role: "user", text: "edited question" }, { role: "assistant", text: "new answer" },
    ]);
    expect(readBoundedTurnFooterHistory(messages, { ...anchor, assistantMessageId: "old-assistant" }, options)).toEqual([]);
  });

  it("rejects empty and excessive model requests before invoking runtime", async () => {
    let calls = 0;
    const f = fixture({ generateTurnFooterText: async () => { calls += 1; return { status: "failed", code: "unexpected" }; } });
    f.reply();
    for (const extra of [{ text: " " }, { text: "a".repeat(24_001) }, { maxOutputTokens: 1601 }]) {
      await expect(f.gateway.generateTurnFooterText({ workspacePath: "/work", ...anchor, text: "request", maxOutputTokens: 1600, ...extra })).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
});

function message(id: string, role: "user" | "assistant", text: string): MessageWithParts {
  const common = { id, sessionID: "session-1", time: { created: 1 } };
  return {
    info: role === "user" ? { ...common, role, agent: "default" } : {
      ...common, role, parentID: "user-1", mode: "default", agent: "default",
      path: { cwd: "/work", root: "/work" }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `part-${id}`, messageID: id, sessionID: "session-1", type: "text", text }],
  } as MessageWithParts;
}

describe("turn footer serial input admission", () => {
  it("accepts the matching anchor once through native sendText, preserving slash text", async () => {
    const f = fixture(); f.reply();
    const first = await f.gateway.handleCommand(send("footer-1"));
    const duplicate = await f.gateway.handleCommand(send("footer-1"));
    expect(first.status).toBe("accepted");
    expect(["accepted", "duplicate"]).toContain(duplicate.status);
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0]).toMatchObject({ type: "sendText", payload: { text: "/goal literal suggestion" } });
  });

  it("rejects an old reply before durable input admission", async () => {
    let admitted = 0;
    const f = fixture({ admitCommandInput: async () => { admitted += 1; return null; } });
    f.reply();
    f.ingest(f.log.start("user-2", "runtime-2"));
    const ack = await f.gateway.handleCommand(send("footer-stale"));
    expect(ack).toMatchObject({ status: "stale", reasonCode: "guard.turnFooterAnchorStale" });
    expect(admitted).toBe(0);
    expect(f.executed).toEqual([]);
  });

  it("rejects while another accepted input is pending before its TurnStarted", async () => {
    const f = fixture(); f.reply();
    f.gateway.admitPendingInput("session-1", { ...send("pending-manual"), payload: { text: "manual" } }, 1);
    expect(await f.gateway.handleCommand(send("pending-footer"))).toMatchObject({ status: "stale", reasonCode: "guard.turnFooterAnchorStale" });
    expect(f.executed).toEqual([]);
  });

  it("rechecks the expected anchor after waiting for actual CommandInbox serial admission", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = fixture({ executeCommand: async (envelope) => {
      if (envelope.commandId === "earlier") { entered(); await waiting; }
    } });
    f.reply();
    const earlier = f.gateway.handleCommand({ ...send("earlier"), payload: { text: "manual input" } });
    await started;
    const footer = f.gateway.handleCommand(send("late-footer"));
    f.ingest(f.log.start("user-2", "runtime-2"));
    release();
    await earlier;
    expect(await footer).toMatchObject({ status: "stale", reasonCode: "guard.turnFooterAnchorStale" });
  });
});
