import { create } from "zustand";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";

// 历史列表是 Host 本地记录的只读投影；仅保留用户显式取消和删除。
interface OffPeakTaskState {
  tasks: ZCodeOffPeakTask[];
  loading: boolean;
  error: string | null;
  operationId: string | null;
  refresh(service: IOffPeakTaskService): Promise<void>;
  cancelTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteHistory(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let inFlight: { service: IOffPeakTaskService; run: Promise<void> } | null = null;

export const useOffPeakTaskStore = create<OffPeakTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  operationId: null,

  refresh(service) {
    if (inFlight?.service === service) return inFlight.run;
    set({ loading: true, error: null });
    const run = Promise.resolve().then(async () => {
      try {
        const tasks = await service.list();
        if (inFlight?.run === run) set({ tasks, error: null });
      } catch (error) {
        if (inFlight?.run === run) set({ error: toErrorMessage(error) });
      } finally {
        if (inFlight?.run === run) {
          inFlight = null;
          set({ loading: false });
        }
      }
    });
    inFlight = { service, run };
    return run;
  },

  async cancelTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:cancel:${offPeakTaskId}`, error: null });
    try {
      await service.cancelTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteTask(offPeakTaskId, service) {
    set({ operationId: `offpeak:delete:${offPeakTaskId}`, error: null });
    try {
      await service.deleteTask(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },

  async deleteHistory(offPeakTaskId, service) {
    set({
      operationId: `offpeak:delete-history:${offPeakTaskId}`,
      error: null,
    });
    try {
      await service.deleteHistory(offPeakTaskId);
      await get().refresh(service);
    } catch (error) {
      set({ error: toErrorMessage(error) });
    } finally {
      set({ operationId: null });
    }
  },
}));
