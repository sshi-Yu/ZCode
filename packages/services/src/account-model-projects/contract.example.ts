/**
 * account-model-projects 标准调用示例：登录后读取已有团队项目；失败保留原选择。
 */
import type { IAccountModelProjectsService } from "./contract.js";

export async function exampleLoadTeamProjects(
  service: IAccountModelProjectsService,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await service.getEnterprisePricing({ family: "zai" });
    return { ok: true };
  } catch (error) {
    // 失败与空列表含义不同：不能清掉用户原有的项目/模型选择。
    return { ok: false, error };
  }
}
