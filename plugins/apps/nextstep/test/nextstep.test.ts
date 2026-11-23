import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Anchor,
  ClaimResult,
  SuggestionItem,
  TriggerKind,
  VersionView,
} from "../src/types.js";

// 宿主先快照整个市场、再复制选中的插件；回归只加载脱离源码树的安装产物。
type EntryModule = typeof import("../src/index.js");
type StorageModule = typeof import("../src/storage.js");
const installation = await mkdtemp(join(tmpdir(), "nextstep-install-"));
after(async () => {
  await rm(installation, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
});
await cp(new URL("../dist/market/", import.meta.url), join(installation, "market"), {
  recursive: true,
});
const installedPlugin = join(installation, "installed", "nextstep");
await cp(join(installation, "market", "nextstep"), installedPlugin, { recursive: true });
const distRoot = pathToFileURL(`${join(installedPlugin, "dist")}/`);
const root = fileURLToPath(new URL("../", import.meta.url));
const anchor: Anchor = Object.freeze({
  workspaceKey: "workspace-identity",
  sessionId: "session-one",
  productTurnId: "turn-one",
  assistantMessageId: "assistant-one",
});
const candidates = [
  { dimension: "验证", label: "补充边界验收", prompt: "请验证刚才实现的边界场景。" },
  { dimension: "文档", label: "整理使用说明", prompt: "请根据刚才的实现整理使用说明。" },
];
// ID 公式与实现保持一致：SHA-256(JSON.stringify([anchorKey, version, item]))，item 不含 id。
const expectedId = (version: number, item: { dimension: string; label: string; prompt: string }) =>
  createHash("sha256")
    .update(JSON.stringify([JSON.stringify(anchor), version, item]))
    .digest("hex");
const ok = (items: readonly unknown[] = candidates) => ({
  status: "ok",
  text: JSON.stringify({ items }),
  model: { providerId: "fixture-provider", modelId: "fixture-model" },
});
const history = {
  messages: [
    { role: "user", text: "private-task-only-in-memory" },
    { role: "assistant", text: "private-answer-only-in-memory" },
  ],
};
function deferred<T = unknown>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: { resolve(value: T): void } | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = { resolve };
  });
  return { promise, resolve: (value) => settle?.resolve(value) };
}
function prop(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null
    ? (source as Record<string, unknown>)[key]
    : undefined;
}
function readyView(view: VersionView | null): {
  version: number;
  revision: number;
  items: SuggestionItem[];
} {
  assert.ok(view);
  assert.equal(view.status, "ready");
  if (view.status !== "ready") throw new Error("unreachable");
  return view;
}
async function loadPlugin(suffix = ""): Promise<EntryModule> {
  // 市场产物是纯 ESM，没有类型文件；以源码模块导出描述其契约。
  const plugin = (await import(new URL(`index.mjs${suffix}`, distRoot).href).catch(
    (error: NodeJS.ErrnoException) => {
      if (error?.code === "ERR_MODULE_NOT_FOUND") return {} as Partial<EntryModule>;
      throw error;
    },
  )) as Partial<EntryModule>;
  assert.equal(typeof plugin.activate, "function", "NextStep must export an executable activate()");
  return plugin as EntryModule;
}
async function loadStorage(): Promise<StorageModule> {
  return (await import(new URL("storage.mjs", distRoot).href)) as StorageModule;
}
type FixtureOverrides = {
  history?: (input: { permit: string }) => unknown;
  generate?: (input: { permit: string; text: string; maxOutputTokens: number }) => unknown;
  invalidate?: (change: unknown) => unknown;
};
interface HostHarness {
  ctx: object;
  calls: { history: unknown[]; generate: unknown[]; invalidate: unknown[]; log: unknown[][] };
  call(args: unknown): Promise<unknown>;
  read: (target?: Anchor) => Promise<VersionView | null>;
  start(kind?: TriggerKind, requestId?: string, target?: Anchor): Promise<unknown>;
  commands: Map<string, (call: unknown) => unknown>;
  module?: EntryModule;
}
async function fixture(t: { after(hook: () => Promise<void>): void }) {
  const plugin = await loadPlugin();
  const dataPath = await mkdtemp(join(root, "test", ".data-"));
  const hosts: HostHarness[] = [];
  function host(overrides: FixtureOverrides = {}): HostHarness {
    const commands = new Map<string, (call: unknown) => unknown>();
    const calls = {
      history: [] as unknown[],
      generate: [] as unknown[],
      invalidate: [] as unknown[],
      log: [] as unknown[][],
    };
    const ctx = {
      extension: { id: "nextstep@fixture", version: "0.1.2", path: installedPlugin, dataPath },
      log: Object.fromEntries(
        (["info", "warn", "error"] as const).map((level) => [
          level,
          (...args: unknown[]) => {
            calls.log.push(args);
          },
        ]),
      ),
      commands: {
        register(id: string, run: (call: unknown) => unknown) {
          assert.equal(id, "nextstep");
          assert.equal(commands.has(id), false);
          commands.set(id, run);
          return {
            dispose: () => {
              commands.delete(id);
            },
          };
        },
      },
      turnFooter: {
        async history(input: { permit: string }) {
          calls.history.push(input);
          return (overrides.history ?? (() => history))(input);
        },
        async generate(input: { permit: string; text: string; maxOutputTokens: number }) {
          calls.generate.push(input);
          return (overrides.generate ?? (() => ok()))(input);
        },
        async invalidate(input: unknown) {
          calls.invalidate.push(input);
          await overrides.invalidate?.(input);
        },
      },
    };
    const call = async (args: unknown): Promise<unknown> => {
      assert.equal(commands.has("nextstep"), true, "command must be registered");
      const run = commands.get("nextstep");
      assert.ok(run);
      return run({ scope: { kind: "app" }, args });
    };
    const read = (target: Anchor = anchor): Promise<VersionView | null> =>
      call({ kind: "readLatest", anchor: target }) as Promise<VersionView | null>;
    const start = (
      kind: TriggerKind = "completed",
      requestId = "request-one",
      target: Anchor = anchor,
    ): Promise<unknown> => call({ kind, anchor: target, requestId, permit: `permit-${requestId}` });
    const result: HostHarness = { ctx, calls, call, read, start, commands };
    hosts.push(result);
    return result;
  }
  t.after(async () => {
    await plugin.deactivate();
    for (const entry of hosts) await entry.module?.deactivate();
    await rm(dataPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  });
  return { plugin, host, dataPath };
}
function settledView(value: VersionView | null): boolean {
  return value !== null && value?.status !== "generating";
}
async function until<T = VersionView | null>(
  read: () => Promise<T>,
  predicate?: (value: T) => boolean,
): Promise<T> {
  const done = predicate ?? ((value: T) => settledView(value as VersionView | null));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("NextStep did not reach the expected durable state");
}
interface VersionRecord {
  anchor_key: string;
  version: number;
  revision: number;
  request_id: string;
  trigger_type: string;
  owner: string;
  claim_id: string;
  status: string;
  created_at: number;
  settled_at: number | null;
  provider_id: string | null;
  model_id: string | null;
  error_code: string | null;
  items_json: string | null;
}
function records(dataPath: string): VersionRecord[] {
  const db = new DatabaseSync(join(dataPath, "nextstep.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM versions ORDER BY version")
      .all() as unknown as VersionRecord[];
  } finally {
    db.close();
  }
}
function grantedClaim(claim: ClaimResult): { claimId: string; result: VersionView } {
  assert.equal(claim.claimed, true);
  if (claim.claimed !== true) throw new Error("unreachable");
  return claim;
}

void test("readLatest never reads history or generates and unknown anchors return null", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const h = host();
  await plugin.activate(h.ctx);
  assert.equal(await h.read(), null);
  assert.equal(await h.read(), null);
  assert.equal(h.calls.history.length, 0);
  assert.equal(h.calls.generate.length, 0);
  assert.deepEqual(
    (await readdir(dataPath)).filter((name) => name.endsWith(".sqlite")),
    ["nextstep.sqlite"],
  );
});

void test("manual/auto races have one durable claim and merged requestIds never replay generation", async (t) => {
  for (const first of ["completed", "refresh"] as const) {
    const { plugin, host, dataPath } = await fixture(t);
    const gate = deferred();
    const h = host({ generate: () => gate.promise });
    await plugin.activate(h.ctx);
    const kinds: TriggerKind[] =
      first === "refresh"
        ? ["refresh", "completed", "refresh"]
        : ["completed", "refresh", "completed"];
    const claims = await Promise.all(kinds.map((kind, i) => h.start(kind, `race-${i}`)));
    assert.deepEqual(claims, Array(3).fill({ version: 1, revision: 0, status: "generating" }));
    await until(
      async () => h.calls.generate.length,
      (n) => n === 1,
    );
    gate.resolve(ok());
    const settled = await until(h.read);
    assert.equal(settled?.status, "ready");
    assert.equal(records(dataPath)[0]?.trigger_type, first === "refresh" ? "manual" : "auto");
    for (let i = 0; i < 3; i++) assert.deepEqual(await h.start(kinds[i], `race-${i}`), settled);
    assert.deepEqual(await h.start("completed", "later-auto"), settled);
    assert.equal(h.calls.generate.length, 1);
    assert.equal(records(dataPath).length, 1);
    await plugin.deactivate();
  }
});

void test("reopen reads the latest failed or unknown version without falling back or regenerating", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  let response: unknown = ok();
  const h = host({ generate: () => response });
  await plugin.activate(h.ctx);
  await h.start();
  const first = readyView(await until(h.read));
  response = { status: "failed", code: "provider-unavailable" };
  await h.start("refresh", "manual-two");
  assert.deepEqual(await until(h.read), { version: 2, revision: 1, status: "failed" });
  response = { status: "unknown", code: "timeout" };
  await h.start("refresh", "manual-three");
  assert.deepEqual(await until(h.read), { version: 3, revision: 1, status: "unknown" });
  await plugin.deactivate();
  const reopened = host();
  await plugin.activate(reopened.ctx);
  assert.deepEqual(await reopened.read(), { version: 3, revision: 1, status: "unknown" });
  assert.equal(reopened.calls.generate.length, 0);
  assert.equal(reopened.calls.history.length, 0);
  assert.deepEqual(await reopened.start("refresh", "manual-two"), {
    version: 2,
    revision: 1,
    status: "failed",
  });
  assert.equal(records(dataPath).length, 3);
  assert.equal(first.items.length, 2);
});

void test("ready IDs are unique, persisted and stable across reads and activation", async (t) => {
  const { plugin, host } = await fixture(t);
  const h = host();
  await plugin.activate(h.ctx);
  await h.start();
  const first = readyView(await until(h.read));
  assert.equal(new Set(first.items.map((item) => item.id)).size, 2);
  assert.ok(first.items.every((item) => item.id.length <= 200));
  assert.deepEqual(
    first.items.map(({ id: _id, ...item }) => item),
    candidates,
  );
  assert.deepEqual(await h.read(), first);
  await plugin.deactivate();
  const reopened = host();
  await plugin.activate(reopened.ctx);
  assert.deepEqual(await reopened.read(), first);
  assert.equal(reopened.calls.generate.length, 0);
});

void test("partial candidate acceptance keeps valid unique dimensions when at least two survive", async (t) => {
  const { plugin, host } = await fixture(t);
  const h = host({
    generate: () =>
      ok([
        candidates[0],
        { ...candidates[0], dimension: " 验证 " },
        { dimension: "invalid", label: "x".repeat(101), prompt: "bad" },
        { dimension: "unsafe", label: "工具", prompt: "bad", tool: "shell" },
        candidates[1],
      ]),
  });
  await plugin.activate(h.ctx);
  await h.start();
  const result = readyView(await until(h.read));
  assert.deepEqual(
    result.items.map(({ id: _id, ...item }) => item),
    candidates,
  );
  assert.equal(h.calls.generate.length, 1);
});

void test("ready items sort ascending by label Unicode code points with ties keeping original order", async (t) => {
  const raw = [
    { dimension: "庆祝", label: "🎉🎉🎉", prompt: "请总结本次里程碑。" },
    { dimension: "验证", label: "验证一下", prompt: "请验证关键路径。" },
    { dimension: "分析", label: "写作", prompt: "请分析结果。" },
    { dimension: "深化", label: "深入讲解", prompt: "请深入讲解取舍。" },
  ] as const;
  const { plugin, host } = await fixture(t);
  const h = host({ generate: () => ok(raw) });
  await plugin.activate(h.ctx);
  await h.start();
  const result = readyView(await until(h.read));
  // 🎉 是 1 个码点、2 个 UTF-16 单元：按码点排第 2，按 UTF-16 单元会落到最后；两条 4 码点并列保持原顺序。
  const expected = [raw[2], raw[0], raw[1], raw[3]];
  assert.deepEqual(
    result.items,
    expected.map((item) => ({ id: expectedId(1, item), ...item })),
  );
  assert.equal(h.calls.generate.length, 1);
});

void test("five valid candidates settle to the first four sorted items with unchanged SHA ids", async (t) => {
  const raw = [
    { dimension: "扩展", label: "一二三四五六", prompt: "请扩展实现范围。" },
    { dimension: "验证", label: "一二三四五", prompt: "请验证关键路径。" },
    { dimension: "分析", label: "一二三四", prompt: "请分析实现结果。" },
    { dimension: "深化", label: "一二三", prompt: "请深化某个设计。" },
    { dimension: "写作", label: "一二", prompt: "请整理成文档。" },
  ] as const;
  const { plugin, host, dataPath } = await fixture(t);
  const h = host({ generate: () => ok(raw) });
  await plugin.activate(h.ctx);
  await h.start();
  const result = readyView(await until(h.read));
  const expected = [raw[4], raw[3], raw[2], raw[1]].map((item) => ({
    id: expectedId(1, item),
    ...item,
  }));
  assert.deepEqual(result.items, expected);
  assert.equal(
    result.items.some((item) => String(item.label) === "一二三四五六"),
    false,
  );
  const [row] = records(dataPath);
  assert.ok(row);
  assert.equal(row.status, "ready");
  assert.deepEqual(JSON.parse(row.items_json ?? "null"), expected);
  assert.equal(h.calls.generate.length, 1);
});

void test("reopening storage returns a settled legacy five-item version unchanged without model calls", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  // 模拟 0.1.0 保存的 ready 记录：5 条、未按新规则排序；读取路径不得重排或截取。
  const legacy = [
    { dimension: "扩展", label: "一二三四五六", prompt: "legacy-6" },
    { dimension: "验证", label: "一二三四五", prompt: "legacy-5" },
    { dimension: "分析", label: "一二三四", prompt: "legacy-4" },
    { dimension: "深化", label: "一二三", prompt: "legacy-3" },
    { dimension: "写作", label: "一二", prompt: "legacy-2" },
  ].map((item, index) => ({ id: `legacy-id-${index}`, ...item }));
  const { openStorage } = await loadStorage();
  const storage = await openStorage(join(dataPath, "nextstep.sqlite"));
  try {
    const key = JSON.stringify(anchor);
    const claim = grantedClaim(
      await storage.claim({ key, requestId: "legacy-request", kind: "refresh" }),
    );
    assert.deepEqual(
      await storage.settle({
        key,
        version: 1,
        claimId: claim.claimId,
        outcome: { status: "ready", items: legacy },
      }),
      { version: 1, revision: 1, status: "ready", items: legacy },
    );
  } finally {
    await storage.close();
  }
  const h = host();
  await plugin.activate(h.ctx);
  assert.deepEqual(await h.read(), { version: 1, revision: 1, status: "ready", items: legacy });
  assert.deepEqual(await h.read(), { version: 1, revision: 1, status: "ready", items: legacy });
  assert.equal(h.calls.history.length, 0);
  assert.equal(h.calls.generate.length, 0);
  const rows = records(dataPath);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0]?.items_json ?? "null"), legacy);
});

void test("generation prompt requests two to four dimensions and never the retired five-item wording", async (t) => {
  const { plugin, host } = await fixture(t);
  const h = host();
  await plugin.activate(h.ctx);
  await h.start();
  assert.equal((await until(h.read))?.status, "ready");
  const [request] = h.calls.generate;
  assert.ok(request);
  const text = prop(request, "text");
  if (typeof text !== "string") assert.fail("generation text must be a string");
  assert.ok(text.includes("2 to 4 different dimensions"), "prompt must cap dimensions at four");
  assert.equal(text.includes("2 to 5"), false);
});

void test("invalid output settles failed with no second model call and only explicit empty is empty", async (t) => {
  const outputs = [
    "not JSON",
    '```json\n{"items": []}\n```',
    "null",
    "[]",
    '{"items": [], "send": true}',
    JSON.stringify({ items: [candidates[0]] }),
    JSON.stringify({ items: Array(6).fill(candidates[0]) }),
    JSON.stringify({ items: [candidates[0], { ...candidates[1], prompt: "x".repeat(4001) }] }),
    JSON.stringify({ items: [candidates[0], { ...candidates[1], dimension: "x".repeat(61) }] }),
    JSON.stringify({ items: [candidates[0], { ...candidates[1], label: " " }] }),
    JSON.stringify({ items: [candidates[0], { ...candidates[1], dimension: " 验证 " }] }),
  ];
  const { plugin, host } = await fixture(t);
  let text: string | undefined;
  const h = host({ generate: () => ({ ...ok(), text }) });
  await plugin.activate(h.ctx);
  for (const [index, output] of outputs.entries()) {
    text = output;
    await h.start("refresh", `invalid-${index}`);
    assert.deepEqual(await until(h.read), { version: index + 1, revision: 1, status: "failed" });
  }
  text = '{"items":[]}';
  await h.start("refresh", "explicit-empty");
  assert.deepEqual(await until(h.read), {
    version: outputs.length + 1,
    revision: 1,
    status: "empty",
  });
  assert.equal(h.calls.generate.length, outputs.length + 1);
});

void test("authoritative history and permit are used once, prompt stays within budget and private payload is not retained", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const h = host({
    history: () => ({
      messages: [
        { role: "user", text: "old-context".repeat(1200) },
        { role: "assistant", text: "old-answer".repeat(900) },
        ...history.messages,
      ],
    }),
  });
  await plugin.activate(h.ctx);
  await h.start();
  assert.equal((await until(h.read))?.status, "ready");
  assert.deepEqual(h.calls.history, [{ permit: "permit-request-one" }]);
  const [raw] = h.calls.generate;
  assert.ok(raw);
  const input = raw as { permit: string; text: string; maxOutputTokens: number };
  assert.deepEqual(Object.keys(input).sort(), ["maxOutputTokens", "permit", "text"]);
  assert.equal(input.permit, "permit-request-one");
  assert.equal(input.maxOutputTokens, 1600);
  assert.ok(input.text.length <= 24000);
  assert.ok(input.text.includes("private-task-only-in-memory"));
  assert.ok(input.text.includes("private-answer-only-in-memory"));
  assert.ok(
    input.text.indexOf("private-task-only-in-memory") <
      input.text.indexOf("private-answer-only-in-memory"),
  );
  const [row] = records(dataPath);
  assert.ok(row);
  assert.equal(row.provider_id, "fixture-provider");
  assert.equal(row.model_id, "fixture-model");
  await plugin.deactivate();
  for (const filename of await readdir(dataPath)) {
    const bytes = await readFile(join(dataPath, filename));
    for (const secret of [
      "private-task-only-in-memory",
      "private-answer-only-in-memory",
      "permit-request-one",
    ])
      assert.equal(bytes.includes(Buffer.from(secret)), false, `${secret} must not be persisted`);
  }
});

void test("malformed history fails before model use and non-actionable history settles empty", async (t) => {
  const { plugin, host } = await fixture(t);
  let value: unknown = { messages: [{ role: "tool", text: "not allowed" }] };
  const h = host({ history: () => value });
  await plugin.activate(h.ctx);
  await h.start();
  assert.deepEqual(await until(h.read), { version: 1, revision: 1, status: "failed" });
  value = { messages: [] };
  await h.start("refresh", "empty-history");
  assert.deepEqual(await until(h.read), { version: 2, revision: 1, status: "empty" });
  assert.equal(h.calls.generate.length, 0);
});

void test("provider errors do not leak raw codes, throwing generate is unknown and invalid ok still records actual model", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  let result: unknown = { status: "failed", code: "sensitive-provider-detail" };
  const h = host({
    generate: () => {
      if (result instanceof Error) throw result;
      return result;
    },
  });
  await plugin.activate(h.ctx);
  await h.start();
  assert.deepEqual(await until(h.read), { version: 1, revision: 1, status: "failed" });
  result = new Error("sensitive-provider-detail");
  await h.start("refresh", "throw");
  assert.deepEqual(await until(h.read), { version: 2, revision: 1, status: "unknown" });
  result = { ...ok(), text: "sensitive-invalid-raw-output" };
  await h.start("refresh", "bad-output");
  assert.deepEqual(await until(h.read), { version: 3, revision: 1, status: "failed" });
  const rows = records(dataPath);
  const row = rows[2];
  assert.ok(row);
  assert.equal(row.provider_id, "fixture-provider");
  assert.equal(row.model_id, "fixture-model");
  assert.equal(JSON.stringify(rows).includes("sensitive-"), false);
});

void test("actual model metadata survives malformed generation envelopes without accepting their payload", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const h = host({ generate: () => ({ ...ok(), text: "x".repeat(16001) }) });
  await plugin.activate(h.ctx);
  await h.start();
  assert.deepEqual(await until(h.read), { version: 1, revision: 1, status: "unknown" });
  const [row] = records(dataPath);
  assert.ok(row);
  assert.equal(row.provider_id, "fixture-provider");
  assert.equal(row.model_id, "fixture-model");
  assert.equal(row.items_json, null);
  assert.equal(h.calls.generate.length, 1);
});

void test("a newer database schema is rejected without changing existing rows or schema version", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const h = host();
  await plugin.activate(h.ctx);
  await h.start();
  await until(h.read);
  await plugin.deactivate();
  const db = new DatabaseSync(join(dataPath, "nextstep.sqlite"));
  db.exec("PRAGMA user_version=99");
  db.close();
  const before = records(dataPath);
  await assert.rejects(plugin.activate(host().ctx), { message: "NextStep storage unavailable" });
  const reopened = new DatabaseSync(join(dataPath, "nextstep.sqlite"));
  assert.equal(Number(reopened.prepare("PRAGMA user_version").get()?.user_version), 99);
  reopened.close();
  assert.deepEqual(records(dataPath), before);
});

void test("claim and settlement invalidation happen after durable commits even when notifications throw", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const observed: unknown[] = [];
  const h = host({
    invalidate: (change: unknown) => {
      const row = records(dataPath).find((record) => record.version === prop(change, "version"));
      assert.ok(row);
      observed.push({
        ...(change as Record<string, unknown>),
        status: row.status,
        durableRevision: row.revision,
      });
      throw new Error("notification port gone");
    },
  });
  await plugin.activate(h.ctx);
  assert.deepEqual(await h.start(), { version: 1, revision: 0, status: "generating" });
  await until(h.read);
  await until(
    async () => observed.length,
    (n) => n === 2,
  );
  assert.deepEqual(observed, [
    { anchor, version: 1, revision: 0, status: "generating", durableRevision: 0 },
    { anchor, version: 1, revision: 1, status: "ready", durableRevision: 1 },
  ]);
  assert.equal(h.calls.generate.length, 1);
});

void test("a stalled invalidation does not block generation or settlement", async (t) => {
  const { plugin, host } = await fixture(t);
  const gate = deferred();
  const h = host({ invalidate: () => gate.promise });
  await plugin.activate(h.ctx);
  await h.start();
  try {
    assert.equal((await until(h.read))?.status, "ready");
    assert.equal(h.calls.generate.length, 1);
  } finally {
    gate.resolve(undefined);
  }
});

void test("editor and session switches do not cancel an admitted generation", async (t) => {
  const { plugin, host } = await fixture(t);
  const gate = deferred();
  const h = host({ generate: () => gate.promise });
  await plugin.activate(h.ctx);
  await h.start();
  await until(
    async () => h.calls.generate.length,
    (n) => n === 1,
  );
  const other: Anchor = { ...anchor, sessionId: "other-editor" };
  assert.equal(await h.read(other), null);
  gate.resolve(ok());
  assert.equal((await until(h.read))?.status, "ready");
  assert.equal(h.calls.generate.length, 1);
});

void test("actual reload fences in-flight generation to unknown and late results cannot overwrite a new version", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve(ok()));
  const { plugin, host, dataPath } = await fixture(t);
  const h = host({ generate: () => gate.promise });
  await plugin.activate(h.ctx);
  await h.start();
  await until(
    async () => h.calls.generate.length,
    (n) => n === 1,
  );
  await plugin.deactivate();
  assert.equal(h.commands.size, 0);
  assert.equal(records(dataPath)[0]?.status, "unknown");
  const replacement = await loadPlugin("?replacement");
  const reopened = host();
  reopened.module = replacement;
  await replacement.activate(reopened.ctx);
  assert.deepEqual(await reopened.read(), { version: 1, revision: 1, status: "unknown" });
  assert.deepEqual(await reopened.start(), { version: 1, revision: 1, status: "unknown" });
  assert.equal(reopened.calls.generate.length, 0);
  await reopened.start("refresh", "after-reload");
  const latest = await until(reopened.read);
  assert.equal(latest?.version, 2);
  assert.equal(latest?.status, "ready");
  gate.resolve(ok());
  await until(
    async () => h.calls.log.length,
    (n) => n > 0,
  );
  assert.deepEqual(await reopened.read(), latest);
  const rows = records(dataPath);
  assert.equal(rows[0]?.items_json, null);
  assert.equal(new Set(rows.map((row) => row.claim_id)).size, 2);
  assert.ok(rows.every((row) => /^[a-f0-9-]{36}$/.test(row.claim_id)));
  assert.equal(h.calls.generate.length, 1);
});

void test("reload while history is pending never calls generate through the disposed context", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve(history));
  const { plugin, host } = await fixture(t);
  const h = host({ history: () => gate.promise });
  await plugin.activate(h.ctx);
  await h.start();
  await until(
    async () => h.calls.history.length,
    (n) => n === 1,
  );
  await plugin.deactivate();
  const replacement = await loadPlugin("?history-replacement");
  const reopened = host();
  reopened.module = replacement;
  await replacement.activate(reopened.ctx);
  assert.deepEqual(await reopened.read(), { version: 1, revision: 1, status: "unknown" });
  gate.resolve(history);
  await until(
    async () => h.calls.log.length,
    (n) => n > 0,
  );
  assert.equal(h.calls.generate.length, 0);
  assert.equal(reopened.calls.generate.length, 0);
  assert.equal(reopened.calls.history.length, 0);
});

void test("settlement requires the individual claim UUID as well as its execution owner", async (t) => {
  const { dataPath } = await fixture(t);
  const { openStorage } = await loadStorage();
  const storage = await openStorage(join(dataPath, "nextstep.sqlite"));
  try {
    const key = JSON.stringify(anchor);
    const claim = grantedClaim(await storage.claim({ key, requestId: "fenced", kind: "refresh" }));
    assert.match(claim.claimId, /^[a-f0-9-]{36}$/);
    assert.equal(
      await storage.settle({
        key,
        version: 1,
        claimId: "wrong-claim",
        outcome: { status: "empty" },
      }),
      null,
    );
    assert.deepEqual(await storage.read(key), { version: 1, revision: 0, status: "generating" });
    assert.deepEqual(
      await storage.settle({
        key,
        version: 1,
        claimId: claim.claimId,
        outcome: { status: "empty" },
      }),
      { version: 1, revision: 1, status: "empty" },
    );
  } finally {
    await storage.close();
  }
});

void test("restart recovers orphaned work to unknown and does not replay its original request", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const child = fork(
    fileURLToPath(new URL("./fixtures/interrupted.ts", import.meta.url)),
    [dataPath, new URL("index.mjs", distRoot).href],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const started = (await Promise.race([
    once(child, "message"),
    once(child, "exit").then(([code]) =>
      assert.fail(`interrupted fixture exited ${String(code)}: ${stderr}`),
    ),
  ])) as unknown[];
  assert.equal(prop(started[0], "type"), "generating");
  child.kill("SIGKILL");
  await once(child, "exit");
  const h = host();
  await plugin.activate(h.ctx);
  assert.deepEqual(await h.read(), { version: 1, revision: 1, status: "unknown" });
  assert.deepEqual(await h.start("completed", "interrupted"), {
    version: 1,
    revision: 1,
    status: "unknown",
  });
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.history.length, 0);
  assert.equal(prop(h.calls.invalidate[0], "revision"), 1);
  await h.start("refresh", "after-restart");
  assert.equal((await until(h.read))?.version, 2);
  assert.equal(h.calls.generate.length, 1);
});

void test("owner fence prevents stale settlement after another process has recovered the claim", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const gate = deferred();
  const h = host({ generate: () => gate.promise });
  await plugin.activate(h.ctx);
  await h.start();
  await until(
    async () => h.calls.generate.length,
    (n) => n === 1,
  );
  const child = fork(
    fileURLToPath(new URL("./fixtures/recover.ts", import.meta.url)),
    [dataPath, new URL("index.mjs", distRoot).href],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const [code] = (await once(child, "exit")) as unknown[];
  assert.equal(code, 0, stderr);
  gate.resolve(ok());
  await until(
    async () => h.calls.log.length,
    (n) => n > 0,
  );
  assert.deepEqual(await h.read(), { version: 1, revision: 1, status: "unknown" });
  assert.equal(records(dataPath)[0]?.items_json, null);
});

void test("all four anchor fields isolate results and SQL-like IDs remain inert data", async (t) => {
  const { plugin, host } = await fixture(t);
  const h = host();
  await plugin.activate(h.ctx);
  await h.start();
  await until(h.read);
  for (const key of Object.keys(anchor) as (keyof Anchor)[]) {
    const other: Anchor = { ...anchor, [key]: "different'); DROP TABLE versions;--" };
    assert.equal(await h.read(other), null);
    const isolated = (await h.start("refresh", `isolated-${key}`, other)) as { version: number };
    assert.equal(isolated.version, 1);
    assert.equal((await until(() => h.read(other)))?.status, "ready");
  }
  assert.equal((await h.read())?.status, "ready");
});

void test("malformed commands reject without storage writes, history reads or generation", async (t) => {
  const { plugin, host, dataPath } = await fixture(t);
  const h = host();
  await plugin.activate(h.ctx);
  for (const args of [
    null,
    {},
    { kind: "send", anchor },
    { kind: "readLatest", anchor, permit: "forbidden" },
    { kind: "readLatest", anchor: { ...anchor, workspaceKey: "" } },
    { kind: "readLatest", anchor: { ...anchor, sessionId: "x".repeat(201) } },
    { kind: "readLatest", anchor: { ...anchor, extra: "bad" } },
    { kind: "completed", anchor, requestId: "id" },
    { kind: "refresh", anchor, requestId: "", permit: "valid" },
    { kind: "refresh", anchor, requestId: "id", permit: "x".repeat(201) },
  ]) {
    await assert.rejects(async () => h.call(args), { message: "Invalid NextStep command" });
  }
  assert.equal(records(dataPath).length, 0);
  assert.equal(h.calls.generate.length, 0);
  assert.equal(h.calls.history.length, 0);
});
