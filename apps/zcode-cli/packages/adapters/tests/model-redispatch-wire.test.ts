import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRequestRedispatchPolicy, runWithModelInvocationContext } from "@zcode/contracts";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";

// 使用生产 AI SDK（不注入 runtime），直接数 fetch 边界的物理发送，覆盖 SDK 内建重试。
afterEach(() => vi.unstubAllGlobals());

describe("no-redispatch provider transport", () => {
  it.each(["ok", "503", "401", "network"] as const)("sends once for %s", async (outcome) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      if (outcome === "network") throw new TypeError("fetch failed");
      if (outcome !== "ok") {
        return Response.json(
          { error: { message: "fixture rejection", type: "api_error" } },
          { status: Number(outcome) },
        );
      }
      return Response.json({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        created: 1,
        model: "model-a",
        choices: [
          { index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    });
    const adapter = new TestAiSdkModelAdapter({
      registry: new TestProviderConfigFixture({
        env: {},
        providers: {
          fixture: {
            kind: "openai-compatible",
            apiKey: "fake-key",
            baseURL: "https://provider.example.test/v1",
          },
        },
      }),
      retry: { baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxAttempts: 3 },
    });
    const model = adapter.createModel({
      providerId: "fixture",
      modelId: "model-a",
      options: { maxOutputTokens: 50 },
    });
    const pending = runWithModelInvocationContext(
      {
        modelRequestRedispatchPolicy: ModelRequestRedispatchPolicy.NoRedispatch,
        metadata: { querySource: "nextstep_turn_footer", skipTranscript: true },
      },
      () => model.generateText({ messages: [{ role: "user", content: "next steps" }] }),
    );
    if (outcome === "ok") await expect(pending).resolves.toMatchObject({ text: "done" });
    else await expect(pending).rejects.toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("x-zcode-query-source")).toBe("nextstep_turn_footer");
    const body = await requests[0]!.json();
    expect(body).not.toHaveProperty("modelRequestRedispatchPolicy");
    expect(body).not.toHaveProperty("tools");
  });
});
