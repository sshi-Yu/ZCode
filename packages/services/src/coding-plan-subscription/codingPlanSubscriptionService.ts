import type { OAuthAccountMaterial } from "#src/oauth/repo/oauthCredentialRepo.js";
import { applyDynamicWorkflowUserMode, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createRetiredCodingPlanSubscriptionService, type ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import type { IRuntimeConfigService } from "../runtime-config/contract.js";
import type { IAccountModelProjectsService } from "../account-model-projects/contract.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  loadOAuthAccountMaterial: (family: "zai" | "bigmodel") => Promise<OAuthAccountMaterial | null>;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  /**
   * 用户在设置里选的动态工作流模式（launch.md「The user's choice」）。只有拥有设置权威的装配
   * （desktop 本地 Host、web/standalone server）注入；缺省时快照只含服务端的「提供」。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

/**
 * 个人工作台商业服务拆除（docs/superpowers/specs/2026-11-19-personal-workbench-backend-contracts.md）：
 * 原 service 混合了交易动作与公共运行配置/账号项目读取。本工厂仍是这组能力的唯一装配点，
 * 一次创建 bigmodel/zai 两个 provider 实例，随后暴露三个服务面：
 *
 * - runtimeConfigService / accountModelProjectsService：保留能力的窄接口，直接委托原 provider，
 *   缓存、失败语义、family 路由与项目 Key 准备完全复用原实现，不另建缓存或请求。
 * - codingPlanSubscriptionService（legacy）：旧 RPC 兼容面。已退役的商业动作统一
 *   reject `commercial_service_unsupported`，不读取凭据、不发云请求、不返回空成功；
 *   保留读取（runtime config / OffPeak 配置 / 已有账号项目 pricing）委托窄服务同一实现。
 *
 * 其余说明见各方法注释；zai/bigmodel enterprise 读路径按 request.family 路由，缺省 bigmodel。
 */
export function createCodingPlanSubscriptionServices(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): {
  codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  runtimeConfigService: IRuntimeConfigService;
  accountModelProjectsService: IAccountModelProjectsService;
} {
  const bigmodelProvider = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zaiProvider = new ZaiCodingPlanSubscriptionProvider(dependencies);

  // 按 family 选择 enterprise 读路径 provider；缺省（含未指定 family 的历史调用）走 bigmodel。
  const resolveEnterprisePricingProvider = (
    family?: "bigmodel" | "zai",
  ): BigModelCodingPlanSubscriptionProvider => (family === "zai" ? zaiProvider : bigmodelProvider);

  const runtimeConfigService: IRuntimeConfigService = {
    // 动态工作流灰度：与 client/configs 同源，固定走 bigmodel provider（与 family 无关）。
    // 用户选择在这里套到「提供」上，renderer 读到的就是生效值；规则只写在 shared 的
    // applyDynamicWorkflowUserMode 里，renderer 不自己算。
    getDynamicWorkflowClientConfig: async (options) => {
      const offer = await bigmodelProvider.getDynamicWorkflowClientConfig(options);
      const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
      return resolveUserMode ? applyDynamicWorkflowUserMode(offer, await resolveUserMode()) : offer;
    },
    getModelContextBudgetStrategy: () => bigmodelProvider.getModelContextBudgetStrategy(),
    getRequestVerificationConfig: () => bigmodelProvider.getRequestVerificationConfig(),
    getForceUpdateConfig: () => bigmodelProvider.getForceUpdateConfig(),
  };

  const accountModelProjectsService: IAccountModelProjectsService = {
    getEnterprisePricing: (request) =>
      resolveEnterprisePricingProvider(request?.family).getEnterprisePricing(request),
  };

  const codingPlanSubscriptionService = createRetiredCodingPlanSubscriptionService({
    getOffPeakClientConfig: (options) => bigmodelProvider.getOffPeakClientConfig(options),
    ...runtimeConfigService,
    ...accountModelProjectsService,
  });

  return { codingPlanSubscriptionService, runtimeConfigService, accountModelProjectsService };
}

/**
 * 兼容旧装配入口：只取 legacy 服务面。新装配请改用 createCodingPlanSubscriptionServices，
 * 以获得同一 provider 实例上的 runtimeConfigService / accountModelProjectsService 窄接口。
 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  return createCodingPlanSubscriptionServices(dependencies).codingPlanSubscriptionService;
}
