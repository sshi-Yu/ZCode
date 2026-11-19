/** OffPeak 既有驻留执行收尾边界；policy roots 同时覆盖契约目录与原实现文件。 */
export const offPeakResidentExecutionsModule = {
  id: "off-peak-resident-executions",
  requires: ["shared"],
  provides: ["off-peak-resident-execution-lifecycle"],
  publicEntrypoints: ["contract.ts", "../offPeakResidentExecutions.ts"],
} as const;
