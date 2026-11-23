import assert from "node:assert/strict";
import { test } from "node:test";
import { checkManifest, checkSource } from "./check-boundaries.mjs";

const catalog = { react: "19.3.1" };
const app = "/workspace/apps/genimage";
const root = "/workspace";
const source = (code) =>
  checkSource({
    root,
    member: app,
    file: `${app}/src/index.tsx`,
    code,
    dependencies: new Set(["@zcode-plugins/uis"]),
  });

await test("rejects a version bypass or direct primitive dependency", () => {
  assert.throws(
    () =>
      checkManifest(
        { name: "@zcode-plugins/genimage", dependencies: { react: "19.3.1" } },
        catalog,
      ),
    /catalog:/,
  );
  assert.throws(
    () =>
      checkManifest(
        { name: "@zcode-plugins/genimage", dependencies: { "@zcode-plugins/ui": "workspace:*" } },
        catalog,
      ),
    /only uis/,
  );
  assert.doesNotThrow(() =>
    checkManifest(
      { name: "@zcode-plugins/genimage", dependencies: { react: "catalog:" } },
      catalog,
    ),
  );
});

await test("rejects dependencies from shared packages to any workspace app", () => {
  const applicationNames = new Set(["@zcode-plugins/future-app"]);
  const manifest = {
    name: "@zcode-plugins/uis",
    devDependencies: { "@zcode-plugins/future-app": "workspace:*" },
  };
  assert.throws(() => checkManifest(manifest, catalog, { applicationNames }), /application/);
  assert.doesNotThrow(() =>
    checkManifest(
      { name: "@zcode-plugins/future-app", dependencies: { "@zcode-plugins/uis": "workspace:*" } },
      catalog,
      { applicationNames },
    ),
  );
});

await test("accepts the public component entry and rejects bypass imports", () => {
  assert.doesNotThrow(() => source('import { Button } from "@zcode-plugins/uis";'));
  for (const path of [
    "@zcode-plugins/ui",
    "@zcode-plugins/ui/src/button",
    "../../../packages/ui/src/button",
    "@aliases/ui/button",
    "@zcode-plugins/uis/src/internal",
  ]) {
    assert.throws(() => source(`export * from ${JSON.stringify(path)};`), /boundary/);
  }
  assert.throws(() => source('const mod = import("@zcode-plugins/ui");'), /boundary/);
});
