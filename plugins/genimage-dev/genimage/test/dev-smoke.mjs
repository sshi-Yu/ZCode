import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("serves only the local GenImage preview and health endpoint", async () => {
  const entry = fileURLToPath(new URL("../scripts/dev.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, GENIMAGE_DEV_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let output = "";
  let errors = "";
  child.stderr.on("data", (data) => (errors += data));
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Preview did not start: ${errors}`)), 8000);
      child.stdout.on("data", (data) => {
        output += data;
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
        if (url) {
          clearTimeout(timeout);
          resolve(url);
        }
      });
      closed.then(([code]) => {
        clearTimeout(timeout);
        reject(new Error(`Preview exited (${code}): ${errors}`));
      });
    });
    const health = await fetch(new URL("healthz", base));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "genimage", mode: "fixture" });
    const canvas = await fetch(base);
    assert.equal(canvas.status, 200);
    assert.match(canvas.headers.get("content-type"), /^text\/html/);
    assert.match(await canvas.text(), /<title>[^<]*GenImage/);
    assert.equal((await fetch(new URL("marketplace.json", base))).status, 404);
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
  } finally {
    child.kill();
    await closed;
  }
});
