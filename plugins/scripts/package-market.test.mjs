import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publishMarket } from "./package-market.mjs";

async function fixture(t) {
  const appRoot = await mkdtemp(join(tmpdir(), "plugin-market-"));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  await mkdir(join(appRoot, "manifest"));
  await writeFile(
    join(appRoot, "manifest/plugin.json"),
    JSON.stringify({
      name: "sample",
      version: "0.1.1",
      extension: { main: "./dist/index.mjs" },
    }),
  );
  await writeFile(
    join(appRoot, "manifest/marketplace.json"),
    JSON.stringify({
      name: "sample-local",
      plugins: [{ name: "sample", version: "0.1.1", source: "./sample" }],
    }),
  );
  return appRoot;
}

async function build(pluginDir) {
  await mkdir(join(pluginDir, "dist"));
  await writeFile(join(pluginDir, "dist/index.mjs"), "export const activate = () => {};");
}

await test("publishes only a complete local market and preserves it on a failed build", async (t) => {
  const appRoot = await fixture(t);
  await publishMarket({ appRoot, build });
  const entry = join(appRoot, "dist/market/sample/dist/index.mjs");
  const expected = await readFile(entry, "utf8");
  await assert.rejects(publishMarket({ appRoot, build: async () => {} }), /entry/i);
  assert.equal(await readFile(entry, "utf8"), expected);
});

await test("does not replace an identical market but publishes a changed runtime", async (t) => {
  const appRoot = await fixture(t);
  const market = await publishMarket({ appRoot, build });
  const originalDate = new Date("2020-01-01T00:00:00Z");
  await utimes(market, originalDate, originalDate);
  const originalMtime = (await stat(market)).mtimeMs;
  await publishMarket({ appRoot, build });
  assert.equal((await stat(market)).mtimeMs, originalMtime);

  const replacement = "export const activate = () => 1;";
  await publishMarket({
    appRoot,
    build: async (dir) => {
      await build(dir);
      await writeFile(join(dir, "dist/index.mjs"), replacement);
    },
  });
  assert.equal(await readFile(join(market, "sample/dist/index.mjs"), "utf8"), replacement);
});

await test("rejects development dependencies in the copyable installation tree", async (t) => {
  const appRoot = await fixture(t);
  await assert.rejects(
    publishMarket({
      appRoot,
      build: async (dir) => {
        await build(dir);
        await mkdir(join(dir, "dist/node_modules"));
      },
    }),
    /node_modules/,
  );
});

await test("rejects manifests pointing outside the installation tree", async (t) => {
  const appRoot = await fixture(t);
  await writeFile(
    join(appRoot, "manifest/plugin.json"),
    JSON.stringify({
      name: "sample",
      version: "0.1.1",
      extension: { main: "../entry.mjs" },
    }),
  );
  await assert.rejects(publishMarket({ appRoot, build }), /entry/i);
});
