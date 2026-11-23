import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

void test("market contains one version-matched installable plugin with a closed Node runtime", async () => {
  const market = new URL("../dist/market/", import.meta.url);
  const listing: unknown = JSON.parse(await readFile(new URL("marketplace.json", market), "utf8"));
  assert.deepEqual(listing, {
    name: "dev-zcode-1b53af4a",
    plugins: [
      {
        name: "nextstep",
        source: "./nextstep",
        version: "0.1.2",
        description:
          "Generate and persist optional next-step suggestions after successful local conversation turns.",
        displayName: "NextStep",
        displayName_i18n: { "zh-CN": "下一步建议" },
        description_i18n: { "zh-CN": "在本地主对话轮次成功后生成并持久保存可选的下一步建议。" },
      },
    ],
  });
  const manifest: unknown = JSON.parse(
    await readFile(new URL("nextstep/.zcode-plugin/plugin.json", market), "utf8"),
  );
  const source: unknown = JSON.parse(
    await readFile(new URL("../manifest/plugin.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(manifest, source);
  assert.deepEqual((await readdir(market)).sort(), ["marketplace.json", "nextstep"]);
  assert.deepEqual((await readdir(new URL("nextstep/", market))).sort(), [".zcode-plugin", "dist"]);
  assert.deepEqual((await readdir(new URL("nextstep/dist/", market))).sort(), [
    "index.mjs",
    "storage-worker.mjs",
    "storage.mjs",
  ]);
});
