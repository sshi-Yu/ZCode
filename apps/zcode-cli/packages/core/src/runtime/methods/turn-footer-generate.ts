import {
  ModelErrorCode,
  ModelProtocolError,
  ModelRequestRedispatchPolicy,
  ModelRetryBudget,
} from "@zcode/contracts";
import {
  turnFooterGenerateInputSchema,
  type TurnFooterGenerateResult,
} from "@zcode/shared/extension-host";
import {
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
  type Model,
  type SessionEvent,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "./runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";

export const TURN_FOOTER_GENERATE_QUERY_SOURCE = "nextstep_turn_footer";
export const TURN_FOOTER_GENERATE_DEADLINE_MS = 30_000;
const MAX_RESULT_CHARS = 16_000;
// permit 的授权归宿主；runtime 仍独立验证文本及预算，与共享契约保持一致。
const inputSchema = turnFooterGenerateInputSchema.omit({ permit: true });
const MODEL_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ModelErrorCode));
const UNCERTAIN_REASONS = new Set([
  "timeout",
  "network_error",
  "proxy_error",
  "stale_connection",
  "stream_idle_timeout",
  "tls_error",
  "unknown",
  "cancelled",
]);

export interface GenerateTurnFooterTextInput {
  text: string;
  maxOutputTokens: number;
}

/** 独立文本生成：会话模型 owner 不变，不创建消息/轮次/工具；仅记录独立用量。 */
export async function generateTurnFooterText(
  this: AgentRuntimeInternal,
  input: GenerateTurnFooterTextInput,
  options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
): Promise<TurnFooterGenerateResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { status: "failed", code: "invalid_input" };
  if (options?.abortSignal?.aborted) return { status: "failed", code: "cancelled" };

  let model: Model;
  try {
    // 首个 await 前冻结当前活会话 provider、model 及选项；之后切模型不得改变本次请求，也不回退。
    model = createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
      retryBudget: ModelRetryBudget.SingleAttempt,
    });
  } catch (error) {
    return { status: "failed", code: safeErrorCode(error, "model_unavailable") };
  }
  if (!model.properties.inputFormat.supportsText) {
    return { status: "failed", code: "model_text_unsupported" };
  }
  const frozenModel = { providerId: String(model.providerId), modelId: String(model.modelId) };
  const traceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    attributes: { querySource: TURN_FOOTER_GENERATE_QUERY_SOURCE, ...frozenModel },
  });
  // 时限从首个 await 前开始，覆盖持久化、准入、鉴权、provider 以及用量落盘等待。
  const deadlineSignal = AbortSignal.timeout(TURN_FOOTER_GENERATE_DEADLINE_MS);
  const signal = options?.abortSignal
    ? AbortSignal.any([options.abortSignal, deadlineSignal])
    : deadlineSignal;
  const events: SessionEvent[] = [];
  using statusSink = this.createModelStatusSink(traceContext, events, { persist: false });
  const startedAt = Date.now();
  let result: Awaited<ReturnType<Model["generateText"]>> | undefined;
  let error: unknown;
  let generationInvoked = false;
  let outcome: TurnFooterGenerateResult;
  try {
    // 成功轮尾通常已持久化；这里只保证独立用量有对应 session，不写入提示词或聊天事件。
    await waitOrAbort(this.ensureSessionPersisted("Turn footer generation", traceContext), signal);
    signal.throwIfAborted();
    result = await waitOrAbort(
      runWithModelInvocationContext(
        {
          // 不保存独立生成提示词到模型 transcript/debug 请求正文。
          metadata: { ...traceContextToLogContext(traceContext), skipTranscript: true },
          modelCall: { operation: "workspace_generate_text" },
          modelRequestRedispatchPolicy: ModelRequestRedispatchPolicy.NoRedispatch,
          statusSink,
          traceContext,
          refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
            abortSignal: signal,
            model,
            traceContext,
          }),
        },
        () => {
          generationInvoked = true;
          return model.generateText({
            abortSignal: signal,
            messages: [{ role: "user", content: parsed.data.text }],
            options: {
              maxOutputTokens: Math.min(
                parsed.data.maxOutputTokens,
                model.optionSpecs.maxOutputTokens.max,
              ),
            },
          });
        },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (
      (result.finishReason !== "stop" && result.finishReason !== "length") ||
      typeof result.text !== "string" ||
      this.extractToolCallsFromResult(result).length > 0
    ) {
      outcome = { status: "failed", code: "invalid_output" };
    } else if (result.text.length > MAX_RESULT_CHARS) {
      outcome = { status: "failed", code: "output_too_long" };
    } else {
      outcome = { status: "ok", text: result.text, model: frozenModel };
    }
    if (outcome.status !== "ok") error = new Error(outcome.code);
  } catch (caught) {
    outcome = classifyFailure(caught, {
      generationInvoked,
      signal,
      deadlineSignal,
    });
    // 只记录安全错误码；provider 错误文本可能带请求正文，不能落入插件生成的历史。
    error = new Error(outcome.status === "ok" ? "model_error" : outcome.code);
  }
  // 不让落盘/迟到 provider 阻塞显式 deadline；既有 recordModelUsageFact 自身处理落盘错误。
  await waitOrAbort(
    recordModelUsageFact(this, {
      events,
      model,
      networkEventStartIndex: 0,
      querySource: TURN_FOOTER_GENERATE_QUERY_SOURCE,
      result,
      startedAt,
      status: signal.aborted ? "cancelled" : error ? "error" : "completed",
      error,
      traceContext,
    }),
    signal,
  ).catch(() => undefined);
  return outcome;
}

function safeErrorCode(error: unknown, fallback = "model_error"): string {
  if (!error || typeof error !== "object" || !("code" in error)) return fallback;
  return typeof error.code === "string" && MODEL_ERROR_CODES.has(error.code)
    ? error.code
    : fallback;
}

function classifyFailure(
  error: unknown,
  input: { generationInvoked: boolean; signal: AbortSignal; deadlineSignal: AbortSignal },
): TurnFooterGenerateResult {
  const code = safeErrorCode(error);
  const record =
    error && typeof error === "object"
      ? (error as {
          context?: { errorPhase?: string; reason?: string; statusCode?: number; source?: string };
        })
      : undefined;
  const context = record?.context;
  const beforeSend =
    !input.generationInvoked ||
    context?.errorPhase === "prepare" ||
    context?.errorPhase === "connect" ||
    context?.errorPhase === "configuration" ||
    (error instanceof ModelProtocolError && error.code !== ModelErrorCode.InvalidModelResponse);
  if (input.signal.aborted) {
    return {
      status: beforeSend ? "failed" : "unknown",
      code: input.deadlineSignal.aborted ? "timeout" : "cancelled",
    };
  }
  if (beforeSend) return { status: "failed", code };
  // 没有结构化发送前证据，未知错误必须保守记 unknown；明确 provider 拒绝则已知失败。
  if (
    context &&
    (typeof context.statusCode === "number" ||
      (context.reason !== undefined && !UNCERTAIN_REASONS.has(context.reason)))
  ) {
    return { status: "failed", code };
  }
  return { status: "unknown", code };
}

/** AbortSignal 是本地等待边界；provider 或端口不响应取消时也必须及时结算，迟到结果不接管。 */
function waitOrAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
