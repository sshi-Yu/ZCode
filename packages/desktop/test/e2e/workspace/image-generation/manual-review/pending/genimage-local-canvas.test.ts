import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { TID_SETTINGS_SECTION_NAV, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";

const workspace = '[data-testid="genimage-workspace"]';
const fixture = new PNG({ width: 280, height: 180 });
fixture.data.fill(200);
const png = PNG.sync.write(fixture);

async function openImages() {
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
  const entry = $('[data-testid="genimage-sidebar-open"]');
  await entry.waitForClickable();
  await entry.click();
  await $(workspace).waitForDisplayed();
  await $('[data-testid="genimage-import"]').waitForEnabled();
}

describe("GENIMAGE-LOCAL persistent image canvas", () => {
  it("caches an imported original, restores its position, previews and exports it", async function () {
    this.timeout(180_000);
    const directory = await mkdtemp(join(tmpdir(), "zcode-e2e-image-import-"));
    try {
      const sourcePath = join(directory, "image-canvas-fixture.png");
      await writeFile(sourcePath, png);
      await openImages();
      await $('[data-testid="genimage-file-input"]').setValue(sourcePath);
      const card = $("[data-genimage-node]");
      await card.waitForDisplayed();
      await expect(card.$("h3")).toHaveText("image-canvas-fixture.png");
      const id = await card.getAttribute("data-genimage-node");
      const oldVersion = await card.getAttribute("data-genimage-version");
      assert.ok(id && oldVersion);
      await browser.execute(() =>
        document.querySelector<HTMLElement>("[data-genimage-node]")?.focus(),
      );
      await browser.keys(["Shift", "ArrowRight"]);
      await browser.waitUntil(
        async () => (await card.getAttribute("data-genimage-version")) !== oldVersion,
      );
      const movedX = await card.getAttribute("data-genimage-x");
      assert.ok(movedX);

      await rm(sourcePath);
      await reloadElectronSessionPreservingBrowserProfile(browser);
      await openImages();
      const restoredCard = $("[data-genimage-node]");
      await restoredCard.waitForDisplayed();
      await expect(restoredCard).toHaveAttribute("data-genimage-node", id);
      await expect(restoredCard).toHaveAttribute("data-genimage-x", movedX);

      const trigger = restoredCard.$('[data-testid="genimage-preview"]');
      await trigger.click();
      const preview = $('[data-testid="genimage-original-dialog"]');
      await preview.waitForDisplayed();
      const original = $('[data-testid="genimage-original"]');
      await original.waitForDisplayed();
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            document.querySelector<HTMLImageElement>('[data-testid="genimage-original"]')
              ?.naturalWidth === 280,
        ),
      );
      const originalSource = await original.getAttribute("src");
      assert.ok(originalSource);
      const authorizedUrl = new URL(originalSource);
      expect(authorizedUrl.protocol).toBe("zcode-media:");
      expect(await readFile(authorizedUrl.searchParams.get("path")!)).toEqual(png);
      const geometry = await browser.execute(() => {
        const dialog = document.querySelector('[data-testid="genimage-original-dialog"]');
        const image = document.querySelector<HTMLImageElement>('[data-testid="genimage-original"]');
        if (!dialog || !image) return null;
        const viewport = image.closest("[data-image-preview-viewport]")?.getBoundingClientRect();
        const bounds = image.getBoundingClientRect();
        const frame = dialog.getBoundingClientRect();
        return {
          frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
          window: { width: innerWidth, height: innerHeight },
          fillsWindow:
            Math.abs(frame.x) < 1 &&
            Math.abs(frame.y) < 1 &&
            Math.abs(frame.width - innerWidth) < 1 &&
            Math.abs(frame.height - innerHeight) < 1,
          fitsImage:
            viewport &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            Math.abs(bounds.width / bounds.height - 280 / 180) < 0.02 &&
            bounds.width <= viewport.width + 0.5 &&
            bounds.height <= viewport.height + 0.5,
        };
      });
      assert.ok(geometry?.fillsWindow && geometry.fitsImage, JSON.stringify(geometry));
      const zoomIn = preview.$("button:has(svg.lucide-plus)");
      await zoomIn.click();
      await expect(preview.$("button=150%")).toBeDisplayed();
      await preview.$("button=150%").click();
      await expect(preview.$("button=100%")).toBeDisplayed();

      const toggle = $('[data-testid="genimage-feature-toggle"]');
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await $('[data-testid="genimage-feature-details"]').waitForDisplayed();
      expect(await $('[data-testid="genimage-feature-result"]').isExisting()).toBe(false);
      if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
        await mkdir(process.env.ZCODE_E2E_ARTIFACT_DIR, { recursive: true });
        await browser.saveScreenshot(
          join(process.env.ZCODE_E2E_ARTIFACT_DIR, "images-preview.png"),
        );
      }
      await browser.keys("Escape");
      await preview.waitForExist({ reverse: true });
      await browser.waitUntil(() => trigger.isFocused());

      await trigger.click();
      const saveDialog = await browser.electron.mock("dialog", "showSaveDialog");
      const exportPath = join(directory, "export.png");
      await saveDialog.mockResolvedValueOnce({ canceled: false, filePath: exportPath });
      const exportButton = $('[data-testid="genimage-export"]');
      await exportButton.waitForEnabled();
      await exportButton.click();
      await browser.waitUntil(
        async () => (await readFile(exportPath).catch(() => undefined))?.equals(png) === true,
      );
      await browser.keys("Escape");
    } finally {
      await browser.electron.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a failed generation's request ID until a separate request is confirmed", async function () {
    this.timeout(150_000);
    if (!(await $(workspace).isDisplayed())) await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await $('[data-model-settings-group="image"]').click();
    await $('[data-testid="image-model-name"]').setValue("E2E blocked image destination");
    await $('[data-testid="image-model-id"]').setValue("fixture-image");
    await $('[data-testid="image-model-url"]').setValue("https://127.0.0.1/v1");
    await $('[data-testid="image-model-key"]').setValue("fixture-key");
    await $('[data-testid="image-model-save"]').click();
    await $('[data-testid="image-model-configured"]').waitForDisplayed();
    await clickTestIdByDom("settings-back-button");
    if (!(await $(workspace).isDisplayed())) await openImages();
    await $('[data-testid="genimage-new"]').click();
    await $('[data-testid="genimage-prompt"]').setValue("E2E_GENIMAGE_BLOCKED");
    const submit = $('[data-testid="genimage-submit"]');
    await submit.waitForEnabled();
    await submit.click();
    const newRequest = $('[data-testid="genimage-new-request"]');
    await newRequest.waitForDisplayed();
    const liveRoot = join(getE2EAppDataPaths().storageRoot, "genimage", "live");
    const boardDirectories = await readdir(liveRoot);
    const boardPath = join(liveRoot, boardDirectories[0]!, "board.json");
    const readJobs = async () =>
      (JSON.parse(await readFile(boardPath, "utf8")) as { jobs: Array<{ id: string }> }).jobs;
    const first = await readJobs();
    expect(first).toHaveLength(1);
    await submit.click();
    await newRequest.waitForEnabled();
    expect(await readJobs()).toHaveLength(1);
    await newRequest.click();
    await $('[data-testid="confirm-dialog-confirm"]').click();
    await newRequest.waitForExist({ reverse: true });
    await submit.click();
    await newRequest.waitForDisplayed();
    const second = await readJobs();
    expect(second).toHaveLength(2);
    expect(second[0]!.id).not.toBe(second[1]!.id);
  });
});
