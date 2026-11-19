import type {
  EnterpriseCodingPlanPricingRequest,
  EnterpriseCodingPlanPricingResponse,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 已有账号模型与团队项目读取（docs/superpowers/specs/2026-11-19-personal-workbench-backend-contracts.md）。
 *
 * 虽然 pricing 命名来自交易时代，但该请求同时完成已订阅 Team Plan 项目发现与必要
 * 项目 API Key 准备（enrichEnterprisePricingTeamProjects / ensureSubscribedTeamPlanProjectApiKeys），
 * 是使用已有团队模型的合法前置条件，必须保留。缺省 family 路由到 BigModel，zai 走原
 * Zai provider；实现委托同一 Host 装配内已有的 provider 实例，不另建缓存或请求。
 */
export interface IAccountModelProjectsService {
  /**
   * 读取已有个人/团队项目与模型资格。失败语义保持原样（抛错），调用方不得把失败
   * 当成空项目列表而清除原有选择。authenticated=false 时走原匿名 pricing 分支。
   */
  getEnterprisePricing(
    request?: EnterpriseCodingPlanPricingRequest,
  ): Promise<EnterpriseCodingPlanPricingResponse>;
}

export const IAccountModelProjectsService =
  createServiceDescriptor<IAccountModelProjectsService>(ServiceChannels.AccountModelProjects);
