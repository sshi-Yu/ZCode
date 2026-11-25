import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { rename, stat, unlink } from "node:fs/promises";
import type {
  ImageGenerationProtocol,
  ImageGenerationJob,
  ImageGenerationStatus,
  ImageGenerationDefaultSelection,
  ImageGenerationPublicConnection,
  ImageGenerationParameters,
  ImageGenerationPurpose,
  ImageGenerationTestResult,
  ImageGenerationErrorCode,
  ImageGenerationSelection,
} from "./contract.js";
import { OFFICIAL_CONNECTION_ID, OFFICIAL_MODEL_KEY, stableParameters } from "./configuration.js";
import { ImageGenerationError } from "./validation.js";

interface ProcessState {
  token: string;
  pending: Set<string>;
}
const stateKey = Symbol.for("zcode.image-generation.process-state");
const processGlobal = globalThis as typeof globalThis & { [stateKey]?: ProcessState };
const processState = (processGlobal[stateKey] ??= { token: randomUUID(), pending: new Set() });
export interface StoredConnection extends Omit<ImageGenerationPublicConnection, "configured"> {
  credentialRef: string | null;
}
export interface GenerationSnapshot {
  requestId: string;
  prompt: string;
  modelId: string;
  connectionId: string;
  modelKey: string;
  revision: number;
  purpose: ImageGenerationPurpose;
  parameters: ImageGenerationParameters;
  callerParameters: ImageGenerationParameters;
  sampleVersion?: string;
  destinationFingerprint: string;
  endpoint: string;
  protocol: ImageGenerationProtocol;
  auth: "bearer";
  officialPreset: boolean;
}
type TerminalStatus = Exclude<ImageGenerationStatus, "running">;
interface JobRow {
  id: string;
  request_id: string;
  prompt: string;
  model_id: string;
  status: ImageGenerationStatus;
  app_run_id: string;
  owner_pid: number;
  owner_token: string;
  dispatched: number;
  created_at: number;
  sort_key: number;
  asset_id: string | null;
  preview: string | null;
  error: string | null;
  snapshot: string | null;
  purpose: ImageGenerationPurpose;
  error_code: ImageGenerationErrorCode | null;
}
export interface ImageGenerationStoreHooks {
  onStaleRecovered?: (info: { status: ImageGenerationStatus; dispatched: boolean }) => void;
}
export interface ImageGenerationStore {
  readActive(): ImageGenerationJob | null;
  history(input: { cursor?: string; purpose?: ImageGenerationPurpose }): {
    jobs: ImageGenerationJob[];
    nextCursor: string | null;
  };
  getRequest(requestId: string): ImageGenerationJob | null;
  snapshot(requestId: string): GenerationSnapshot | null;
  replay(input: GenerationSnapshot): ImageGenerationJob | undefined;
  admit(input: GenerationSnapshot): { job: ImageGenerationJob; accepted: boolean };
  fence(id: string): boolean;
  finish(
    id: string,
    status: TerminalStatus,
    error?: string,
    asset?: { id: string; preview: string },
    code?: ImageGenerationErrorCode,
  ): void;
  hasAsset(assetId: string): boolean;
  preview(assetId: string): string | undefined;
  track(id: string): void;
  untrack(id: string): void;
  connections(): StoredConnection[];
  configuration(): {
    connections: StoredConnection[];
    defaultSelection: ImageGenerationDefaultSelection;
  };
  publish(
    connection: StoredConnection,
    expected: number | null,
    defaultChange?: { expectedRevision: number; selection: ImageGenerationSelection | null },
  ): StoredConnection;
  deleteConnection(
    id: string,
    revision: number,
    defaultChange?: { expectedRevision: number; selection: ImageGenerationSelection | null },
  ): void;
  setDefault(input: {
    expectedRevision: number;
    selection: ImageGenerationSelection | null;
  }): ImageGenerationDefaultSelection;
  migrated(): boolean;
  migrationCandidate(ref: string | null): string | null;
  migrateCredential(ref: string | null): void;
  candidate(ref: string): void;
  candidates(): string[];
  removeCandidate(ref: string): void;
  beginProbe(id: string, revision: number): number;
  finishProbe(
    id: string,
    revision: number,
    sequence: number,
    result: ImageGenerationTestResult,
  ): void;
}
function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function projection(row: JobRow, preview = false): ImageGenerationJob {
  const snapshot = row.snapshot ? (JSON.parse(row.snapshot) as GenerationSnapshot) : undefined;
  return {
    id: row.id,
    prompt: row.prompt,
    modelId: row.model_id,
    status: row.status,
    connectionId: snapshot?.connectionId ?? OFFICIAL_CONNECTION_ID,
    modelKey: snapshot?.modelKey ?? OFFICIAL_MODEL_KEY,
    ...(snapshot ? { revision: snapshot.revision, parameters: snapshot.parameters } : {}),
    purpose: row.purpose,
    createdAt: row.created_at,
    ...(row.asset_id
      ? { asset: { id: row.asset_id, ...(preview && row.preview ? { preview: row.preview } : {}) } }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}
const jobsSchema = `CREATE TABLE image_jobs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','outcome_unknown')),
  app_run_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_token TEXT NOT NULL,
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)), created_at INTEGER NOT NULL,
  asset_id TEXT UNIQUE, preview TEXT, error TEXT, sort_key INTEGER NOT NULL UNIQUE,
  snapshot TEXT, purpose TEXT NOT NULL DEFAULT 'generation', error_code TEXT
);`;

/** Called under the same cross-process configuration lock as every configuration mutation. */
export async function prepareImageGenerationDatabase(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath);
  let temporary: string | undefined;
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version > 2)
      throw new ImageGenerationError(
        "Image storage requires a newer application.",
        "storage_error",
      );
    if (version === 2) return;
    const dataVersion = () =>
      (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    const schemaSnapshot = dataVersion();
    let backupPath: string | undefined;
    if (version === 1) {
      const original = `${dbPath}.v1-backup.sqlite`;
      const exists = await stat(original).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      backupPath = exists ? `${original}.${randomUUID()}` : original;
      temporary = `${backupPath}.${randomUUID()}.tmp`;
      await backup(db, temporary);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (version === 1) {
        const running = db
          .prepare("SELECT owner_pid,owner_token,id FROM image_jobs WHERE status='running'")
          .get() as Pick<JobRow, "owner_pid" | "owner_token" | "id"> | undefined;
        // 备份期间 v1 仍可写入；持有 SQLite 写锁后复查版本、活跃 owner 与备份快照，禁止升级失配数据。
        if (
          dataVersion() !== schemaSnapshot ||
          (running &&
            (running.owner_pid === process.pid && running.owner_token === processState.token
              ? processState.pending.has(`${dbPath}\0${running.id}`)
              : pidIsAlive(running.owner_pid)))
        ) {
          throw new ImageGenerationError(
            "Close the previous image Host before upgrading image storage.",
            "busy",
          );
        }
        await rename(temporary!, backupPath!);
        temporary = undefined;
        // v1 的固定 model CHECK 阻止新增模型；保留 rowid 为持久分页键，原记录与发送屏障逐列复制。
        db.exec(`ALTER TABLE image_jobs RENAME TO image_jobs_v1; DROP INDEX image_jobs_single_running; ${jobsSchema}
          INSERT INTO image_jobs (id,request_id,prompt,model_id,status,app_run_id,owner_pid,owner_token,dispatched,created_at,asset_id,preview,error,sort_key)
          SELECT id,request_id,prompt,model_id,status,app_run_id,owner_pid,owner_token,dispatched,created_at,asset_id,preview,error,rowid FROM image_jobs_v1;
          DROP TABLE image_jobs_v1;`);
      } else db.exec(jobsSchema);
      db.exec(`CREATE UNIQUE INDEX image_jobs_single_running ON image_jobs(status) WHERE status='running';
        CREATE INDEX image_jobs_history ON image_jobs(created_at DESC,sort_key DESC);
        CREATE TABLE image_connections(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, probe_sequence INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE image_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE image_credential_candidates(ref TEXT PRIMARY KEY);
        INSERT INTO image_meta VALUES('default','{"revision":1,"selection":{"connectionId":"openai-official","modelKey":"gpt-image-1"}}');
        PRAGMA user_version=2;`);
      const official: StoredConnection = {
        connectionId: OFFICIAL_CONNECTION_ID,
        revision: 1,
        name: "OpenAI",
        enabled: true,
        protocol: "openai-images",
        baseUrl: "https://api.openai.com",
        generationPath: "/v1/images/generations",
        probePath: "/v1/models",
        auth: "bearer",
        generationUrl: "https://api.openai.com/v1/images/generations",
        probeUrl: "https://api.openai.com/v1/models",
        officialPreset: true,
        credentialRef: null,
        models: [
          {
            modelKey: OFFICIAL_MODEL_KEY,
            modelId: "gpt-image-1",
            name: "gpt-image-1",
            enabled: true,
            parameters: { size: "1024x1024" },
          },
        ],
      };
      db.prepare("INSERT INTO image_connections(id,revision,value) VALUES(?,?,?)").run(
        official.connectionId,
        1,
        JSON.stringify(official),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
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
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
      try {
        const running = db.prepare("SELECT * FROM image_jobs WHERE status='running'").get() as
          | JobRow
          | undefined;
        if (running) {
          const sameProcess =
            running.owner_pid === process.pid && running.owner_token === processState.token;
          if (
            !(sameProcess
              ? processState.pending.has(key(running.id))
              : pidIsAlive(running.owner_pid))
          ) {
            const status = running.dispatched ? "outcome_unknown" : "failed";
            // 死 owner 不再发送；与正常完成共用结算，避免历史已终止而设置页仍显示旧试生成结果。
            settle(
              db,
              running,
              status,
              running.dispatched
                ? "Generation outcome is unknown. Create a new request to generate again."
                : "Generation stopped before dispatch.",
              undefined,
              running.dispatched ? "outcome_unknown" : "network_error",
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
  const connections = (db: DatabaseSync) =>
    (
      db.prepare("SELECT value FROM image_connections ORDER BY rowid").all() as { value: string }[]
    ).map((row) => JSON.parse(row.value) as StoredConnection);
  function settle(
    db: DatabaseSync,
    row: Pick<
      JobRow,
      "id" | "app_run_id" | "owner_pid" | "owner_token" | "snapshot" | "created_at"
    >,
    status: TerminalStatus,
    error?: string,
    asset?: { id: string; preview: string },
    code?: ImageGenerationErrorCode,
  ) {
    const updated = db
      .prepare(
        "UPDATE image_jobs SET status=?,error=?,asset_id=?,preview=?,error_code=? WHERE id=? AND status='running' AND app_run_id=? AND owner_pid=? AND owner_token=?",
      )
      .run(
        status,
        error ?? null,
        asset?.id ?? null,
        asset?.preview ?? null,
        code ?? null,
        row.id,
        row.app_run_id,
        row.owner_pid,
        row.owner_token,
      );
    if (updated.changes !== 1 || !row.snapshot) return;
    const snapshot = JSON.parse(row.snapshot) as GenerationSnapshot;
    if (snapshot.purpose !== "test") return;
    const current = db
      .prepare("SELECT value FROM image_connections WHERE id=? AND revision=?")
      .get(snapshot.connectionId, snapshot.revision) as { value: string } | undefined;
    if (!current) return;
    // 单飞令结算在下一次受理之前提交；不比较墙钟，时钟回拨也不能阻止更新。
    const connection = JSON.parse(current.value) as StoredConnection;
    connection.lastTrial = {
      operation: "trial",
      revision: snapshot.revision,
      modelKey: snapshot.modelKey,
      status,
      durationMs: Math.max(0, Date.now() - row.created_at),
      ranAt: row.created_at,
      ...(code ? { code } : {}),
    };
    db.prepare("UPDATE image_connections SET value=? WHERE id=? AND revision=?").run(
      JSON.stringify(connection),
      snapshot.connectionId,
      snapshot.revision,
    );
  }
  const getDefault = (db: DatabaseSync) =>
    JSON.parse(
      (db.prepare("SELECT value FROM image_meta WHERE key='default'").get() as { value: string })
        .value,
    ) as ImageGenerationDefaultSelection;
  function setDefault(
    db: DatabaseSync,
    input: { expectedRevision: number; selection: ImageGenerationSelection | null },
  ) {
    const current = getDefault(db);
    if (current.revision !== input.expectedRevision)
      throw new ImageGenerationError(
        "Image configuration changed. Refresh and confirm again.",
        "revision_conflict",
      );
    if (input.selection) {
      const c = connections(db).find(
        (entry) => entry.connectionId === input.selection!.connectionId,
      );
      if (
        !c?.enabled ||
        !c.models.some((m) => m.modelKey === input.selection!.modelKey && m.enabled)
      )
        throw new ImageGenerationError("Select an available image model.", "model_unavailable");
    }
    const result = { revision: current.revision + 1, selection: input.selection };
    db.prepare("UPDATE image_meta SET value=? WHERE key='default'").run(JSON.stringify(result));
    return result;
  }
  function requireDefault(db: DatabaseSync) {
    const selection = getDefault(db).selection;
    if (!selection) return;
    const c = connections(db).find((entry) => entry.connectionId === selection.connectionId);
    if (!c?.enabled || !c.models.some((m) => m.modelKey === selection.modelKey && m.enabled))
      throw new ImageGenerationError(
        "Replace or explicitly clear the default image model.",
        "model_unavailable",
      );
  }
  function replay(db: DatabaseSync, input: GenerationSnapshot) {
    const row = db.prepare("SELECT * FROM image_jobs WHERE request_id=?").get(input.requestId) as
      | JobRow
      | undefined;
    if (!row) return;
    if (!row.snapshot)
      throw new ImageGenerationError(
        "Request ID was already used by an earlier version.",
        "request_conflict",
      );
    const original = JSON.parse(row.snapshot) as GenerationSnapshot;
    const match =
      (
        ["prompt", "connectionId", "modelKey", "revision", "purpose", "sampleVersion"] as const
      ).every((field) => original[field] === input[field]) &&
      stableParameters(original.callerParameters ?? original.parameters) ===
        stableParameters(input.callerParameters);
    if (!match)
      throw new ImageGenerationError(
        "Request ID was already used with different input.",
        "request_conflict",
      );
    return projection(row);
  }
  return {
    track: (id) => processState.pending.add(key(id)),
    untrack: (id) => processState.pending.delete(key(id)),
    connections: () => transaction(connections),
    configuration: () =>
      transaction((db) => ({ connections: connections(db), defaultSelection: getDefault(db) })),
    migrated: () =>
      transaction((db) =>
        Boolean(db.prepare("SELECT value FROM image_meta WHERE key='credential-migrated'").get()),
      ),
    migrationCandidate: (ref) =>
      transaction((db) => {
        const staged = db
          .prepare("SELECT value FROM image_meta WHERE key='credential-migration-candidate'")
          .get() as { value: string } | undefined;
        if (staged) return staged.value;
        if (ref) {
          db.prepare("INSERT INTO image_credential_candidates VALUES(?)").run(ref);
          db.prepare("INSERT INTO image_meta VALUES('credential-migration-candidate',?)").run(ref);
        }
        return ref;
      }),
    migrateCredential: (ref) =>
      transaction((db) => {
        if (db.prepare("SELECT value FROM image_meta WHERE key='credential-migrated'").get())
          return;
        const official = connections(db).find((c) => c.connectionId === OFFICIAL_CONNECTION_ID)!;
        official.credentialRef = ref;
        db.prepare("UPDATE image_connections SET value=? WHERE id=?").run(
          JSON.stringify(official),
          official.connectionId,
        );
        db.prepare("INSERT INTO image_meta VALUES('credential-migrated','true')").run();
        db.prepare("DELETE FROM image_meta WHERE key='credential-migration-candidate'").run();
      }),
    candidate: (ref) =>
      transaction((db) => {
        db.prepare("INSERT OR IGNORE INTO image_credential_candidates VALUES(?)").run(ref);
      }),
    candidates: () =>
      transaction((db) =>
        (db.prepare("SELECT ref FROM image_credential_candidates").all() as { ref: string }[]).map(
          (r) => r.ref,
        ),
      ),
    removeCandidate: (ref) =>
      transaction((db) => {
        db.prepare("DELETE FROM image_credential_candidates WHERE ref=?").run(ref);
      }),
    publish: (connection, expected, change) =>
      transaction((db) => {
        const current = db
          .prepare("SELECT revision, value FROM image_connections WHERE id=?")
          .get(connection.connectionId) as { revision: number; value: string } | undefined;
        if ((current?.revision ?? null) !== expected)
          throw new ImageGenerationError(
            "Image configuration changed. Refresh and confirm again.",
            "revision_conflict",
          );
        // 探测/试生成可在密钥加密期间完成；合并事务开始时的最新结果，防止配置 CAS 覆盖已提交的诊断。
        const tests = current ? (JSON.parse(current.value) as StoredConnection) : undefined;
        const published = {
          ...connection,
          lastProbe: tests?.lastProbe,
          lastTrial: tests?.lastTrial,
        };
        db.prepare(
          "INSERT INTO image_connections(id,revision,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value",
        ).run(connection.connectionId, connection.revision, JSON.stringify(published));
        if (change) setDefault(db, change);
        requireDefault(db);
        return published;
      }),
    deleteConnection: (id, revision, change) =>
      transaction((db) => {
        if (
          db.prepare("DELETE FROM image_connections WHERE id=? AND revision=?").run(id, revision)
            .changes !== 1
        )
          throw new ImageGenerationError(
            "Image configuration changed. Refresh and confirm again.",
            "revision_conflict",
          );
        if (change) setDefault(db, change);
        requireDefault(db);
      }),
    setDefault: (input) => transaction((db) => setDefault(db, input)),
    beginProbe: (id, revision) =>
      transaction((db) => {
        if (
          db
            .prepare(
              "UPDATE image_connections SET probe_sequence=probe_sequence+1 WHERE id=? AND revision=?",
            )
            .run(id, revision).changes !== 1
        )
          throw new ImageGenerationError(
            "Image configuration changed. Refresh and confirm again.",
            "revision_conflict",
          );
        return (
          db.prepare("SELECT probe_sequence FROM image_connections WHERE id=?").get(id) as {
            probe_sequence: number;
          }
        ).probe_sequence;
      }),
    finishProbe: (id, revision, sequence, result) =>
      transaction((db) => {
        const row = db
          .prepare(
            "SELECT value FROM image_connections WHERE id=? AND revision=? AND probe_sequence=?",
          )
          .get(id, revision, sequence) as { value: string } | undefined;
        if (!row) return;
        const c = JSON.parse(row.value) as StoredConnection;
        c.lastProbe = result;
        db.prepare("UPDATE image_connections SET value=? WHERE id=?").run(JSON.stringify(c), id);
      }),
    getRequest: (id) =>
      transaction((db) => {
        const row = db.prepare("SELECT * FROM image_jobs WHERE request_id=?").get(id) as
          | JobRow
          | undefined;
        return row ? projection(row) : null;
      }),
    snapshot: (id) =>
      transaction((db) => {
        const row = db.prepare("SELECT snapshot FROM image_jobs WHERE request_id=?").get(id) as
          | { snapshot: string | null }
          | undefined;
        return row?.snapshot ? (JSON.parse(row.snapshot) as GenerationSnapshot) : null;
      }),
    replay: (input) => transaction((db) => replay(db, input)),
    readActive: () =>
      transaction((db) => {
        const row = db.prepare("SELECT * FROM image_jobs WHERE status='running'").get() as
          | JobRow
          | undefined;
        return row ? projection(row) : null;
      }),
    history: (input) =>
      transaction((db) => {
        let cursor: { upper: number; time: number; sort: number; purpose?: string } | undefined;
        if (input.cursor) {
          try {
            cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
          } catch {
            throw new ImageGenerationError("Invalid history cursor.");
          }
          if (
            !cursor ||
            !Number.isSafeInteger(cursor.upper) ||
            !Number.isSafeInteger(cursor.time) ||
            !Number.isSafeInteger(cursor.sort) ||
            cursor.purpose !== input.purpose
          )
            throw new ImageGenerationError("Invalid history cursor.");
        }
        const upper =
          cursor?.upper ??
          (
            db
              .prepare(
                "SELECT COALESCE(MAX(sort_key),0) AS upper FROM image_jobs WHERE status<>'running'",
              )
              .get() as {
              upper: number;
            }
          ).upper;
        const rows = db
          .prepare(
            `SELECT id,prompt,model_id,status,created_at,sort_key,asset_id,error,snapshot,purpose,error_code FROM image_jobs WHERE sort_key<=? AND status<>'running' AND (? IS NULL OR purpose=?) AND (created_at<? OR (created_at=? AND sort_key<?)) ORDER BY created_at DESC,sort_key DESC LIMIT 25`,
          )
          .all(
            upper,
            input.purpose ?? null,
            input.purpose ?? null,
            cursor?.time ?? Number.MAX_SAFE_INTEGER,
            cursor?.time ?? Number.MAX_SAFE_INTEGER,
            cursor?.sort ?? Number.MAX_SAFE_INTEGER,
          ) as unknown as JobRow[];
        const page = rows.slice(0, 24);
        const last = page.at(-1);
        return {
          jobs: page.map((row) => projection(row)),
          nextCursor:
            rows.length > 24 && last
              ? Buffer.from(
                  JSON.stringify({
                    upper,
                    time: last.created_at,
                    sort: last.sort_key,
                    ...(input.purpose ? { purpose: input.purpose } : {}),
                  }),
                ).toString("base64url")
              : null,
        };
      }),
    admit: (input) =>
      transaction((db) => {
        const existing = replay(db, input);
        if (existing) return { job: existing, accepted: false };
        const c = connections(db).find((entry) => entry.connectionId === input.connectionId);
        if (c?.revision !== input.revision)
          throw new ImageGenerationError(
            "Image configuration changed. Refresh and confirm again.",
            "revision_conflict",
          );
        if (!c.enabled || !c.models.some((m) => m.modelKey === input.modelKey && m.enabled))
          throw new ImageGenerationError("Select an available image model.", "model_unavailable");
        if (db.prepare("SELECT id FROM image_jobs WHERE status='running'").get())
          throw new ImageGenerationError("Another image generation is running.", "busy");
        const id = randomUUID();
        const created = Date.now();
        db.prepare(
          `INSERT INTO image_jobs(id,request_id,prompt,model_id,status,app_run_id,owner_pid,owner_token,created_at,sort_key,snapshot,purpose) VALUES(?,?,?,?,'running',?,?,?,?,(SELECT COALESCE(MAX(sort_key),0)+1 FROM image_jobs),?,?)`,
        ).run(
          id,
          input.requestId,
          input.prompt,
          input.modelId,
          ...own,
          created,
          JSON.stringify(input),
          input.purpose,
        );
        const row = db.prepare("SELECT * FROM image_jobs WHERE id=?").get(id) as unknown as JobRow;
        return { accepted: true, job: projection(row) };
      }),
    fence: (id) =>
      transaction(
        (db) =>
          db
            .prepare(
              "UPDATE image_jobs SET dispatched=1 WHERE id=? AND status='running' AND dispatched=0 AND app_run_id=? AND owner_pid=? AND owner_token=?",
            )
            .run(id, ...own).changes === 1,
      ),
    finish: (id, status, error, asset, code) =>
      transaction((db) => {
        const row = db
          .prepare(
            "SELECT id,app_run_id,owner_pid,owner_token,snapshot,created_at FROM image_jobs WHERE id=? AND status='running' AND app_run_id=? AND owner_pid=? AND owner_token=?",
          )
          .get(id, ...own) as Parameters<typeof settle>[1] | undefined;
        if (row) settle(db, row, status, error, asset, code);
      }),
    hasAsset: (id) =>
      transaction((db) =>
        Boolean(
          db.prepare("SELECT id FROM image_jobs WHERE asset_id=? AND status='succeeded'").get(id),
        ),
      ),
    preview: (id) =>
      transaction(
        (db) =>
          (
            db
              .prepare("SELECT preview FROM image_jobs WHERE asset_id=? AND status='succeeded'")
              .get(id) as { preview: string } | undefined
          )?.preview,
      ),
  };
}
