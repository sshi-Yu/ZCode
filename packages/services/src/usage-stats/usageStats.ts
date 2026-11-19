import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  getCodingPlanUsageSnapshot(request: CodingPlanUsageRequest): Promise<CodingPlanUsageSnapshot>;
  getCodingPlanRegularTps?(request: CodingPlanRegularTpsRequest): Promise<number | undefined>;
  getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot>;
  requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult>;
  useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult>;
  markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void>;
  getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot>;
  getEntitlementSnapshot(request?: UsageEntitlementRequest): Promise<UsageEntitlementSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);

/** 旧客户端兼容；重置专用读取/写入在当前 Host 和远端代理边界均拒绝，不转交旧 Host。 */
export function createRetiredCodingPlanResetMethods(): Pick<
  IUsageStatsService,
  | "getCodingPlanResetStatus"
  | "requestCodingPlanResetOpportunity"
  | "useCodingPlanReset"
  | "markCodingPlanResetHistoryRead"
> {
  return {
    async getCodingPlanResetStatus() {
      throw new Error("commercial_service_unsupported:getCodingPlanResetStatus");
    },
    async requestCodingPlanResetOpportunity() {
      throw new Error("commercial_service_unsupported:requestCodingPlanResetOpportunity");
    },
    async useCodingPlanReset() {
      throw new Error("commercial_service_unsupported:useCodingPlanReset");
    },
    async markCodingPlanResetHistoryRead() {
      throw new Error("commercial_service_unsupported:markCodingPlanResetHistoryRead");
    },
  };
}
