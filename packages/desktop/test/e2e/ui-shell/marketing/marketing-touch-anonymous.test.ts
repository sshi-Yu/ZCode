import { readFile } from "node:fs/promises";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_LOGIN_API_KEY_SKIP_BUTTON,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "#e2e/helpers/desktop-app";

const byId = (id: string) => $(`[data-testid="${id}"]`);
function origin(): string {
  const value = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
  if (!value) throw new Error("Missing isolated marketing fixture");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Marketing fixture must be an isolated loopback server");
  }
  return url.origin;
}
async function expectAnonymous(): Promise<void> {
  const credentials = JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8"));
  // 只判断凭据是否存在，失败输出也不得带出凭据内容。
  expect(Boolean(credentials.zcodejwttoken)).toBe(false);
}
async function expectNoMarketing(): Promise<void> {
  const response = await fetch(`${origin()}/__e2e/marketing/state`);
  if (!response.ok) throw new Error(`Marketing ledger unavailable: ${response.status}`);
  const ledger = (await response.json()) as {
    events: unknown[];
    requestDetails: Array<{ method: string; path: string }>;
  };
  expect(ledger.events).toEqual([]);
  expect(
    ledger.requestDetails
      .filter(({ path }) =>
        /^\/(?:api\/v1\/marketing\/|marketing-assets\/|api\/v1\/zcode-plan\/billing\/(?:preview|claim)(?:\/|$))/u.test(
          path,
        ),
      )
      .map(({ method, path }) => ({ method, path })),
  ).toEqual([]);
  expect(await byId("marketing-banner").isDisplayed()).toBe(false);
  expect(await byId("cloud-content-dialog").isDisplayed()).toBe(false);
  expect(await byId("rewards-surface").isDisplayed()).toBe(false);
}

describe("PCS06: 匿名状态不再请求或显示营销", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("退出后冷启动、online 和原刷新周期不拉取或上报营销", async function () {
    this.timeout(120_000);
    await waitForDefaultWorkspaceReady();
    const popup = byId("cloud-content-dialog");
    if (await popup.isExisting()) await popup.$('[data-slot="dialog-close"]').click();
    const relaunch = await browser.electron.mock("app", "relaunch");
    await relaunch.mockResolvedValue(undefined);
    const quit = await browser.electron.mock("app", "quit");
    await quit.mockResolvedValue(undefined);
    await byId(TID_LOGIN_TRIGGER).click();
    await byId(TID_LOGOUT_BUTTON).click();
    await byId(TID_CONFIRM_DIALOG_CONFIRM).waitForDisplayed();
    await byId(TID_CONFIRM_DIALOG_CONFIRM).click();
    await browser.waitUntil(
      async () => {
        await relaunch.update();
        await quit.update();
        return relaunch.mock.calls.length === 1 && quit.mock.calls.length === 1;
      },
      { timeout: 30_000 },
    );
    await expectAnonymous();
    await browser.electron.restoreAllMocks();

    // 退出前的账号态流量与匿名冷启动分开；开启合成投放以防空投放掩盖旧请求。
    const reset = await fetch(`${origin()}/__e2e/marketing/reset`, {
      method: "POST",
      body: JSON.stringify({ popup: true, banner: true }),
    });
    expect(reset.ok).toBe(true);
    await browser.reloadSession();
    await browser.waitUntil(
      async () =>
        (await byId(TID_LOGIN_TRIGGER).isExisting()) ||
        (await byId(TID_LOGIN_USE_API_KEY_BUTTON).isExisting()),
      { timeout: 30_000 },
    );
    if (await byId(TID_LOGIN_USE_API_KEY_BUTTON).isExisting()) {
      await byId(TID_LOGIN_USE_API_KEY_BUTTON).click();
      await byId(TID_LOGIN_API_KEY_SKIP_BUTTON).click();
    }
    await waitForDefaultWorkspaceReady();
    await expectAnonymous();
    await expectNoMarketing();
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await browser.pause(32_000);
    await expectAnonymous();
    await expectNoMarketing();
  });
});
