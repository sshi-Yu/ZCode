import { Worker } from "node:worker_threads";
import type { Change, Storage, StorageOperations, WorkerResponse } from "./types.js";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}
export async function openStorage(path: string): Promise<Storage> {
  const worker = new Worker(new URL("./storage-worker.mjs", import.meta.url), {
    workerData: { path },
  });
  let sequence = 0;
  let failure: Error | undefined;
  const pending = new Map<number, Pending>();
  let readyResolve: (changes: Change[]) => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<Change[]>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  function fail(): void {
    failure = new Error("NextStep storage unavailable");
    readyReject(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  }
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.on("message", (value: unknown) => {
    // 私有 worker 协议只有本应用一处写入；unknown 在消息边界收窄，不向 runtime 暴露未类型化结果。
    const message = value as WorkerResponse;
    if ("type" in message) {
      if (message.type === "ready") readyResolve(message.changes);
      else fail();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  function call<K extends keyof StorageOperations>(
    method: K,
    input: StorageOperations[K]["input"],
  ): Promise<StorageOperations[K]["output"]> {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as StorageOperations[K]["output"]),
        reject,
      });
      try {
        worker.postMessage({ id, method, input });
      } catch {
        pending.delete(id);
        reject(new Error("NextStep storage operation failed"));
      }
    });
  }
  try {
    const changes = await ready;
    return {
      changes,
      read: (key) => call("read", { key }),
      claim: (input) => call("claim", input),
      settle: (input) => call("settle", input),
      fence: () => call("fence", undefined),
      async close() {
        try {
          await call("close", undefined);
        } finally {
          await worker.terminate();
        }
      },
    };
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}
