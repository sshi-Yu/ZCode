import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ImageGenerationJob, ImageGenerationStatus } from "./contract.js";
import { ImageGenerationError } from "./validation.js";

interface ProcessState {
  token: string;
  pending: Set<string>;
}
const stateKey = Symbol.for("zcode.image-generation.process-state");
const processGlobal = globalThis as typeof globalThis & { [stateKey]?: ProcessState };
const processState = (processGlobal[stateKey] ??= { token: randomUUID(), pending: new Set() });

interface JobRow {
  id: string;
  request_id: string;
  prompt: string;
  model_id: "gpt-image-1";
  status: ImageGenerationStatus;
  app_run_id: string;
  owner_pid: number;
  owner_token: string;
  dispatched: number;
  asset_id: string | null;
  preview: string | null;
  error: string | null;
}

export interface ImageGenerationStore {
  read(): ImageGenerationJob[];
  admit(input: { requestId: string; prompt: string; modelId: "gpt-image-1" }): {
    job: ImageGenerationJob;
    accepted: boolean;
  };
  replay(input: {
    requestId: string;
    prompt: string;
    modelId: "gpt-image-1";
  }): ImageGenerationJob | undefined;
  fence(id: string): boolean;
  finish(
    id: string,
    status: ImageGenerationStatus,
    error?: string,
    asset?: { id: string; preview: string },
  ): void;
  hasAsset(assetId: string): boolean;
  track(id: string): void;
  untrack(id: string): void;
}

function projection(row: JobRow): ImageGenerationJob {
  return {
    id: row.id,
    prompt: row.prompt,
    modelId: row.model_id,
    status: row.status,
    ...(row.asset_id && row.preview ? { asset: { id: row.asset_id, preview: row.preview } } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM/unknown errors cannot prove owner death; only ESRCH permits recovery.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface ImageGenerationStoreHooks {
  /** 只在恢复事务提交之后调用，回滚的尝试不产生生命周期日志。 */
  onStaleRecovered?: (info: { status: ImageGenerationStatus; dispatched: boolean }) => void;
}

export function createImageGenerationStore(
  dbPath: string,
  appRunId: string,
  hooks: ImageGenerationStoreHooks = {},
): ImageGenerationStore {
  const key = (id: string) => `${dbPath}\0${id}`;
  const own = [appRunId, process.pid, processState.token] as const;

  function transaction<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath);
    let recovered: { status: ImageGenerationStatus; dispatched: boolean } | undefined;
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      try {
        const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (version.user_version > 1)
          throw new ImageGenerationError("Image storage version is unsupported.");
        if (version.user_version === 0) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS image_jobs (
              id TEXT PRIMARY KEY,
              request_id TEXT NOT NULL UNIQUE,
              prompt TEXT NOT NULL,
              model_id TEXT NOT NULL CHECK(model_id = 'gpt-image-1'),
              status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','outcome_unknown')),
              app_run_id TEXT NOT NULL,
              owner_pid INTEGER NOT NULL,
              owner_token TEXT NOT NULL,
              dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)),
              created_at INTEGER NOT NULL,
              asset_id TEXT UNIQUE,
              preview TEXT,
              error TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS image_jobs_single_running
              ON image_jobs(status) WHERE status = 'running';
            PRAGMA user_version = 1;
          `);
        }
        const running = db.prepare("SELECT * FROM image_jobs WHERE status = 'running'").get() as
          | JobRow
          | undefined;
        if (running) {
          const sameProcess =
            running.owner_pid === process.pid && running.owner_token === processState.token;
          const live = sameProcess
            ? processState.pending.has(key(running.id))
            : pidIsAlive(running.owner_pid);
          if (!live) {
            // 退出后的受理记录不能重发：持久发送屏障决定失败或结果未知，窗口重建不充当重试。
            const status: ImageGenerationStatus = running.dispatched ? "outcome_unknown" : "failed";
            db.prepare(
              "UPDATE image_jobs SET status = ?, error = ? WHERE id = ? AND status = 'running'",
            ).run(
              status,
              running.dispatched
                ? "Generation outcome is unknown. Create a new request to generate again."
                : "Generation stopped before dispatch.",
              running.id,
            );
            recovered = { status, dispatched: Boolean(running.dispatched) };
          }
        }
        const result = run(db);
        db.exec("COMMIT");
        if (recovered) hooks.onStaleRecovered?.(recovered);
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }

  function replay(
    db: DatabaseSync,
    input: { requestId: string; prompt: string; modelId: "gpt-image-1" },
  ) {
    const row = db.prepare("SELECT * FROM image_jobs WHERE request_id = ?").get(input.requestId) as
      | JobRow
      | undefined;
    if (!row) return undefined;
    if (row.prompt !== input.prompt || row.model_id !== input.modelId) {
      throw new ImageGenerationError("Request ID was already used with different input.");
    }
    return projection(row);
  }

  return {
    track: (id) => processState.pending.add(key(id)),
    untrack: (id) => processState.pending.delete(key(id)),
    replay: (input) => transaction((db) => replay(db, input)),
    read: () =>
      transaction((db) =>
        (
          db
            .prepare(
              "SELECT * FROM image_jobs ORDER BY (status = 'running') DESC, created_at DESC, rowid DESC LIMIT 24",
            )
            .all() as unknown as JobRow[]
        ).map(projection),
      ),
    admit: (input) =>
      transaction((db) => {
        const existing = replay(db, input);
        if (existing) return { job: existing, accepted: false };
        if (db.prepare("SELECT id FROM image_jobs WHERE status = 'running'").get()) {
          throw new ImageGenerationError("Another image generation is running.");
        }
        const id = randomUUID();
        db.prepare(`INSERT INTO image_jobs
        (id, request_id, prompt, model_id, status, app_run_id, owner_pid, owner_token, created_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`).run(
          id,
          input.requestId,
          input.prompt,
          input.modelId,
          ...own,
          Date.now(),
        );
        return {
          accepted: true,
          job: { id, prompt: input.prompt, modelId: input.modelId, status: "running" as const },
        };
      }),
    fence: (id) =>
      transaction(
        (db) =>
          db
            .prepare(`UPDATE image_jobs SET dispatched = 1
      WHERE id = ? AND status = 'running' AND dispatched = 0
      AND app_run_id = ? AND owner_pid = ? AND owner_token = ?`)
            .run(id, ...own).changes === 1,
      ),
    finish: (id, status, error, asset) =>
      transaction((db) => {
        db.prepare(`UPDATE image_jobs SET status = ?, error = ?, asset_id = ?, preview = ?
        WHERE id = ? AND status = 'running' AND app_run_id = ? AND owner_pid = ? AND owner_token = ?`).run(
          status,
          error ?? null,
          asset?.id ?? null,
          asset?.preview ?? null,
          id,
          ...own,
        );
      }),
    hasAsset: (assetId) =>
      transaction((db) =>
        Boolean(
          db
            .prepare("SELECT id FROM image_jobs WHERE asset_id = ? AND status = 'succeeded'")
            .get(assetId),
        ),
      ),
  };
}
