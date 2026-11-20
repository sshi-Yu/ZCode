import { ModelRequestRedispatchPolicy, type ModelRetryBudget } from "@zcode/contracts";
import { resolveRetryOptionsForBudget, SINGLE_ATTEMPT_MAX_ATTEMPTS } from "./retry-budget.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

/**
 * 请求级 no-redispatch 策略的判定（contracts `ModelRequestRedispatchPolicy`）。
 *
 * 「single-attempt」预算只收敛 maxAttempts；runner-generate 的鉴权刷新重试、anthropic
 * thinking 签名修复重试与 off-peak 排队重试都在预算之外追加物理请求（见 runner-generate.ts
 * 失败分支）。对「一次受理最多发起一次独立请求」的能力（NextStep 轮尾生成），只有本策略能把
 * 物理发送次数钉死在 1：首次失败即上抛，由调用方按 errorPhase 归为 failed / unknown，
 * 等待用户手动刷新，绝不自动重发。
 */
export function isNoRedispatchRequest(request: {
  modelRequestRedispatchPolicy?: ModelRequestRedispatchPolicy;
}): boolean {
  return request.modelRequestRedispatchPolicy === ModelRequestRedispatchPolicy.NoRedispatch;
}

/**
 * 按请求解析实际生效的 retry 选项：no-redispatch 隐含 single-attempt（瞬态退避同样首败即抛），
 * 其余预算档位语义不变。
 */
export function resolveRetryOptionsForRequest(
  retry: ResolvedAiSdkModelRetryOptions,
  request: {
    modelRetryBudget?: ModelRetryBudget;
    modelRequestRedispatchPolicy?: ModelRequestRedispatchPolicy;
  },
): ResolvedAiSdkModelRetryOptions {
  if (isNoRedispatchRequest(request)) {
    return { ...retry, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS };
  }
  return resolveRetryOptionsForBudget(retry, request.modelRetryBudget);
}
