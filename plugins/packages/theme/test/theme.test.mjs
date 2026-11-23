import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostThemeStore } from "../src/index.ts";

await test("first frame uses injected theme and has bounded defaults", () => {
  const store = createHostThemeStore("dark");
  assert.equal(store.getSnapshot().theme, "dark");
  assert.equal(store.getSnapshot().locale, "en-US");
  assert.equal(createHostThemeStore("system").getSnapshot().theme, "light");
  assert.equal(createHostThemeStore(null).getSnapshot().displayMode, "inline");
});

await test("partial context and variable updates merge without losing valid fields", () => {
  const store = createHostThemeStore("dark");
  store.update({ locale: "zh-CN", styles: { variables: {
    "--color-background-primary": "#161616", "--font-text-md-size": "14px",
  } }, safeAreaInsets: { top: 12 }, containerDimensions: { width: 390, maxHeight: 800 } });
  const initial = store.getSnapshot();
  store.update({ theme: "light", styles: { variables: { "--color-text-primary": "oklch(0.2 0 0)" } }, safeAreaInsets: { bottom: 8 } });
  const next = store.getSnapshot();
  assert.equal(next.locale, "zh-CN");
  assert.equal(next.theme, "light");
  assert.equal(next.variables["--color-background-primary"], "#161616");
  assert.equal(next.variables["--font-text-md-size"], "14px");
  assert.equal(next.variables["--color-text-primary"], "oklch(0.2 0 0)");
  assert.deepEqual(next.safeAreaInsets, { top: 12, right: 0, bottom: 8, left: 0 });
  assert.deepEqual(next.containerDimensions, { width: 390, maxHeight: 800 });
  assert.equal(initial.theme, "dark");
});

await test("snapshot identity, notification and unsubscribe are deterministic", () => {
  const store = createHostThemeStore();
  let calls = 0;
  const dispose = store.subscribe(() => { calls++; });
  const first = store.getSnapshot();
  for (const invalid of [null, [], "dark", { theme: "system" }, { locale: "not a locale" }, { styles: null }]) store.update(invalid);
  store.update({ theme: "light" });
  assert.equal(store.getSnapshot(), first);
  assert.equal(calls, 0);
  store.update({ theme: "dark" });
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot(), store.getSnapshot());
  dispose(); dispose();
  store.update({ theme: "light" });
  assert.equal(calls, 1);
});

await test("rejects unknown keys, external resources, CSS injection and malformed values", () => {
  const store = createHostThemeStore();
  store.update({ styles: { variables: {
    "--color-background-primary": "#fff",
    "--font-sans": 'system-ui, "Segoe UI", sans-serif',
    "--font-text-md-size": "calc(14px + 2px)",
    "--color-border-primary": "color-mix(in srgb, #000 10%, transparent)",
    "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.05)",
  } } });
  const previous = store.getSnapshot();
  for (const value of ["url(https://example.com/theme.css)", "#fff; color:red", "var(--arbitrary)", "#fff/*comment*/", "expression(alert(1))", "red\\3b color:blue", "rgb(1 2 3);", "#xxff00", "color-mix(in srgb, red, url(x))"]) {
    store.update({ styles: { variables: { "--color-background-primary": value } } });
  }
  store.update({ styles: { variables: {
    "--unknown": "#fff", "--font-mono": "url(https://example.com/font)",
    "--font-text-sm-size": "999px", "--border-radius-md": "-8px",
    "--font-weight-normal": "bold", "--font-text-sm-line-height": "0",
    "--shadow-lg": "0 0 0 1px red; background:url(x)",
  } } });
  assert.equal(store.getSnapshot(), previous);
  assert.ok(!("--unknown" in store.getSnapshot().variables));
});

await test("valid host color forms and typography are accepted", () => {
  const store = createHostThemeStore();
  const colors = ["rgba(13, 13, 13, 0.1)", "rgb(255 255 255 / 20%)", "hsl(0 0% 98%)", "oklch(0.5 0.1 240)", "color-mix(in oklch, oklch(0.5 0 0) 50%, #ffffff)"];
  for (const color of colors) {
    store.update({ styles: { variables: { "--color-text-primary": color } } });
    assert.equal(store.getSnapshot().variables["--color-text-primary"], color);
  }
  store.update({ styles: { variables: { "--border-radius-full": "9999px", "--font-weight-bold": "700", "--font-text-md-line-height": "1.5" } } });
  assert.equal(store.getSnapshot().variables["--border-radius-full"], "9999px");
});

await test("host system font stacks and resolved calc tokens are preserved", () => {
  const store = createHostThemeStore();
  const system = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
  store.update({ styles: { variables: { "--font-sans": system, "--font-text-xs-size": "calc(14px - 4px)" } } });
  assert.equal(store.getSnapshot().variables["--font-sans"], system);
  assert.equal(store.getSnapshot().variables["--font-text-xs-size"], "calc(14px - 4px)");
});

await test("malformed color and zero size do not replace valid styles", () => {
  const store = createHostThemeStore();
  const before = store.getSnapshot();
  for (const value of ["rgb(,1 2 3)", "rgb(1,,2,3)", "rgb(1 2 3 / / 0.2)", "rgb(1e 2 3)"]) store.update({ styles: { variables: { "--color-text-primary": value } } });
  store.update({ styles: { variables: { "--font-text-md-size": "1px" } } });
  assert.equal(store.getSnapshot(), before);
});

await test("snapshots are frozen and ignore inherited context properties", () => {
  const store = createHostThemeStore();
  store.update(Object.create({ theme: "dark", locale: "zh-CN" }));
  assert.equal(store.getSnapshot().theme, "light");
  assert.throws(() => { store.getSnapshot().safeAreaInsets.top = 99; }, TypeError);
  assert.throws(() => { store.getSnapshot().variables["--color-text-primary"] = "#000"; }, TypeError);
});

await test("context fields validate independently and preserve earlier values", () => {
  const store = createHostThemeStore();
  store.update({ locale: "zh-cn", displayMode: "fullscreen", safeAreaInsets: { top: 10 }, containerDimensions: { width: 1200, height: 900 } });
  store.update({ locale: "http://example.com", displayMode: "other", safeAreaInsets: { top: -1, left: Infinity }, containerDimensions: { width: -50, height: "100px", maxHeight: NaN } });
  assert.equal(store.getSnapshot().locale, "zh-CN");
  assert.equal(store.getSnapshot().displayMode, "fullscreen");
  assert.equal(store.getSnapshot().safeAreaInsets.top, 10);
  assert.deepEqual(store.getSnapshot().containerDimensions, { width: 1200, height: 900 });
});
