import { validateCommand } from "./src/content.mjs";
import { acquire } from "./src/runtime.mjs";

let active;
let transition = Promise.resolve();
function enqueue(run) {
  const next = transition.then(run);
  transition = next.catch(() => {});
  return next;
}
async function releaseActive() {
  const previous = active;
  active = undefined;
  if (!previous) return;
  previous.command.dispose();
  await previous.runtime.release(previous.token);
}
export function activate(ctx) {
  return enqueue(async () => {
    if (
      !ctx?.commands?.register ||
      !["history", "generate", "invalidate"].every(
        (method) => typeof ctx?.turnFooter?.[method] === "function",
      )
    ) {
      throw new Error("NextStep requires ZCode extension API 1.5.0");
    }
    await releaseActive();
    const handle = await acquire(ctx);
    try {
      const command = ctx.commands.register("nextstep", (call) =>
        handle.runtime.command(handle.token, validateCommand(call?.args)),
      );
      active = { ...handle, command };
    } catch {
      await handle.runtime.release(handle.token);
      throw new Error("NextStep command registration failed");
    }
  });
}
export function deactivate() {
  return enqueue(releaseActive);
}
