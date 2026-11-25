import { TID_TASK_SETTINGS_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspace, seedReplayProvider } from "#e2e/helpers/model-provider-restart";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

describe("本机小工具模型设置", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("TM01: Git 独立绑定可持久化和恢复默认，未证明来源的自动标题不展示", async function () {
    this.timeout(150_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await restartIntoWorkspace({
      afterElectronProcessExit: () =>
        seedReplayProvider({
          id: "tool-model-fixture",
          name: "Tool Model Fixture",
          apiKey: "e2e-only",
          models: ["tool-text-model"],
        }),
    });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await $('[data-tool-model-navigation="true"]').click();
    const select = $('[data-tool-model-select="git-commit-message"]');
    await select.waitForDisplayed({ timeout: 15_000 });
    await select.selectByAttribute("value", "tool-model-fixture/tool-text-model");
    await $('[data-tool-model-save="git-commit-message"]').click();
    await browser.waitUntil(
      async () =>
        (await $('[data-tool-model-status="git-commit-message"]').getText()).includes(
          "tool-text-model",
        ),
      { timeout: 15_000 },
    );
    expect(await $('[data-tool-model-row="automatic-title"]').isExisting()).toBe(false);
    await $('[data-tool-model-reset="git-commit-message"]').click();
    await browser.waitUntil(async () => (await select.getValue()) === "", { timeout: 15_000 });
  });
});
