import type {
  OffPeakResidentExecutionRegistration,
  OffPeakResidentExecutionRegistry,
} from "./contract.js";

/** 只关联 owner 已确认的执行；admitted 必须交给原 admission 完成回调调用。 */
export function exampleRegisterConfirmedOffPeakExecution(
  registry: OffPeakResidentExecutionRegistry,
  confirmedExecution: OffPeakResidentExecutionRegistration,
) {
  const registration = registry.register(confirmedExecution);
  return {
    onOriginalAdmissionAccepted: registration.admitted,
    onOriginalOwnerDisposed: registration.dispose,
    activeCount: () => registry.activeCount(),
  };
}
