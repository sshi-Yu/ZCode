import type { OffPeakResidentExecutions } from "../offPeakResidentExecutions.js";

/**
 * Host 侧已有执行关联表；不会创建 CLI 执行、取票或重放历史任务。
 * 实际执行与完成事实仍由原 CLI owner 持有。接口从唯一实现派生，避免第二套状态协议。
 */
export type OffPeakResidentExecutionRegistry = OffPeakResidentExecutions;

/**
 * 只有原 owner 已确认的执行可登记；task/execution/session 身份用于过滤迟到事件。
 * admitted() 必须在原执行完成 admission 后调用；dispose() 只解除本地关联。
 */
export type OffPeakResidentExecutionRegistration = Parameters<
  OffPeakResidentExecutions["register"]
>[0];

/** renew/takeover/release 的副作用由 Host 所有者注入，本模块不直接访问服务、Repo 或网络。 */
export type OffPeakResidentExecutionPorts = ConstructorParameters<
  typeof import("../offPeakResidentExecutions.js").OffPeakResidentExecutions
>[0];

/** 保留原公开构造入口；服务和 Host 可以逐步改用该契约入口。 */
export { OffPeakResidentExecutions } from "../offPeakResidentExecutions.js";
