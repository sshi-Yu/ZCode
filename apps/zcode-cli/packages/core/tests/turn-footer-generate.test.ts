import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { getCurrentModelInvocationContext, type ModelStatusSink } from "@zcode/contracts";
import {
  generateTurnFooterText,
  TURN_FOOTER_GENERATE_DEADLINE_MS,
} from "../src/runtime/methods/turn-footer-generate.js";
import { createModelStatusSink } from "../src/runtime/methods/model-status.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const TEXT = "用户问好，助手回答了。请给出后续建议。";

function fixture() {
  const usage = vi.fn(async () => {});
  const generateText = vi.fn(async (_request: unknown) => ({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 8 },
  }));
  const model = {
    providerId: "fixture",
    modelId: "math",
    properties: { inputFormat: { supportsText: true, supportsImage: true } },
    optionSpecs: { maxOutputTokens: { max: 100 } },
    options: {},
    generateText,
    streamText: vi.fn(),
    bind: vi.fn(),
  };
  const runtime = {
    config: { mode: "plan", taskType: "interactive" },
    sessionId: "task",
    sessionFeatures: new Set(),
    rootTraceContext: { traceId: "trace", spanId: "parent" },
    modelFactory: vi.fn(() => model),
    getSessionModelSelection: vi.fn(() => ({ providerId: "fixture", modelId: "math" })),
    ensureSessionPersisted: vi.fn(async () => {}),
    appendEvent: vi.fn(),
    logModelNetworkStatus: vi.fn(),
    createEvent: vi.fn((type, payload) => ({ type, payload, timestamp: new Date() })),
    createModelStatusSink,
    extractToolCallsFromResult: vi.fn(() => []),
    sessionStore: {
      recordModelUsage: usage,
      upsertTurnUsage: vi.fn(),
      upsertToolUsage: vi.fn(),
    },
  } as unknown as AgentRuntimeInternal;
  return { runtime, model, usage, generateText };
}

/** AiSdkModelAdapterError 的结构化形状（core 不直接依赖 adapters 包）。 */
function adapterError(input: { code: string; reason: string; errorPhase: string }): Error {
  return Object.assign(new Error(input.code), {
    name: "AiSdkModelAdapterError",
    code: input.code,
    context: { reason: input.reason, errorPhase: input.errorPhase },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("generateTurnFooterText", () => {
  it("is bound on the public AgentRuntime prototype", () => {
    expect(AgentRuntime.prototype.generateTurnFooterText).toBe(generateTurnFooterText);
  });

  it("freezes provider and model before persistence yields to a session switch", async () => {
    const f = fixture();
    let persist!: () => void;
    f.runtime.ensureSessionPersisted = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          persist = resolve;
        }),
    );
    const pending = generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 });
    expect(f.runtime.modelFactory).toHaveBeenCalledTimes(1);
    vi.mocked(f.runtime.getSessionModelSelection).mockReturnValue({
      providerId: "other",
      modelId: "changed",
    } as never);
    persist();
    expect(await pending).toMatchObject({
      status: "ok",
      model: { providerId: "fixture", modelId: "math" },
    });
    expect(f.runtime.modelFactory).toHaveBeenCalledTimes(1);
  });

  it("returns failed without a model call when already cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateTurnFooterText.call(
        f.runtime,
        { text: TEXT, maxOutputTokens: 10 },
        { abortSignal: controller.signal },
      ),
    ).resolves.toEqual({ status: "failed", code: "cancelled" });
    expect(f.generateText).not.toHaveBeenCalled();
  });

  it("bounds an uncooperative provider to the deadline and ignores late completion", async () => {
    const f = fixture();
    let complete!: (value: {
      text: string;
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }) => void;
    f.generateText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const deadline = new AbortController();
    timeout.mockReturnValueOnce(deadline.signal);
    const pending = generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 });
    await vi.waitFor(() => expect(f.generateText).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(TURN_FOOTER_GENERATE_DEADLINE_MS);
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 50)),
    ]);
    expect(outcome).toEqual({ status: "unknown", code: "timeout" });
    complete({ text: "late", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } });
    expect(f.usage).toHaveBeenCalledTimes(1);
    expect(f.runtime.appendEvent).not.toHaveBeenCalled();
  });

  it("treats an unstructured error after invocation as unknown and sanitizes its code", async () => {
    const f = fixture();
    f.generateText.mockRejectedValueOnce(
      Object.assign(new Error("private transport details"), { code: "private-credential-text" }),
    );
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "unknown", code: "model_error" });
  });

  it("generates once with the frozen session model and returns the shared ok shape", async () => {
    const f = fixture();
    let seenContext: ReturnType<typeof getCurrentModelInvocationContext>;
    f.generateText.mockImplementationOnce(async (request: unknown) => {
      seenContext = getCurrentModelInvocationContext();
      expect((request as { abortSignal?: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
      return { text: "ok", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 8 } };
    });
    const result = await generateTurnFooterText.call(
      f.runtime,
      { text: TEXT, maxOutputTokens: 1600 },
      { traceContext: { traceId: "trace", spanId: "parent" } },
    );
    expect(result).toEqual({
      status: "ok",
      text: "ok",
      model: { providerId: "fixture", modelId: "math" },
    });
    expect(f.generateText).toHaveBeenCalledTimes(1);
    expect(f.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: TEXT }],
        // 请求预算受共享 schema 与模型上限双重约束。
        options: { maxOutputTokens: 100 },
      }),
    );
    // 模型与策略都在第一个 await 前冻结；no-redispatch + single-attempt 必须到达 adapter。
    expect(f.runtime.modelFactory).toHaveBeenCalledWith({
      selection: { providerId: "fixture", modelId: "math" },
    });
    expect(seenContext!.modelRequestRedispatchPolicy).toBe("no-redispatch");
    expect(seenContext!.modelRetryBudget).toBe("single-attempt");
    // 独立文本生成：不写会话消息、不创建 turn、不携带工具。
    expect(f.runtime.appendEvent).not.toHaveBeenCalled();
    expect(f.generateText.mock.calls[0]![0]).not.toHaveProperty("tools");
    expect(f.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        querySource: "nextstep_turn_footer",
        status: "completed",
        sessionID: "task",
        outputTokens: 8,
      }),
    );
  });

  it.each([
    ["text over 24000 chars", { text: "a".repeat(24_001), maxOutputTokens: 100 }],
    ["blank text", { text: "   ", maxOutputTokens: 100 }],
    ["zero output budget", { text: TEXT, maxOutputTokens: 0 }],
    ["budget over 1600", { text: TEXT, maxOutputTokens: 1601 }],
    ["fractional budget", { text: TEXT, maxOutputTokens: 1.5 }],
  ])("fails definitively on invalid input: %s", async (_name, input) => {
    const f = fixture();
    const result = await generateTurnFooterText.call(f.runtime, input);
    expect(result).toEqual({ status: "failed", code: "invalid_input" });
    // 校验失败发生在发送前：一次物理请求都不允许。
    expect(f.generateText).not.toHaveBeenCalled();
    expect(f.usage).not.toHaveBeenCalled();
  });

  it("maps pre-send failures to failed and post-send uncertain transport failures to unknown", async () => {
    const f = fixture();
    f.generateText.mockRejectedValueOnce(
      adapterError({
        code: "model_request_auth_missing",
        reason: "provider_not_configured",
        errorPhase: "prepare",
      }),
    );
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "failed", code: "model_request_auth_missing" });

    f.generateText.mockRejectedValueOnce(
      adapterError({ code: "model_request_timeout", reason: "timeout", errorPhase: "response" }),
    );
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "unknown", code: "model_request_timeout" });

    f.generateText.mockRejectedValueOnce(
      adapterError({
        code: "model_request_failed",
        reason: "network_error",
        errorPhase: "response",
      }),
    );
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "unknown", code: "model_request_failed" });

    // provider 明确拒绝（有 status 的响应）是确定事实，不是不确定传输。
    f.generateText.mockRejectedValueOnce(
      adapterError({ code: "model_request_failed", reason: "auth_failed", errorPhase: "response" }),
    );
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "failed", code: "model_request_failed" });
    // 每个分支都只发起一次请求，失败也不自动重试。
    expect(f.generateText).toHaveBeenCalledTimes(4);
    expect(f.usage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "error", querySource: "nextstep_turn_footer" }),
    );
  });

  it("treats caller abort as unknown (provider receipt unknown) and stops waiting", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.generateText.mockImplementationOnce(
      (request: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          setTimeout(() => controller.abort(), 0);
        }),
    );
    const result = await generateTurnFooterText.call(
      f.runtime,
      { text: TEXT, maxOutputTokens: 10 },
      { abortSignal: controller.signal },
    );
    expect(result).toEqual({ status: "unknown", code: "cancelled" });
    expect(f.generateText).toHaveBeenCalledTimes(1);
    expect(f.usage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", querySource: "nextstep_turn_footer" }),
    );
  });

  it("rejects completions that did not produce plain text", async () => {
    const f = fixture();
    f.generateText.mockResolvedValueOnce({
      text: "partial",
      finishReason: "tool-calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "failed", code: "invalid_output" });

    f.runtime = {
      ...f.runtime,
      extractToolCallsFromResult: vi.fn(() => [{ id: "t1", name: "Tool", input: {} }]),
    } as unknown as AgentRuntimeInternal;
    f.generateText.mockResolvedValueOnce({
      text: "called a tool",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "failed", code: "invalid_output" });

    f.runtime.extractToolCallsFromResult = vi.fn(() => []);
    f.generateText.mockResolvedValueOnce({
      text: "x".repeat(16_001),
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "failed", code: "output_too_long" });
    expect(f.generateText).toHaveBeenCalledTimes(3);
  });

  it("fails definitively when the frozen session model cannot serve text input", async () => {
    const f = fixture();
    (f.model.properties.inputFormat as { supportsText: boolean }).supportsText = false;
    expect(
      await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 }),
    ).toEqual({ status: "failed", code: "model_text_unsupported" });
    expect(f.generateText).not.toHaveBeenCalled();
  });

  it("releases status publishing after completion", async () => {
    const f = fixture();
    let sink: ModelStatusSink | undefined;
    f.generateText.mockImplementationOnce(async () => {
      sink = getCurrentModelInvocationContext()?.statusSink;
      return { text: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await generateTurnFooterText.call(f.runtime, { text: TEXT, maxOutputTokens: 10 });
    expect(sink).toBeDefined();
    await sink!.publish({ type: "model_request_started", attempt: 1 } as never);
    expect(f.runtime.logModelNetworkStatus).not.toHaveBeenCalled();
  });
});
