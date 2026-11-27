import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const imageNav = '[data-model-settings-group="image"]';
const imageName = '[data-testid="image-model-name"]';
const imageKey = '[data-testid="image-model-key"]';
const firstModel =
  '[data-model-provider-model-id="tool-text-model"] [data-testid="model-utility-toggle"]';
const secondModel =
  '[data-model-provider-model-id="other-tool-model"] [data-testid="model-utility-toggle"]';
const visionModel =
  '[data-model-provider-model-id="vision-model"] [data-testid="model-feature-toggle"]';
const textOnlyFeatureMarker =
  '[data-model-provider-model-id="tool-text-model"] [data-testid="model-feature-toggle"]';

async function openFixtureProvider() {
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, "custom:specialized-model-fixture"));
  await $(firstModel).waitForEnabled();
}

async function waitForMarker(selector: string, pressed: boolean) {
  await browser.waitUntil(
    async () => (await $(selector).getAttribute("aria-pressed")) === String(pressed),
  );
}

async function openModelSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  await $(imageNav).waitForDisplayed();
}

describe("图像配置和小工具模型", () => {
  it("保存图像配置和唯一模型标记，并在重启后恢复", async function () {
    this.timeout(150_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: () =>
        seedReplayProvider({
          id: "specialized-model-fixture",
          name: "Specialized Model Fixture",
          apiKey: "",
          models: [
            { id: "tool-text-model", inputModalities: ["text"] },
            "other-tool-model",
            { id: "vision-model", inputModalities: ["text", "image"] },
          ],
        }),
    });
    await openModelSettings();
    await $(imageNav).click();
    await $(imageName).setValue("Image fixture");
    await $('[data-testid="image-model-id"]').setValue("fixture-image-model");
    const protocol = $('[data-testid="image-model-protocol"]');
    await expect(protocol).toHaveAttribute("role", "combobox");
    await protocol.click();
    await $('[data-testid="image-model-protocol-base64"]').click();
    const quality = $('[data-testid="image-model-quality"]');
    await quality.click();
    await $('[data-testid="image-model-quality-high"]').click();
    await $('[data-testid="image-model-url"]').setValue("https://images.example.invalid/v1");
    await $(imageKey).setValue("fixture-image-key");
    await $('[data-testid="image-model-save"]').click();
    await $('[data-testid="image-model-configured"]').waitForDisplayed();

    await openFixtureProvider();
    await $(firstModel).click();
    await waitForMarker(firstModel, true);
    await $(secondModel).click();
    await waitForMarker(secondModel, true);
    await waitForMarker(firstModel, false);
    expect(await $(textOnlyFeatureMarker).isExisting()).toBe(false);
    await $(visionModel).click();
    await waitForMarker(visionModel, true);
    await waitForMarker(secondModel, true);
    expect(await $('[data-model-settings-group="tool"]').isExisting()).toBe(false);

    await restartIntoWorkspace();
    await openModelSettings();
    await $(imageNav).click();
    await $('[data-testid="image-model-configured"]').waitForDisplayed();
    expect(await $(imageName).getValue()).toBe("Image fixture");
    expect(await $('[data-testid="image-model-quality"]').getText()).toBe("high");
    expect(await $(imageKey).getValue()).toBe("");
    await openFixtureProvider();
    await waitForMarker(visionModel, true);
    await waitForMarker(secondModel, true);
    await $(secondModel).click();
    await waitForMarker(secondModel, false);
    await waitForMarker(visionModel, true);
  });

  it("显式提取后在画布展示标签，并复用素材的特征缓存", async function () {
    this.timeout(180_000);
    const providerId = "genimage-vision-replay";
    const modelId = "genimage-vision-model";
    const source = new PNG({ width: 480, height: 320 });
    source.data.fill(210);
    const directory = await mkdtemp(join(tmpdir(), "zcode-e2e-image-features-"));
    const sourcePath = join(directory, "feature-source.png");
    const requests: Array<{ path?: string; body: string }> = [];
    const tags = ["gradient", "square", "pastel", "simple"];
    const summary = "A soft color study.";
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push({ path: request.url, body });
      const completion = {
        id: "genimage-feature-replay",
        object: "chat.completion",
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ summary, tags }) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion));
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing replay port");
      await writeFile(sourcePath, PNG.sync.write(source));
      await prepareV4ConversationE2E({ skipProvider: true });
      await restartIntoWorkspace({
        afterElectronProcessExit: () =>
          seedReplayProvider({
            id: providerId,
            name: "GenImage vision replay",
            apiKey: "e2e-only",
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            models: [{ id: modelId, inputModalities: ["text", "image"] }],
          }),
      });
      await openModelSettings();
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, `custom:${providerId}`));
      const marker = `[data-model-provider-model-id="${modelId}"] [data-testid="model-feature-toggle"]`;
      await $(marker).waitForClickable();
      await $(marker).click();
      await waitForMarker(marker, true);
      await clickTestIdByDom("settings-back-button");
      await clickTestIdByDom("genimage-sidebar-open");
      await $('[data-testid="genimage-import"]').waitForEnabled();
      const fileInput = $('[data-testid="genimage-file-input"]');
      await fileInput.setValue(sourcePath);
      const cardSelector = "[data-genimage-node]";
      const card = $(cardSelector);
      await card.waitForDisplayed();
      await expect(card.$("h3")).toHaveText("feature-source.png");
      await card.$('[data-testid="genimage-preview"]').click();
      const details = $('[data-testid="genimage-feature-toggle"]');
      await details.waitForClickable({ timeout: 10_000 });
      await details.click();
      const extract = $('[data-testid="genimage-extract"]');
      await extract.waitForEnabled();
      expect(requests).toHaveLength(0);
      await extract.click();
      const result = $('[data-testid="genimage-feature-result"]');
      await result.waitForDisplayed({ timeout: 30_000 });
      await expect(result.$("p")).toHaveText(summary);
      expect(await result.$$("li").map((tag) => tag.getText())).toEqual(tags);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.path).toBe("/v1/chat/completions");
      expect(request.body).not.toContain("feature-source.png");
      const body = JSON.parse(request.body);
      expect(body.model).toBe(modelId);
      expect(body.stream).not.toBe(true);
      const images = body.messages
        .flatMap(({ content }: { content: unknown }) => (Array.isArray(content) ? content : []))
        .filter(({ type }: { type: string }) => type === "image_url");
      expect(images).toHaveLength(1);
      const dataUrl: string = images[0].image_url.url;
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
      const thumbnail = PNG.sync.read(Buffer.from(dataUrl.split(",")[1]!, "base64"));
      expect([thumbnail.width, thumbnail.height]).toEqual([240, 160]);
      await browser.keys("Escape");
      expect(await card.$$("li").map((tag) => tag.getText())).toEqual(tags.slice(0, 3));
      await fileInput.setValue(sourcePath);
      await browser.waitUntil(async () => (await $$(cardSelector).length) === 2);
      const duplicate = (await $$(cardSelector))[1]!;
      expect(await duplicate.$$("li").map((tag) => tag.getText())).toEqual(tags.slice(0, 3));
      expect(requests).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
