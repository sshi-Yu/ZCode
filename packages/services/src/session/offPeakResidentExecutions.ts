import type {
  OffPeakControlParams,
  OffPeakControlResult,
  OffPeakLifecycleNotification,
  OffPeakOutcome,
} from "@zcode/shared";

type RequestAuth = Extract<OffPeakControlParams, { action: "replace_ticket" }>["requestAuth"];
interface TicketDelivery {
  control: Extract<OffPeakControlParams, { action: "replace_ticket" }>;
  previousTicketId: string;
  inFlight?: Promise<void>;
}
interface Registration {
  offPeakTaskId: string;
  executionId: string;
  sessionId: string;
  ticketId: string;
  control(input: OffPeakControlParams): Promise<OffPeakControlResult>;
  complete(outcome: OffPeakOutcome): Promise<void>;
  disposed?(): void;
}
interface ResidentExecution extends Registration {
  ready: Promise<void>;
  admit(): void;
  discarded: boolean;
  userOwned: boolean;
  terminal: boolean;
  renewalId?: number;
  ticketDelivery?: TicketDelivery;
  completedWritten: boolean;
  releasedTickets: Set<string>;
}

/** Host 只关联驻留执行和票据请求；后台工作清单与完成判断仍由 CLI 唯一维护。 */
export class OffPeakResidentExecutions {
  private readonly runs = new Map<string, ResidentExecution>();

  constructor(
    private readonly deps: {
      renew(taskId: string, current: () => boolean): Promise<void>;
      takeover(taskId: string): Promise<void>;
      release(ticketId: string, taskId: string): Promise<void>;
      completed?(taskId: string): Promise<void>;
      changed?(): void;
    },
  ) {}

  register(input: Registration): { admitted(): void; dispose(): void } {
    const previous = this.runs.get(input.offPeakTaskId);
    if (previous && !previous.terminal && !previous.discarded)
      throw new Error("off_peak_execution_already_registered");
    let admit!: () => void;
    const ready = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const run: ResidentExecution = {
      ...input,
      ready,
      admit,
      discarded: false,
      userOwned: false,
      terminal: false,
      completedWritten: false,
      releasedTickets: new Set(),
    };
    this.runs.set(input.offPeakTaskId, run);
    this.deps.changed?.();
    return {
      admitted: admit,
      dispose: () => {
        run.discarded = true;
        admit();
        if (this.runs.get(input.offPeakTaskId) === run) this.runs.delete(input.offPeakTaskId);
        this.deps.changed?.();
      },
    };
  }

  retakeGuard(taskId: string): () => boolean {
    const run = this.runs.get(taskId);
    const renewalId = run?.renewalId;
    return () =>
      run
        ? this.runs.get(taskId) === run &&
          !run.discarded &&
          !run.userOwned &&
          !run.terminal &&
          !run.ticketDelivery &&
          renewalId !== undefined &&
          run.renewalId === renewalId
        : !this.runs.has(taskId);
  }

  isUserOwned(taskId: string): boolean {
    return this.runs.get(taskId)?.userOwned === true;
  }
  has(taskId: string): boolean {
    return this.runs.has(taskId);
  }
  /** 取消能力只来自当前原 owner 的精确会话与执行登记，不从历史 running 推测。 */
  canCancel(taskId: string, sessionId?: string): boolean {
    const run = this.runs.get(taskId);
    return Boolean(
      run &&
      !run.discarded &&
      !run.terminal &&
      !run.userOwned &&
      run.executionId.trim() &&
      sessionId &&
      run.sessionId === sessionId,
    );
  }
  /** 2026-11-19 退役收尾：归零判定用——当前进程内可确认的驻留执行数量。 */
  activeCount(): number {
    let count = 0;
    for (const run of this.runs.values()) if (!run.discarded) count += 1;
    return count;
  }
  discardTicket(ticketId: string): Promise<void> {
    // 退役后不得借迟到派发消息核销未知历史票据；仅当前 resident 已登记的票可释放。
    const run = [...this.runs.values()].find((candidate) => candidate.ticketId === ticketId);
    return run ? this.deps.release(ticketId, run.offPeakTaskId) : Promise.resolve();
  }

  async handle(event: OffPeakLifecycleNotification): Promise<void> {
    const run = this.runs.get(event.offPeakTaskId);
    if (
      !run ||
      run.discarded ||
      run.executionId !== event.executionId ||
      run.sessionId !== event.sessionId
    )
      return;
    if (event.type === "ticket_needed") {
      if (run.userOwned || run.terminal || event.renewalId <= (run.renewalId ?? 0)) return;
      // CLI 已开始下一次续票，旧交接已被其消费；迟到 ACK 不得倒写新的票据归属。
      run.ticketDelivery = undefined;
      run.renewalId = event.renewalId;
    }
    if (event.type === "user_takeover") {
      run.userOwned = true;
      run.renewalId = undefined;
    }
    if (event.type === "completed") {
      if (run.terminal) return;
      run.terminal = true;
      run.renewalId = undefined;
    }
    await run.ready;
    if (run.discarded) return;
    switch (event.type) {
      case "ticket_needed": {
        const current = this.retakeGuard(event.offPeakTaskId);
        if (current()) await this.deps.renew(event.offPeakTaskId, current);
        return;
      }
      case "user_takeover":
        await this.deps.takeover(event.offPeakTaskId);
        return;
      case "ticket_released":
        // 只有当前登记票或已知交接票可释放；事件匹配执行身份仍不能授权任意票据网络写操作。
        if (
          event.ticketId !== run.ticketId &&
          event.ticketId !== run.ticketDelivery?.previousTicketId
        ) return;
        // 原因：进程内在途 Promise 只能防并发，不能防串行重复通知。按已匹配的
        // execution/session/ticket 先登记消费；网络失败由服务原 outbox 重试，不能再发一条核销。
        if (run.releasedTickets.has(event.ticketId)) return;
        run.releasedTickets.add(event.ticketId);
        await this.deps.release(event.ticketId, run.offPeakTaskId);
        this.finish(run);
        return;
      case "completed":
        await run.complete(event.outcome);
        run.completedWritten = true;
        // 用户接管可能先释放票、后结束整项；终态后只补写已确认 ACK 的本地事实。
        // 本地 DB busy 不得卡住已完成 owner；ACK 事实由服务独立保留重试。
        try {
          await this.deps.completed?.(run.offPeakTaskId);
        } finally {
          this.finish(run);
        }
        return;
      case "state_changed":
        return;
    }
  }

  async deliverTicket(
    taskId: string,
    ticketId: string,
    requestAuth: RequestAuth,
  ): Promise<{ sessionId: string } | undefined> {
    const run = this.runs.get(taskId);
    if (!run || run.discarded) return undefined;
    await run.ready;
    if (run.discarded) return undefined;
    const pendingDelivery = run.ticketDelivery;
    if (pendingDelivery) {
      if (pendingDelivery.control.ticketId !== ticketId) await this.deps.release(ticketId, run.offPeakTaskId);
      if (run.ticketDelivery === pendingDelivery) await this.sendTicket(run, pendingDelivery);
      return { sessionId: run.sessionId };
    }
    const renewalId = run.renewalId;
    if (renewalId === undefined || run.userOwned || run.terminal) {
      if (ticketId !== run.ticketId) await this.deps.release(ticketId, run.offPeakTaskId);
      return { sessionId: run.sessionId };
    }
    // 新票安装后 CLI 可立即完成，通知可能早于 RPC 回执；先登记对应票，防止旧票释放误收口。
    const delivery: TicketDelivery = {
      previousTicketId: run.ticketId,
      control: {
        sessionId: run.sessionId,
        executionId: run.executionId,
        action: "replace_ticket",
        renewalId,
        ticketId,
        requestAuth: structuredClone(requestAuth),
      },
    };
    run.ticketId = ticketId;
    run.ticketDelivery = delivery;
    await this.sendTicket(run, delivery);
    return { sessionId: run.sessionId };
  }

  /** 复用既有同步周期；未知回执只重试同一控制命令，不重取票或重放任务。 */
  async retryPendingTickets(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map((run) =>
        run.ticketDelivery ? this.sendTicket(run, run.ticketDelivery) : undefined,
      ),
    );
  }

  private sendTicket(run: ResidentExecution, delivery: TicketDelivery): Promise<void> {
    if (delivery.inFlight) return delivery.inFlight;
    const pending = this.confirmTicket(run, delivery).finally(() => {
      delivery.inFlight = undefined;
    });
    delivery.inFlight = pending;
    return pending;
  }

  private async confirmTicket(run: ResidentExecution, delivery: TicketDelivery): Promise<void> {
    // RPC 抛错不代表 CLI 未安装。保留原票及凭据，retakeGuard 同时禁止 Host 回队重取。
    const result = await run.control(delivery.control);
    if (run.discarded || run.ticketDelivery !== delivery) return;
    run.ticketDelivery = undefined;
    if (result.accepted) {
      if (run.renewalId === delivery.control.renewalId) run.renewalId = undefined;
    } else {
      run.ticketId = delivery.previousTicketId;
      await this.deps.release(delivery.control.ticketId, run.offPeakTaskId);
      this.finish(run);
      if (!run.userOwned && !run.terminal) {
        // 只有明确拒绝才允许重新申请；同步重试也须经过同一续票入口恢复调度。
        await this.deps.renew(run.offPeakTaskId, this.retakeGuard(run.offPeakTaskId));
        throw new Error("off_peak_ticket_handoff_rejected");
      }
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const run = this.runs.get(taskId);
    if (!run || run.discarded) return false;
    run.renewalId = undefined;
    // 立即阻止已在途重取号写回；CLI 的 completed 仍是生命周期收口事件。
    run.userOwned = true;
    // 注册早于首轮 admission；太早发控制请求会被 CLI 拒绝并丢失用户取消。
    await run.ready;
    if (run.discarded || run.terminal) return false;
    // CLI 可能已切换执行；只有原执行明确接受取消，才能写入取消终态。
    const result = await run.control({
      sessionId: run.sessionId,
      executionId: run.executionId,
      action: "cancel",
    });
    return result.accepted;
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      run.discarded = true;
      run.admit();
    }
    this.runs.clear();
  }
  private finish(run: ResidentExecution): void {
    if (!run.completedWritten || !run.releasedTickets.has(run.ticketId)) return;
    run.discarded = true;
    if (this.runs.get(run.offPeakTaskId) === run) this.runs.delete(run.offPeakTaskId);
    this.deps.changed?.();
    run.disposed?.();
  }
}
