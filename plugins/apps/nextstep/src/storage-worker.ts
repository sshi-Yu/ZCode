import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type {
  Anchor,
  Change,
  ClaimInput,
  ClaimResult,
  SettleInput,
  SuggestionItem,
  VersionView,
  WorkerRequest,
  WorkerResponse,
} from "./types.js";
import { object } from "./content.js";

const port = parentPort;
if (!port) throw new Error("NextStep storage worker requires a parent port");
const owner = randomUUID();
let connection: DatabaseSync | undefined;
function database(): DatabaseSync {
  if (!connection) throw new Error("storage-unavailable");
  return connection;
}
function transaction<T>(run: () => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
type Row = Record<string, SQLOutputValue>;
function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("invalid-record");
  return value;
}
function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("invalid-record");
  return value;
}
function view(row: Row | undefined): VersionView | null {
  if (!row) return null;
  const version = integer(row, "version");
  const revision = integer(row, "revision");
  const status = string(row, "status");
  // 已结算数据是 SQLite 权威事实，保留旧版 5 条 ready 的内容与顺序，绝不重新验收/排序。
  if (status === "ready")
    return {
      version,
      revision,
      status,
      items: JSON.parse(string(row, "items_json")) as SuggestionItem[],
    };
  if (
    status === "generating" ||
    status === "empty" ||
    status === "failed" ||
    status === "unknown"
  ) {
    return { version, revision, status };
  }
  throw new Error("invalid-record");
}
function change(row: Row): Change {
  return {
    anchor: JSON.parse(string(row, "anchor_key")) as Anchor,
    version: integer(row, "version"),
    revision: integer(row, "revision"),
  };
}
function initialize(): Change[] {
  const data: unknown = workerData;
  if (!object(data) || typeof data.path !== "string") throw new Error("invalid-path");
  const db = new DatabaseSync(data.path);
  connection = db;
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  return transaction(() => {
    const schema = db.prepare("PRAGMA user_version").get()?.user_version;
    if (schema !== 0 && schema !== 1) throw new Error("unsupported-schema");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS versions (
        anchor_key TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),
        revision INTEGER NOT NULL CHECK(revision>=0),
        request_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('auto','manual')),
        owner TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('generating','ready','empty','failed','unknown')),
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        provider_id TEXT,
        model_id TEXT,
        error_code TEXT,
        items_json TEXT,
        PRIMARY KEY(anchor_key,version),
        UNIQUE(anchor_key,request_id),
        CHECK((status='ready' AND items_json IS NOT NULL) OR (status<>'ready' AND items_json IS NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_generating ON versions(anchor_key) WHERE status='generating';
      CREATE TABLE IF NOT EXISTS request_receipts (
        anchor_key TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(anchor_key,request_id),
        FOREIGN KEY(anchor_key,version) REFERENCES versions(anchor_key,version)
      ) STRICT;
      PRAGMA user_version=1;
    `);
    db.prepare(
      "INSERT INTO runtime_owner VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET token=excluded.token",
    ).run(owner);
    // App 只有一个扩展进程；新执行者不能重放失联请求，只能封存为 unknown。
    return db
      .prepare(`UPDATE versions SET status='unknown', revision=revision+1, settled_at=?, error_code='owner-lost'
      WHERE status='generating' RETURNING anchor_key,version,revision`)
      .all(Date.now())
      .map(change);
  });
}
function currentOwner(): boolean {
  return (
    database().prepare("SELECT token FROM runtime_owner WHERE singleton=1").get()?.token === owner
  );
}
function latest(key: string): Row | undefined {
  return database()
    .prepare("SELECT * FROM versions WHERE anchor_key=? ORDER BY version DESC LIMIT 1")
    .get(key);
}
function claim({ key, requestId, kind }: ClaimInput): ClaimResult {
  const db = database();
  return transaction(() => {
    if (!currentOwner()) throw new Error("owner-lost");
    const receipt = db
      .prepare(`SELECT v.* FROM request_receipts r JOIN versions v
      ON r.anchor_key=v.anchor_key AND r.version=v.version WHERE r.anchor_key=? AND r.request_id=?`)
      .get(key, requestId);
    const received = view(receipt);
    if (received) return { claimed: false, result: received };
    const recent = latest(key);
    let row =
      kind === "completed"
        ? recent
        : db.prepare("SELECT * FROM versions WHERE anchor_key=? AND status='generating'").get(key);
    let claimed = false;
    if (!row) {
      const version = (recent ? integer(recent, "version") : 0) + 1;
      if (!Number.isSafeInteger(version)) throw new Error("version-limit");
      db.prepare(`INSERT INTO versions (anchor_key,version,revision,request_id,trigger_type,owner,claim_id,status,created_at)
        VALUES (?,?,0,?,?,?,?,'generating',?)`).run(
        key,
        version,
        requestId,
        kind === "completed" ? "auto" : "manual",
        owner,
        randomUUID(),
        Date.now(),
      );
      row = latest(key);
      claimed = true;
    }
    const result = view(row);
    if (!row || !result) throw new Error("invalid-record");
    // 在途合并的点击也写收据，避免它在结算后重投时意外追加版本。
    db.prepare("INSERT INTO request_receipts VALUES (?,?,?)").run(
      key,
      requestId,
      integer(row, "version"),
    );
    return claimed
      ? { claimed: true, claimId: string(row, "claim_id"), result }
      : { claimed: false, result };
  });
}
function settle({ key, version, claimId, outcome }: SettleInput): VersionView | null {
  return transaction(() => {
    if (!currentOwner()) return null;
    const row = database()
      .prepare(`UPDATE versions SET status=?,revision=revision+1,settled_at=?,provider_id=?,model_id=?,error_code=?,items_json=?
      WHERE anchor_key=? AND version=? AND owner=? AND claim_id=? AND status='generating' RETURNING *`)
      .get(
        outcome.status,
        Date.now(),
        outcome.model?.providerId ?? null,
        outcome.model?.modelId ?? null,
        "errorCode" in outcome ? outcome.errorCode : null,
        outcome.status === "ready" ? JSON.stringify(outcome.items) : null,
        key,
        version,
        owner,
        claimId,
      );
    return view(row);
  });
}
function fence(): Change[] {
  return transaction(() => {
    if (!currentOwner()) return [];
    const db = database();
    db.prepare("UPDATE runtime_owner SET token=? WHERE singleton=1 AND token=?").run(
      randomUUID(),
      owner,
    );
    return db
      .prepare(`UPDATE versions SET status='unknown',revision=revision+1,settled_at=?,error_code='owner-stopped'
      WHERE owner=? AND status='generating' RETURNING anchor_key,version,revision`)
      .all(Date.now(), owner)
      .map(change);
  });
}
function respond(message: WorkerResponse): void {
  port?.postMessage(message);
}
try {
  respond({ type: "ready", changes: initialize() });
  port.on("message", (value: unknown) => {
    // 私有消息端口由 storage.ts 唯一写入，与同一份判别联合保持锁步。
    const { id, ...request } = value as WorkerRequest;
    try {
      let result: unknown;
      if (request.method === "read") result = view(latest(request.input.key));
      else if (request.method === "claim") result = claim(request.input);
      else if (request.method === "settle") result = settle(request.input);
      else if (request.method === "fence") result = fence();
      else if (request.method === "close") {
        database().close();
        result = null;
      } else throw new Error("invalid-operation");
      respond({ id, result });
    } catch {
      respond({ id, error: "NextStep storage operation failed" });
    }
  });
} catch {
  try {
    connection?.close();
  } catch {
    /* 初始化失败不覆盖原有数据库。 */
  }
  respond({ type: "failed" });
  port.close();
}
