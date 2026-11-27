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
          models: ["tool-text-model", "other-tool-model"],
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
    expect(await $('[data-model-settings-group="tool"]').isExisting()).toBe(false);

    await restartIntoWorkspace();
    await openModelSettings();
    await $(imageNav).click();
    await $('[data-testid="image-model-configured"]').waitForDisplayed();
    expect(await $(imageName).getValue()).toBe("Image fixture");
    expect(await $('[data-testid="image-model-quality"]').getText()).toBe("high");
    expect(await $(imageKey).getValue()).toBe("");
    await openFixtureProvider();
    await waitForMarker(secondModel, true);
    await $(secondModel).click();
    await waitForMarker(secondModel, false);
  });
});
