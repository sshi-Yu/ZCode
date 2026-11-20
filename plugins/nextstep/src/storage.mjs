import { Worker } from "node:worker_threads";

export async function openStorage(path) {
  const worker = new Worker(new URL("./storage-worker.mjs", import.meta.url), {
    workerData: { path },
  });
  let sequence = 0;
  let failure;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  function fail() {
    failure = new Error("NextStep storage unavailable");
    readyReject(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  }
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.on("message", (message) => {
    if (message.type === "ready") return readyResolve(message.changes);
    if (message.type === "failed") return fail();
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  function call(method, input) {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
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
      fence: () => call("fence"),
      async close() {
        try {
          await call("close");
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
