import { describe, expect, it } from "vitest";
import {
  ModelRequestRedispatchPolicy,
  ModelRetryBudget,
  type ModelNetworkStatusEvent,
} from "@zcode/contracts";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";
import { executeAdapterGenerateText } from "./test-adapter-model.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { AiSdkModelAdapterError } from "../src/model/errors.js";

// docs/superpowers/specs/2026-11-20-nextstep-turn-footer-design.md「最小扩展契约」：
// 每个已受理版本最多发起一次独立请求，也不启用会使已发出请求重放的底层重试。
// 这里用可计数的 runtime 模拟 provider transport，断言 no-redispatch 策略下**物理发送次数**。
const RETRY = { baseDelayMs: 0, jitter: false, maxAttempts: 3, maxDelayMs: 0 };
const NO_REDISPATCH = { modelRequestRedispatchPolicy: ModelRequestRedispatchPolicy.NoRedispatch };

describe("AiSdkModelAdapter with modelRequestRedispatchPolicy = no-redispatch", () => {
  it("takes priority over an unbounded workflow retry budget", async () => {
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        if (attempts === 1) throw apiError("overloaded", { isRetryable: true, statusCode: 503 });
        return { text: "must not redispatch", finishReason: "stop", usage: usage(1, 1) } as never;
      }),
    });
    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        modelRetryBudget: ModelRetryBudget.Unbounded,
        ...NO_REDISPATCH,
      }),
    ).rejects.toMatchObject({ context: { maxAttempts: 1, attempt: 1 } });
    expect(attempts).toBe(1);
  });

  it("sends exactly one physical request on the happy path", async () => {
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        return { text: "ok", finishReason: "stop", usage: usage(1, 1) } as never;
      }),
    });
    const result = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      ...NO_REDISPATCH,
    });
    expect(result.text).toBe("ok");
    expect(attempts).toBe(1);
  });

  it("does not redispatch after a transient failure (default budget would retry)", async () => {
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        throw apiError("overloaded", { isRetryable: true, statusCode: 529 });
      }),
    });
    const rejection = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      ...NO_REDISPATCH,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
    expect((rejection as AiSdkModelAdapterError).context).toMatchObject({
      attempt: 1,
      maxAttempts: 1,
    });
    expect(attempts).toBe(1);

    // 同一失败在默认策略下会耗尽全部退避预算。
    let defaultAttempts = 0;
    const defaultAdapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        defaultAttempts += 1;
        throw apiError("overloaded", { isRetryable: true, statusCode: 529 });
      }),
    });
    await expect(
      executeAdapterGenerateText(defaultAdapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
      }),
    ).rejects.toBeInstanceOf(AiSdkModelAdapterError);
    expect(defaultAttempts).toBe(RETRY.maxAttempts);
  });

  it("does not refresh account auth and resend after a project-token 401", async () => {
    // 默认策略：401 后刷新 PAT 再补发一次物理请求。
    let attempts = 0;
    const defaultAdapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        throw projectTokenRejection();
      }),
    });
    await expect(
      executeAdapterGenerateText(defaultAdapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        refreshRuntimeHeadersBeforeAttempt: async () => ({
          headersApplied: true,
          requestAuth: { apiKey: "pat", accountScope: "scope-a" },
        }),
      }),
    ).rejects.toBeInstanceOf(AiSdkModelAdapterError);
    expect(attempts).toBe(2);

    // no-redispatch：鉴权刷新重试也被禁止，第一次 401 即收口。
    let policyAttempts = 0;
    const policyAdapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        policyAttempts += 1;
        throw projectTokenRejection();
      }),
    });
    const rejection = await executeAdapterGenerateText(policyAdapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      refreshRuntimeHeadersBeforeAttempt: async () => ({
        headersApplied: true,
        requestAuth: { apiKey: "pat", accountScope: "scope-a" },
      }),
      ...NO_REDISPATCH,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
    expect(policyAttempts).toBe(1);
  });

  it("does not requeue an off-peak 429 into another dispatch", async () => {
    let attempts = 0;
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        throw apiError("queued", { isRetryable: true, statusCode: 429 });
      }),
    });
    const rejection = await executeAdapterGenerateText(adapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      accountMode: "off-peak",
      statusSink: { publish: (event) => void statusEvents.push(event) },
      ...NO_REDISPATCH,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(AiSdkModelAdapterError);
    expect(attempts).toBe(1);
    expect(statusEvents.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(0);
  });

  it("does not repair thinking history and resend after an anthropic signature rejection", async () => {
    // 默认策略：anthropic 签名拒绝会清理历史并补发一次不占预算的物理请求。
    let attempts = 0;
    const defaultAdapter = new AiSdkModelAdapter({
      registry: anthropicRegistry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        if (attempts === 1) throw signatureRejection();
        return { text: "repaired", finishReason: "stop", usage: usage(1, 1) } as never;
      }),
    });
    const recovered = await executeAdapterGenerateText(defaultAdapter, {
      providerId: "anthropic" as never,
      modelId: "model-a" as never,
      messages: signedReasoningMessages(),
    });
    expect(recovered.text).toBe("repaired");
    expect(attempts).toBe(2);

    // no-redispatch：签名修复重试被禁止，第一次 400 即上抛。
    let policyAttemptsCount = 0;
    const policyAdapter = new AiSdkModelAdapter({
      registry: anthropicRegistry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        policyAttemptsCount += 1;
        throw signatureRejection();
      }),
    });
    await expect(
      executeAdapterGenerateText(policyAdapter, {
        providerId: "anthropic" as never,
        modelId: "model-a" as never,
        messages: signedReasoningMessages(),
        ...NO_REDISPATCH,
      }),
    ).rejects.toBeInstanceOf(AiSdkModelAdapterError);
    expect(policyAttemptsCount).toBe(1);
  });

  it("does not retry a zero-output completion", async () => {
    // 默认策略：可疑零输出 completion 会重试一次。
    let attempts = 0;
    const defaultAdapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        if (attempts === 1) return { text: "", finishReason: "length" } as never;
        return { text: "done", finishReason: "stop", usage: usage(1, 1) } as never;
      }),
    });
    const recovered = await executeAdapterGenerateText(defaultAdapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
    });
    expect(recovered.text).toBe("done");
    expect(attempts).toBe(2);

    // no-redispatch：零输出也只保持一次物理发送，原样返回空文本。
    let policyAttemptsCount = 0;
    const policyAdapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        policyAttemptsCount += 1;
        return { text: "", finishReason: "length" } as never;
      }),
    });
    const empty = await executeAdapterGenerateText(policyAdapter, {
      providerId: "test" as never,
      modelId: "model-a" as never,
      messages: [{ role: "user", content: "Ping" }],
      ...NO_REDISPATCH,
    });
    expect(empty.text).toBe("");
    expect(policyAttemptsCount).toBe(1);
  });

  it("keeps the single-attempt budget semantics unchanged when the policy is absent", async () => {
    // 既有 single-attempt 预算（不带策略）行为不变：瞬态失败一次上抛。
    let attempts = 0;
    const adapter = new AiSdkModelAdapter({
      registry: registry(),
      retry: RETRY,
      runtime: generateRuntime(async () => {
        attempts += 1;
        throw apiError("rate limited", { isRetryable: true, statusCode: 429 });
      }),
    });
    await expect(
      executeAdapterGenerateText(adapter, {
        providerId: "test" as never,
        modelId: "model-a" as never,
        messages: [{ role: "user", content: "Ping" }],
        modelRetryBudget: ModelRetryBudget.SingleAttempt,
      }),
    ).rejects.toBeInstanceOf(AiSdkModelAdapterError);
    expect(attempts).toBe(1);
  });
});

function registry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      test: {
        kind: "custom",
        createLanguageModel: (modelId) => ({ modelId }) as never,
      },
    },
  });
}

function anthropicRegistry(): TestProviderConfigFixture {
  return new TestProviderConfigFixture({
    providers: {
      anthropic: {
        kind: "anthropic",
        createLanguageModel: (modelId) => ({ modelId }) as never,
      },
    },
  });
}

function generateRuntime(generateText: () => Promise<unknown>): AiSdkModelRuntime {
  return {
    generateText: generateText as never,
    streamText() {
      throw new Error("not used");
    },
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function apiError(message: string, options: { isRetryable: boolean; statusCode: number }): Error {
  return Object.assign(new Error(message), {
    isRetryable: options.isRetryable,
    statusCode: options.statusCode,
  });
}

/** 账号 PAT 被拒：401 且无 request-security 业务码正文（AccountRequestRetry 的补发条件）。 */
function projectTokenRejection(): Error {
  return Object.assign(new Error("project token rejected"), {
    statusCode: 401,
    responseStatus: 401,
  });
}

/** anthropic thinking 签名拒绝 400 的窄化文案（见 reasoning-history-normalization.ts）。 */
function signatureRejection(): Error {
  return Object.assign(new Error("Invalid `signature` in `thinking` block"), {
    statusCode: 400,
  });
}

/** 带已签名 thinking 块的历史：签名修复路径有可清理的块才会补发。 */
function signedReasoningMessages() {
  return [
    { role: "user" as const, content: "hi" },
    {
      role: "assistant" as const,
      content: [
        {
          type: "reasoning" as const,
          text: "thought",
          providerOptions: { anthropic: { signature: "sig-1" } },
        },
      ],
    },
    { role: "user" as const, content: "go on" },
  ];
}
