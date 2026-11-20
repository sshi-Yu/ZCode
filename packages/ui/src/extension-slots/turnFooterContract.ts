import type { TurnFooterResult, TurnFooterTarget } from "@zcode/shared/extension-host";

/** 当前合格回复的即时定位；不由 Renderer 推导持久 assistantMessageId。 */
export interface TurnFooterSlotProps {
  target: TurnFooterTarget;
  /** CLI row.productTurnId；只用于限定通知归属，不能回退 runtime turnId。 */
  productTurnId: string;
  /** 出现更新的运行中用户轮时，旧回复仍可展示，但不可发送建议。 */
  submissionBlocked: boolean;
}

export interface TurnFooterSlotModel {
  result: TurnFooterResult;
  pending: "read" | "refresh" | "submit" | null;
  submitted: boolean;
  error: "read" | "refresh" | "submit" | "stale" | "blocked" | null;
  retryRead(): void;
  refresh(): void;
  submit(suggestionId: string, version: number): void;
}
