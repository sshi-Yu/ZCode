import { DEFAULT_WORKSPACE, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

describe("GENIMAGE-VIEW native Images canvas", () => {
  it("opens the saved canvas directly and gates only image creation without a model", async () => {
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    const entry = $('[data-testid="genimage-sidebar-open"]');
    await entry.waitForClickable();
    expect(await entry.getText()).toMatch(/图像|Images/);
    await entry.click();
    await $('[data-testid="genimage-workspace"]').waitForDisplayed();
    expect(await $('[data-testid="genimage-local-mode"]').isExisting()).toBe(false);
    expect(await $('[data-testid="genimage-live-mode"]').isExisting()).toBe(false);
    await $('[data-testid="genimage-import"]').waitForEnabled();
    await $('[data-testid="genimage-new"]').click();
    await $('[data-testid="genimage-prompt"]').setValue("E2E_GENIMAGE_NO_CONFIG");
    await $('[data-testid="genimage-model-unavailable"]').waitForDisplayed();
    await expect($('[data-testid="genimage-submit"]')).toBeDisabled();
  });
});
