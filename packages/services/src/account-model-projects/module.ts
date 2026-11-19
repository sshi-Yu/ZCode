/**
 * account-model-projects 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const accountModelProjectsModule = {
  id: "account-model-projects",
  requires: ["services", "shared"],
  provides: ["account-model-projects-service"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
