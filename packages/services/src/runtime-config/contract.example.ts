/**
 * runtime-config 标准调用示例：读取动态工作流灰度；失败按关闭处理，不重试。
 */
import type { IRuntimeConfigService } from "./contract.js";

export async function exampleReadDynamicWorkflowMode(
  service: IRuntimeConfigService,
): Promise<"enabled" | "disabled"> {
  const snapshot = await service.getDynamicWorkflowClientConfig();
  return snapshot.enabled ? "enabled" : "disabled";
}
