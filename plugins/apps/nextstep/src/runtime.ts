import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  anchorKey,
  buildPrompt,
  exactObject,
  object,
  parseSuggestions,
  validateHistory,
  validModel,
} from "./content.js";
import { openStorage } from "./storage.js";
import type {
  Change,
  ClaimResult,
  Command,
  Context,
  GenerationCommand,
  Outcome,
  Storage,
  VersionView,
} from "./types.js";

// App 单例进程按 dataPath 协调打开/关闭，执行代际在真实停用时隔离；符号跨模块换代共享。
const registryKey = Symbol.for("zcode.nextstep.runtime.v1");
type RuntimeGlobal = typeof globalThis & { [registryKey]?: Map<string, Promise<Runtime>> };
const runtimes = ((globalThis as RuntimeGlobal)[registryKey] ??= new Map<
  string,
  Promise<Runtime>
>());
function log(ctx: Context, level: "warn" | "error", code: string): void {
  try {
    ctx.log?.[level]?.(code);
  } catch {
    /* 日志端口不能影响持久状态。 */
  }
}
async function generate(
  ctx: Context,
  args: GenerationCommand,
  version: number,
  isActive: () => boolean,
): Promise<Outcome | null> {
  if (!isActive()) return null;
  let messages;
  try {
    messages = validateHistory(await ctx.turnFooter.history({ permit: args.permit }));
  } catch {
    return { status: "failed", errorCode: "history-unavailable" };
  }
  // history 等待期间可能真实停用；不能再使用已 disposed 的 context 发起模型。
  if (!isActive()) return null;
  const prompt = buildPrompt(messages);
  if (prompt === null) return { status: "empty" };
  let response: unknown;
  try {
    response = await ctx.turnFooter.generate({
      permit: args.permit,
      text: prompt,
      maxOutputTokens: 1600,
    });
  } catch {
    return { status: "unknown", errorCode: "generation-unknown" };
  }
  if (
    exactObject(response, ["status", "code"]) &&
    (response.status === "failed" || response.status === "unknown") &&
    typeof response.code === "string" &&
    response.code.length > 0 &&
    response.code.length <= 200
  ) {
    return {
      status: response.status,
      errorCode: response.status === "failed" ? "generation-failed" : "generation-unknown",
    };
  }
  const model =
    object(response) && response.status === "ok" && validModel(response.model)
      ? { ...response.model }
      : undefined;
  if (
    !exactObject(response, ["status", "text", "model"]) ||
    response.status !== "ok" ||
    !model ||
    typeof response.text !== "string" ||
    response.text.length > 16000
  ) {
    // 返回体损坏也可能已消耗额度；保留可确认的实际模型，但不重试或接收其输出。
    return {
      status: "unknown",
      errorCode: "invalid-generation-response",
      ...(model ? { model } : {}),
    };
  }
  return { ...parseSuggestions(response.text, args.anchor, version), model };
}
interface Attachment {
  ctx: Context;
}
class Runtime {
  private readonly attachments = new Set<Attachment>();
  private readonly tasks = new Set<Promise<void>>();
  closing: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly key: string,
    private readonly storage: Storage,
  ) {}
  private async notify(change: Change): Promise<void> {
    const ctx = [...this.attachments].at(-1)?.ctx;
    if (!ctx) return;
    try {
      await ctx.turnFooter.invalidate(change);
    } catch {
      log(ctx, "warn", "nextstep-invalidation-unavailable");
    }
  }
  attach(ctx: Context): Attachment {
    const token = { ctx };
    this.attachments.add(token);
    const recovered = this.storage.changes.splice(0);
    for (const change of recovered) void this.notify(change);
    return token;
  }
  async release(token: Attachment): Promise<void> {
    this.attachments.delete(token);
    if (this.attachments.size > 0) return;
    // 真正的插件停用与编辑器切换不同：先同步隔离 context，再持久封存该代际。
    this.stopped = true;
    this.closing ??= (async () => {
      try {
        const changes = await this.storage.fence();
        for (const change of changes) {
          try {
            void Promise.resolve(token.ctx.turnFooter.invalidate(change)).catch(() =>
              log(token.ctx, "warn", "nextstep-invalidation-unavailable"),
            );
          } catch {
            log(token.ctx, "warn", "nextstep-invalidation-unavailable");
          }
        }
      } finally {
        await this.storage.close();
      }
    })().finally(() => {
      runtimes.delete(this.key);
    });
    await this.closing;
  }
  private startTask(
    ctx: Context,
    args: GenerationCommand,
    claim: Extract<ClaimResult, { claimed: true }>,
  ): void {
    const task = (async () => {
      const version = claim.result.version;
      // invalidate 是持久事实的失效通知；端口卡住不能阻塞已认领任务。
      void this.notify({ anchor: args.anchor, version, revision: claim.result.revision });
      const outcome = await generate(ctx, args, version, () => !this.stopped);
      if (this.stopped || !outcome) {
        log(ctx, "warn", "nextstep-stale-owner-result-discarded");
        return;
      }
      const settled = await this.storage.settle({
        key: anchorKey(args.anchor),
        version,
        claimId: claim.claimId,
        outcome,
      });
      if (settled)
        void this.notify({
          anchor: args.anchor,
          version: settled.version,
          revision: settled.revision,
        });
      else log(ctx, "warn", "nextstep-stale-owner-result-discarded");
    })()
      .catch(() => {
        // 存储失联不重复发请求；保留 generating，下一执行者以 unknown 恢复。
        log(ctx, "error", "nextstep-background-storage-unavailable");
      })
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
  }
  async command(token: Attachment, args: Command): Promise<VersionView | null> {
    if (!this.attachments.has(token)) throw new Error("NextStep is inactive");
    const key = anchorKey(args.anchor);
    if (args.kind === "readLatest") return this.storage.read(key);
    const claim = await this.storage.claim({ key, requestId: args.requestId, kind: args.kind });
    if (claim.claimed && !this.stopped) this.startTask(token.ctx, args, claim);
    return claim.result;
  }
}
export interface RuntimeHandle {
  runtime: Runtime;
  token: Attachment;
}
export async function acquire(ctx: Context): Promise<RuntimeHandle> {
  const path = ctx.extension?.dataPath;
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("NextStep data directory unavailable");
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  for (;;) {
    let runtimePromise = runtimes.get(key);
    if (!runtimePromise) {
      runtimePromise = openStorage(join(canonical, "nextstep.sqlite")).then(
        (storage) => new Runtime(key, storage),
      );
      runtimes.set(key, runtimePromise);
      const opening = runtimePromise;
      void opening.catch(() => {
        if (runtimes.get(key) === opening) runtimes.delete(key);
      });
    }
    const runtime = await runtimePromise;
    if (runtime.closing) {
      await runtime.closing;
      continue;
    }
    const token = runtime.attach(ctx);
    return { runtime, token };
  }
}
