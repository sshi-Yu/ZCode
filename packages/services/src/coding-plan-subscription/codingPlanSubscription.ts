import type {
  RequestVerificationConfig,
  CodingPlanAgreementResponse,
  CodingPlanBatchPreviewRequest,
  CodingPlanBatchPreviewResponse,
  CodingPlanCreateSignRequest,
  CodingPlanPaymentCheckRequest,
  CodingPlanPaymentCheckResponse,
  CodingPlanPendingOrderCheckRequest,
  CodingPlanPendingOrderCheckResponse,
  CodingPlanPaypalSetupTokenRequest,
  CodingPlanPaypalSetupTokenResponse,
  CodingPlanPaypalSubscribeRequest,
  CodingPlanPaypalSubscribeResponse,
  CodingPlanPaypalSupportRequest,
  CodingPlanPaypalSupportResponse,
  CodingPlanProductInfo,
  CodingPlanProductInfoRequest,
  CodingPlanBillingDiscountConfig,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanPreviewRequest,
  CodingPlanPreviewResponse,
  CodingPlanStripeBindRequest,
  CodingPlanStripeBindResponse,
  CodingPlanStripeCard,
  CodingPlanStripePayRequest,
  CodingPlanStripePayResponse,
  CodingPlanStripeUnbindRequest,
  CodingPlanUpdateSignRequest,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanCancelOrderRequest,
  EnterpriseCodingPlanCancelOrderResponse,
  EnterpriseCodingPlanBalanceResponse,
  EnterpriseCodingPlanContinuePayRequest,
  EnterpriseCodingPlanOrderCalculateRequest,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanOrderStatusRequest,
  EnterpriseCodingPlanOrderStatusResponse,
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
  StartPlanPreviewConfig,
  ZCodeModelContextBudgetStrategy,
  ForceUpdateConfig,
  ManualClaimPlanPreviewSnapshot,
  ManualClaimPlanClaimRequest,
  ManualClaimPlanClaimResult,
  DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  /** mock 演示强制通道：真实路径不下发，UI 使用 Host 的 Account support。 */
  readonly codingPlanActive?: boolean;
}

export interface ICodingPlanSubscriptionService {
  batchPreview(request?: CodingPlanBatchPreviewRequest): Promise<CodingPlanBatchPreviewResponse>;
  getStaticProducts(): Promise<CodingPlanStaticProductsConfig>;
  getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig>;
  getStartPlanPreview(): Promise<StartPlanPreviewConfig | null>;
  getManualClaimPlanPreviews(): Promise<ManualClaimPlanPreviewSnapshot>;
  claimManualPlan(request: ManualClaimPlanClaimRequest): Promise<ManualClaimPlanClaimResult>;
  /** 闲时任务灰度配置（D31）：forceRefresh 供入口打开时补拉（绕过 1h 快照缓存）。 */
  getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig>;
  /**
   * 动态工作流灰度快照：远端 `configs.dynamicWorkflow.mode`
   * 与本地覆盖折叠后的结果；forceRefresh 绕过 1h 快照缓存。请求失败 fail-closed（disabled/default）。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
  /** 兼容接口：固定返回 preflight-v1，不读取远端配置或缓存。 */
  getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy>;
  getBillingDiscount(): Promise<CodingPlanBillingDiscountConfig | undefined>;
  getRequestVerificationConfig(): Promise<RequestVerificationConfig | null>;
  getForceUpdateConfig(): Promise<ForceUpdateConfig | null>;
  productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo>;
  preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse>;
  createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse>;
  updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse>;
  checkPayment(request: CodingPlanPaymentCheckRequest): Promise<CodingPlanPaymentCheckResponse>;
  checkPendingOrders(
    request?: CodingPlanPendingOrderCheckRequest,
  ): Promise<CodingPlanPendingOrderCheckResponse>;
  queryStripeCards(request?: {
    providerId?: CodingPlanPreviewRequest["providerId"];
  }): Promise<CodingPlanStripeCard[]>;
  bindStripeCard(request: CodingPlanStripeBindRequest): Promise<CodingPlanStripeBindResponse>;
  unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string>;
  payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse>;
  checkPaypalSupport(
    request?: CodingPlanPaypalSupportRequest,
  ): Promise<CodingPlanPaypalSupportResponse>;
  createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse>;
  subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse>;
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
  getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse>;
  calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse>;
  createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]>;
  cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse>;
  continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse>;
  checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse>;
}

export const ICodingPlanSubscriptionService =
  createServiceDescriptor<ICodingPlanSubscriptionService>(ServiceChannels.CodingPlanSubscription);

/** 旧 RPC 兼容面：只允许保留读取，商业动作在 Host/客户端边界均明确拒绝。 */
export function createRetiredCodingPlanSubscriptionService(
  retainedReads: Pick<
    ICodingPlanSubscriptionService,
    | "getOffPeakClientConfig"
    | "getDynamicWorkflowClientConfig"
    | "getModelContextBudgetStrategy"
    | "getRequestVerificationConfig"
    | "getForceUpdateConfig"
    | "getEnterprisePricing"
  >,
): ICodingPlanSubscriptionService {
  // 旧 RPC 面的退役商业动作：旧客户端（含 UI 兼容期）调用必须明确失败。
  // 不做空成功（空成功会被当成"无商品/无订单"继续走 UI 流程），也不触发任何云请求或凭据读取。
  const unsupported = (action: string): Promise<never> =>
    Promise.reject(new Error(`commercial_service_unsupported:${action}`));

  return {
    batchPreview: () => unsupported("batchPreview"),
    getStaticProducts: () => unsupported("getStaticProducts"),
    getStaticTeamProducts: () => unsupported("getStaticTeamProducts"),
    getStartPlanPreview: () => unsupported("getStartPlanPreview"),
    getManualClaimPlanPreviews: () => unsupported("getManualClaimPlanPreviews"),
    claimManualPlan: () => unsupported("claimManualPlan"),
    ...retainedReads,
    getBillingDiscount: () => unsupported("getBillingDiscount"),
    productInfo: () => unsupported("productInfo"),
    preview: () => unsupported("preview"),
    createSign: () => unsupported("createSign"),
    updateSign: () => unsupported("updateSign"),
    checkPayment: () => unsupported("checkPayment"),
    checkPendingOrders: () => unsupported("checkPendingOrders"),
    queryStripeCards: () => unsupported("queryStripeCards"),
    bindStripeCard: () => unsupported("bindStripeCard"),
    unbindStripeCard: () => unsupported("unbindStripeCard"),
    payStripe: () => unsupported("payStripe"),
    checkPaypalSupport: () => unsupported("checkPaypalSupport"),
    createPaypalSetupToken: () => unsupported("createPaypalSetupToken"),
    subscribePaypal: () => unsupported("subscribePaypal"),
    getEnterpriseBalance: () => unsupported("getEnterpriseBalance"),
    calculateEnterpriseOrder: () => unsupported("calculateEnterpriseOrder"),
    createEnterpriseOrder: () => unsupported("createEnterpriseOrder"),
    getEnterprisePendingOrders: () => unsupported("getEnterprisePendingOrders"),
    cancelEnterpriseOrder: () => unsupported("cancelEnterpriseOrder"),
    continueEnterpriseOrderPayment: () => unsupported("continueEnterpriseOrderPayment"),
    checkEnterpriseOrderStatus: () => unsupported("checkEnterpriseOrderStatus"),
  };

}
