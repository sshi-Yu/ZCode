/* Off-Peak 退役后的本地历史与原 owner 收尾服务。
 * 不再创建/取号/重排/轮询云端队列；tasks-index 与普通 Cron 保持原职责。
 * 合同：docs/superpowers/specs/2026-11-19-offpeak-retirement-contract.md。 */
import { ZodError } from "zod";
import {
  isOffPeakTerminalStatus,
  OFF_PEAK_TICKET_EXPIRED_MARKER,
  type ProjectExecutionSnapshot,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateErrorCategory,
  type OffPeakTaskCreateFailureStage,
  type OffPeakTaskCreateResult,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import type { OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { IOffPeakTaskService, OffPeakUpdateTaskParams } from "./offPeakTask.js";
import { OffPeakServerError, type OffPeakServerClient } from "./offPeakServerClient.js";
import type { ModelSelection, ModelSelectionValidation } from "@zcode/provider";
import { OffPeakResidentExecutions } from "./offPeakResidentExecutions.js";

/** 固定退役规则，不由账号、远端灰度或 UI 控制。 */
export const OFF_PEAK_RETIRED_ERROR_CODE = "off_peak_retired";
export const OFF_PEAK_SYNC_MIN_INTERVAL_MS = 5_000;
export const OFF_PEAK_SYNC_MAX_INTERVAL_MS = 5 * 60_000;

export interface OffPeakTaskServiceDeps {
  repo: OffPeakTaskRepo;
  prepareProjectExecution?: (projectId: string) => Promise<ProjectExecutionSnapshot>;
  client: OffPeakServerClient;
  resolveCodingPlanSupport: () => Promise<OffPeakCodingPlanSupport>;
  /** 旧装配参数保留兼容，退役 admission 不再读取。 */
  resolveTelemetryProviderName: () => Promise<string>;
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  logger: ServiceLogger;
  requestSchedulerWake?: () => void;
  /** 旧装配参数保留兼容；不能据历史 conversationId 停止未经确认的会话 owner。 */
  stopRunningTask?: (params: {
    conversationId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  onTasksChanged?: () => void;
  now?: () => number;
  onDispose?: () => void;
}

/** 旧公开分类函数保留；退役 createTask 不再执行取号或持久化。 */
export function classifyOffPeakCreateFailure(
  error: unknown,
  failureStage: OffPeakTaskCreateFailureStage,
): Pick<
  Extract<OffPeakTaskCreateResult, { ok: false }>,
  "failureStage" | "errorCategory" | "errorCode"
> {
  let errorCategory: OffPeakTaskCreateErrorCategory = "unknown";
  let errorCode = "";
  if (failureStage === "client_validation") errorCategory = "client_validation";
  else if (failureStage === "local_persist") errorCategory = "local_persist";
  else if (error instanceof OffPeakServerError) {
    errorCode = error.bizCode === undefined ? "" : String(error.bizCode);
    if (error.bizCode === 3101) errorCategory = "eligibility_3101";
    else if (error.bizCode === 3103) errorCategory = "quota_3103";
  } else if (error instanceof ZodError) errorCategory = "invalid_response";
  else errorCategory = "network";
  return { failureStage, errorCategory, errorCode };
}

export class OffPeakTaskService implements IOffPeakTaskService {
  readonly residentExecutions: OffPeakResidentExecutions;
  /** 只保存本进程已确认执行释放的票据；重启不扫描持久化历史 outbox。 */
  private readonly releasedTicketOutbox = new Map<string, string>();
  /** 云端已 ACK、尚未在终态行落盘的本进程事实；绝不据它再次发送 settle。 */
  private readonly settledTickets = new Map<string, { taskId: string; settledAt: number }>();
  private readonly releases = new Map<string, Promise<void>>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRunning = false;
  private syncStopped = true;

  constructor(private readonly deps: OffPeakTaskServiceDeps) {
    this.residentExecutions = new OffPeakResidentExecutions({
      renew: (taskId, current) => this.handleTicketExpiredDuringRun(taskId, current),
      takeover: async () => {
        // 用户接管不授权另开任务或改模型；原 CLI owner 持续发布实际终态。
        this.emitChanged();
      },
      release: (ticketId, taskId) => this.releaseExecutionTicket(ticketId, taskId),
      completed: (taskId) => this.persistSettledTickets(taskId),
      changed: () => this.ensureSyncScheduled(0),
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onTasksChanged?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onTasksChanged 回调失败:", error);
    }
  }

  async getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport> {
    return this.deps.resolveCodingPlanSupport();
  }

  /** 退役后任何新派发选择均拒绝；不重新解析账号/模型，更不能回落普通付费模型。 */
  async validateDispatchModelSelection(_selection: ModelSelection): Promise<boolean> {
    return false;
  }

  async getTakeNumberAvailability() {
    return { canTakeNumber: false };
  }

  async createTask(_params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult> {
    // 原因：只删 UI/工具会留下 RPC 直调入口；在最早 admission 返回既有结构，零 I/O。
    return {
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: OFF_PEAK_RETIRED_ERROR_CODE,
      providerName: "",
    };
  }

  async pauseTask(_offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    throw new Error(OFF_PEAK_RETIRED_ERROR_CODE);
  }

  async continueTask(_offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    throw new Error(OFF_PEAK_RETIRED_ERROR_CODE);
  }

  async updateTask(
    _offPeakTaskId: string,
    _params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null> {
    throw new Error(OFF_PEAK_RETIRED_ERROR_CODE);
  }

  private canCancel(task: ZCodeOffPeakTask): boolean {
    return (
      task.status === "running" &&
      this.residentExecutions.canCancel(task.offPeakTaskId, task.sessionId)
    );
  }

  private projectTask(task: ZCodeOffPeakTask): ZCodeOffPeakTask {
    return { ...task, schedulable: false, canCancel: this.canCancel(task) };
  }

  async list(): Promise<ZCodeOffPeakTask[]> {
    // 只读投影，不重写旧 status/票据/位次/模型，不重新请求账号资格。
    return (await this.deps.repo.list()).map((task) => this.projectTask(task));
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const task = await this.deps.repo.get(offPeakTaskId);
    return task ? this.projectTask(task) : null;
  }

  async cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return null;
    if (isOffPeakTerminalStatus(existing.status)) return this.projectTask(existing);
    // 原因：冷启动的 running 行不能证明 owner 仍在；不得据旧 conversationId 停止别的执行，
    // 也不能为 queued/paused 核销历史云票据或伪称云端已取消。
    if (!this.canCancel(existing) || !(await this.residentExecutions.cancel(offPeakTaskId))) {
      throw new Error(OFF_PEAK_RETIRED_ERROR_CODE);
    }
    const cancelled = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "cancelled",
      endedAt: this.now(),
      expectedTask: existing,
    });
    this.emitChanged();
    // 票据释放只消费原 CLI lifecycle 的 ticket_released，不为取消另走一次 settle。
    return cancelled ? this.projectTask(cancelled) : this.get(offPeakTaskId);
  }

  async deleteTask(offPeakTaskId: string): Promise<void> {
    // 保留用户显式的本地删除，不向云端取消；驻留实例先交给原 owner 停止。
    if (this.residentExecutions.has(offPeakTaskId)) await this.cancelTask(offPeakTaskId);
    await this.deps.repo.delete(offPeakTaskId);
    this.emitChanged();
  }

  async deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const updated = await this.deps.repo.markHistoryDeleted(offPeakTaskId, { now: this.now() });
    if (updated) this.emitChanged();
    return updated;
  }

  async handleTicketExpiredDuringRun(
    offPeakTaskId: string,
    current = this.residentExecutions.retakeGuard(offPeakTaskId),
    snapshot?: ZCodeOffPeakTask,
  ): Promise<void> {
    // 只处理已确认在途实例的原票到期；不重取号、不重新派发、不扫描 queued。
    if (!this.residentExecutions.has(offPeakTaskId) || !current()) return;
    const task = snapshot ?? (await this.deps.repo.get(offPeakTaskId));
    if (!current() || !task || task.status !== "running") return;
    const failed = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "failed",
      failureReason: OFF_PEAK_TICKET_EXPIRED_MARKER,
      endedAt: this.now(),
      expectedTask: task,
    });
    if (!failed) return;
    try {
      if (current()) await this.residentExecutions.cancel(offPeakTaskId);
    } finally {
      this.emitChanged();
    }
  }

  /** 只由已匹配 execution/session 的 resident lifecycle 调用；无全量历史补报。 */
  private async releaseExecutionTicket(ticketId: string, taskId: string): Promise<void> {
    const existing = this.releases.get(ticketId);
    if (existing) return existing;
    this.releasedTicketOutbox.set(ticketId, taskId);
    const release = this.settleResidentTicket(ticketId, taskId).finally(() => {
      this.releases.delete(ticketId);
      this.ensureSyncScheduled(OFF_PEAK_SYNC_MIN_INTERVAL_MS);
    });
    this.releases.set(ticketId, release);
    return release;
  }

  private async settleResidentTicket(ticketId: string, taskId: string): Promise<void> {
    try {
      await this.deps.client.settle(ticketId);
    } catch (error) {
      if (!(error instanceof OffPeakServerError && error.httpStatus < 500)) {
        this.deps.logger.warn("off-peak resident ticket release pending:", error);
        return;
      }
      // 4xx 表示未知/已失效票，按原幂等 ack 收口；不因失败重取号。
    }
    this.releasedTicketOutbox.delete(ticketId);
    this.settledTickets.set(ticketId, { taskId, settledAt: this.now() });
    await this.persistSettledTickets(taskId);
  }

  private async persistSettledTickets(taskId?: string): Promise<void> {
    for (const [ticketId, ack] of this.settledTickets) {
      if (taskId !== undefined && ack.taskId !== taskId) continue;
      const task = await this.deps.repo.get(ack.taskId);
      if (task && !isOffPeakTerminalStatus(task.status)) continue;
      // 原因：markSettled 只允许终态行；takeover 提前释放时保存 ACK，等 completed 后
      // 仅补本地落盘。旧票/已删记录无需回写，也不得据此重新核销云票据。
      if (task?.serverTicketId === ticketId) {
        await this.deps.repo.markSettled(ack.taskId, ack.settledAt);
      }
      this.settledTickets.delete(ticketId);
    }
  }

  startSync(): void {
    if (!this.syncStopped) return;
    this.syncStopped = false;
    // 原因：旧 startSync 首次 flushSettleOutbox 会批量访问历史票据；退役冷启动零 resident
    // 时既不扫描数据库，也不设专用定时器。后续仅由 resident 活动唤醒。
    if (this.hasWindDownWork()) this.ensureSyncScheduled(0);
  }

  stopSync(): void {
    this.syncStopped = true;
    this.clearSyncTimer();
  }

  disposeAll(): void {
    this.stopSync();
    this.residentExecutions.dispose();
    this.releasedTicketOutbox.clear();
    this.settledTickets.clear();
    try {
      this.deps.onDispose?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onDispose 清理失败:", error);
    }
  }

  private hasWindDownWork(): boolean {
    return (
      this.residentExecutions.activeCount() > 0 ||
      this.releasedTicketOutbox.size > 0 ||
      this.settledTickets.size > 0
    );
  }

  private clearSyncTimer(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private ensureSyncScheduled(delayMs: number): void {
    if (this.syncStopped) return;
    this.clearSyncTimer();
    if (!this.hasWindDownWork()) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSyncCycle();
    }, delayMs);
    this.syncTimer.unref?.();
  }

  /** 收尾周期只处理进程内已确认执行；不读历史 outbox，不发 batchStatus，不修改旧队列。 */
  async runSyncCycle(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      for (const [ticketId, taskId] of this.releasedTicketOutbox) {
        await this.releaseExecutionTicket(ticketId, taskId);
      }
      await this.residentExecutions.retryPendingTickets();
      await this.persistSettledTickets();
    } catch (error) {
      this.deps.logger.warn("off-peak resident wind-down pending:", error);
    } finally {
      this.syncRunning = false;
      this.ensureSyncScheduled(OFF_PEAK_SYNC_MIN_INTERVAL_MS);
    }
  }
}
