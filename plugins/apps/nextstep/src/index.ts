import { object, validateCommand } from "./content.js";
import { acquire } from "./runtime.js";
import type { RuntimeHandle } from "./runtime.js";
import type { Context, Disposable } from "./types.js";

let active: (RuntimeHandle & { command: Disposable }) | undefined;
let transition: Promise<void> = Promise.resolve();
function enqueue(run: () => Promise<void>): Promise<void> {
  const next = transition.then(run);
  transition = next.catch(() => {});
  return next;
}
async function releaseActive(): Promise<void> {
  const previous = active;
  active = undefined;
  if (!previous) return;
  previous.command.dispose();
  await previous.runtime.release(previous.token);
}
function assertContext(ctx: unknown): asserts ctx is Context {
  if (
    !object(ctx) ||
    !object(ctx.commands) ||
    typeof ctx.commands.register !== "function" ||
    !object(ctx.turnFooter) ||
    !["history", "generate", "invalidate"].every(
      (method) => typeof (ctx.turnFooter as Record<string, unknown>)[method] === "function",
    )
  )
    throw new Error("NextStep requires ZCode extension API 1.5.0");
}
export function activate(ctx: unknown): Promise<void> {
  return enqueue(async () => {
    assertContext(ctx);
    await releaseActive();
    const handle = await acquire(ctx);
    try {
      const command = ctx.commands.register("nextstep", (call) =>
        handle.runtime.command(handle.token, validateCommand(object(call) ? call.args : undefined)),
      );
      active = { ...handle, command };
    } catch {
      await handle.runtime.release(handle.token);
      throw new Error("NextStep command registration failed");
    }
  });
}
export function deactivate(): Promise<void> {
  return enqueue(releaseActive);
}
