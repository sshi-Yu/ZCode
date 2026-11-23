import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Supply an existing Chromium binary to avoid implicit browser downloads.
const [executablePath, url = "http://127.0.0.1:4187/"] = process.argv.slice(2);
if (!executablePath) throw new Error("Usage: node browser-check.mjs <chromium> [url]");
const browser = await chromium.launch({ executablePath, headless: true });
const checks = [];
const run = async (label, task) => {
  try { await task(); checks.push({ label, passed: true }); }
  catch (error) { checks.push({ label, passed: false, error: String(error) }); }
};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const settle = async () => {
    await page.mouse.move(0, 0);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  };
  await page.goto(url);
  await page.getByRole("textbox", { name: "Persistent draft" }).fill("draft survives theme changes");
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light"]) {
      if (!(await page.getByTestId("status").textContent()).startsWith(theme)) await page.getByRole("button", { name: "Change host theme / locale" }).click();
      await settle();
      await run(`${width}px ${theme}: public semantic properties and Button contrast`, async () => {
        assert.equal(await page.getByTestId("dark-scope").evaluate((element) => getComputedStyle(element).opacity), theme === "dark" ? "0.5" : "1");
        const actual = await page.locator(".zcode-plugins-theme").first().evaluate((root) => {
          const css = getComputedStyle(root);
          const button = root.querySelector("button");
          const style = getComputedStyle(button);
          return { variables: ["--color-background", "--color-card", "--color-border", "--color-foreground", "--color-primary", "--color-primary-foreground"].map((key) => [key, css.getPropertyValue(key).trim()]), foreground: style.color, background: style.backgroundColor };
        });
        process.stdout.write(`${width}px ${theme} computed ${JSON.stringify(actual)}\n`);
        for (const [key, value] of actual.variables) assert.ok(value, `${key} must be present without utility discovery`);
        assert.equal(actual.foreground, theme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");
        assert.equal(actual.background, theme === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)");
      });
      await run(`${width}px ${theme}: draft, invalid context and narrow layout`, async () => {
        await page.getByRole("button", { name: "Send invalid context" }).click();
        assert.equal(await page.getByRole("textbox", { name: "Persistent draft" }).inputValue(), "draft survives theme changes");
        assert.match(await page.getByTestId("status").textContent(), /mounts 1/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      });
    }
  }
  await run("portal inherits theme/locale and keyboard dismissal restores focus", async () => {
    await page.getByRole("button", { name: "Open themed dialog" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const before = await dialog.getAttribute("data-theme");
    await page.getByRole("button", { name: "Change host in dialog" }).click();
    assert.notEqual(await dialog.getAttribute("data-theme"), before);
    assert.equal(await dialog.getAttribute("lang"), await page.locator(".zcode-plugins-theme").first().getAttribute("lang"));
    assert.ok(await dialog.evaluate((root) => getComputedStyle(root).getPropertyValue("--color-card").trim()));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Open themed dialog" }).evaluate((element) => document.activeElement === element), true);
  });
  await run("host semantic partial update and reduced motion", async () => {
    await page.getByRole("button", { name: "Host semantic update" }).click();
    assert.equal(await page.locator("main").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(22, 51, 74)");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.getByRole("button", { name: "Change host theme / locale" }).evaluate((element) => getComputedStyle(element).transitionDuration), "0s");
    assert.equal(await page.getByRole("textbox", { name: "Persistent draft" }).inputValue(), "draft survives theme changes");
  });
  await run("no browser runtime errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
}
for (const check of checks) process.stdout.write(`${check.passed ? "PASS" : "FAIL"} ${check.label}${check.error ? `: ${check.error}` : ""}\n`);
assert.equal(checks.filter((check) => !check.passed).length, 0, "Browser engineering acceptance failed");
