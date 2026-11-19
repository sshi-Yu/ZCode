import type {
  DynamicWorkflowClientConfig,
  ForceUpdateConfig,
  RequestVerificationConfig,
  ZCodeModelContextBudgetStrategy,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 与交易/营销解耦的公共运行配置读取（docs/superpowers/specs/2026-11-19-personal-workbench-backend-contracts.md）。
 *
 * 只委托同一 Host 装配内已有的 Coding Plan provider 实例：client/configs 快照缓存、
 * 1h TTL、in-flight 合并、账号/endpoint 变化失效、迟到响应不覆盖新身份等规则都由该
 * provider 唯一持有，本服务不另建缓存或请求。
 */
export interface IRuntimeConfigService {
  /**
   * 动态工作流灰度快照：远端 `configs.dynamicWorkflow.mode` 与本地覆盖折叠后的结果。
   * forceRefresh 绕过快照缓存；请求失败 fail-closed（disabled/default），不向调用方抛错。
   * 用户设置覆盖只在拥有设置权威的装配注入（沿用原 ICodingPlanSubscriptionService 语义）。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** 兼容接口：固定返回 preflight-v1，不读取远端配置或缓存。 */
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
  /**
   * 请求校验配置；HTTP 成功但配置无效时抛错（不自动重试、不放开跳过校验）。
   */
  getRequestVerificationConfig(): Promise<RequestVerificationConfig | null>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
}

export const IRuntimeConfigService = createServiceDescriptor<IRuntimeConfigService>(
  ServiceChannels.RuntimeConfig,
);
