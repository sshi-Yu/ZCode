import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const owner = randomUUID();
let db;
function transaction(run) {
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
function view(row) {
  if (!row) return null;
  const result = { version: row.version, revision: row.revision, status: row.status };
  if (row.status === "ready") result.items = JSON.parse(row.items_json);
  return result;
}
function initialize() {
  db = new DatabaseSync(workerData.path);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  return transaction(() => {
    const schema = db.prepare("PRAGMA user_version").get().user_version;
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
      .map((row) => ({
        anchor: JSON.parse(row.anchor_key),
        version: row.version,
        revision: row.revision,
      }));
  });
}
function currentOwner() {
  return db.prepare("SELECT token FROM runtime_owner WHERE singleton=1").get()?.token === owner;
}
function latest(key) {
  return db
    .prepare("SELECT * FROM versions WHERE anchor_key=? ORDER BY version DESC LIMIT 1")
    .get(key);
}
function claim({ key, requestId, kind }) {
  return transaction(() => {
    if (!currentOwner()) throw new Error("owner-lost");
    const receipt = db
      .prepare(`SELECT v.* FROM request_receipts r JOIN versions v
      ON r.anchor_key=v.anchor_key AND r.version=v.version WHERE r.anchor_key=? AND r.request_id=?`)
      .get(key, requestId);
    if (receipt) return { claimed: false, result: view(receipt) };
    const recent = latest(key);
    let row =
      kind === "completed"
        ? recent
        : db.prepare("SELECT * FROM versions WHERE anchor_key=? AND status='generating'").get(key);
    let claimed = false;
    if (!row) {
      const version = (recent?.version ?? 0) + 1;
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
    // 在途合并的点击也写收据，避免它在结算后重投时意外追加版本。
    db.prepare("INSERT INTO request_receipts VALUES (?,?,?)").run(key, requestId, row.version);
    return { claimed, claimId: claimed ? row.claim_id : undefined, result: view(row) };
  });
}
function settle({ key, version, claimId, outcome }) {
  return transaction(() => {
    if (!currentOwner()) return null;
    const row = db
      .prepare(`UPDATE versions SET status=?,revision=revision+1,settled_at=?,provider_id=?,model_id=?,error_code=?,items_json=?
      WHERE anchor_key=? AND version=? AND owner=? AND claim_id=? AND status='generating' RETURNING *`)
      .get(
        outcome.status,
        Date.now(),
        outcome.model?.providerId ?? null,
        outcome.model?.modelId ?? null,
        outcome.errorCode ?? null,
        outcome.status === "ready" ? JSON.stringify(outcome.items) : null,
        key,
        version,
        owner,
        claimId,
      );
    return view(row);
  });
}
function fence() {
  return transaction(() => {
    if (!currentOwner()) return [];
    db.prepare("UPDATE runtime_owner SET token=? WHERE singleton=1 AND token=?").run(
      randomUUID(),
      owner,
    );
    return db
      .prepare(`UPDATE versions SET status='unknown',revision=revision+1,settled_at=?,error_code='owner-stopped'
      WHERE owner=? AND status='generating' RETURNING anchor_key,version,revision`)
      .all(Date.now(), owner)
      .map((row) => ({
        anchor: JSON.parse(row.anchor_key),
        version: row.version,
        revision: row.revision,
      }));
  });
}
try {
  parentPort.postMessage({ type: "ready", changes: initialize() });
  parentPort.on("message", ({ id, method, input }) => {
    try {
      let result;
      if (method === "read") result = view(latest(input.key));
      else if (method === "claim") result = claim(input);
      else if (method === "settle") result = settle(input);
      else if (method === "fence") result = fence();
      else if (method === "close") {
        db.close();
        result = null;
      } else throw new Error("invalid-operation");
      parentPort.postMessage({ id, result });
    } catch {
      parentPort.postMessage({ id, error: "NextStep storage operation failed" });
    }
  });
} catch {
  try {
    db?.close();
  } catch {
    /* 初始化失败不覆盖原有数据库。 */
  }
  parentPort.postMessage({ type: "failed" });
  parentPort.close();
}
