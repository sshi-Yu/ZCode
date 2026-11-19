import {
  TID_LOGIN_TRIGGER,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_USAGE_TAB,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, waitForDefaultWorkspaceReady } from "#e2e/helpers/desktop-app";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "#e2e/helpers/v4-conversation";

type Request = { method: string; path: string };

function origin(): string {
  const value = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
  if (!value) throw new Error("Missing isolated marketing fixture");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Marketing fixture must be an isolated loopback server");
  }
  return url.origin;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${origin()}${path}`);
  if (!response.ok) throw new Error(`Fixture ledger unavailable: ${path} (${response.status})`);
  return (await response.json()) as T;
}

async function assertNoCommercialTraffic(): Promise<void> {
  const marketing = await readJson<{
    events: unknown[];
    requestDetails: Request[];
  }>("/__e2e/marketing/state");
  const codingPlan = await readJson<{ requests: Request[] }>("/__e2e/coding-plan/requests");
  // balance 和 enterprise pricing 还承载已有权益/项目读取，不可按 billing 或 pricing 一概封禁。
  const forbidden = (request: Request) =>
    /^\/api\/v1\/marketing\//u.test(request.path) ||
    /^\/marketing-assets\//u.test(request.path) ||
    /^\/api\/v1\/zcode-plan\/billing\/(preview|claim)(?:\/|$)/u.test(request.path) ||
    /^\/api\/v1\/coding-plan\/reset(?:\/|$)/u.test(request.path) ||
    request.path === "/api/v1/highspeed/draw" ||
    /^\/api\/biz\/pay(?:\/|$)/u.test(request.path) ||
    /^\/api\/pay(?:\/|$)/u.test(request.path) ||
    /^\/api\/biz\/subscription\/enterprise\/v2\/orders?(?:\/|$)/u.test(request.path) ||
    request.path === "/coding-plan";
  // 账本包含冷启动至今的累计请求；不得 reset 后再断言启动为零。
  expect(marketing.events).toEqual([]);
  expect(marketing.requestDetails.filter(forbidden)).toEqual([]);
  // 不输出 fixture 中的 header，以免日志包含凭据。
  expect(codingPlan.requests.filter(forbidden).map(({ method, path }) => ({ method, path }))).toEqual(
    [],
  );
}

async function assertRemovedSurfaces(): Promise<void> {
  for (const id of [
    "marketing-banner",
    "cloud-content-dialog",
    "rewards-surface",
    "rewards-webview",
    "coding-plan-upgrade-surface",
    "coding-plan-embedded-webview",
    "manual-claim-plan-banner",
  ]) {
    expect(await $(`[data-testid="${id}"]`).isDisplayed()).toBe(false);
  }
}

describe("PCS06: 任务完成不再触发营销", () => {
  it("冷启动、online、任务完成和刷新周期无营销请求或入口，设置用量仍可打开", async function () {
    this.timeout(150_000);
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
        (await $('[data-testid^="v4-session-pane-"]').isDisplayed()),
      { timeout: 30_000 },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
    await waitForDefaultWorkspaceReady(30_000);
    await assertRemovedSurfaces();
    await assertNoCommercialTraffic();

    // 打开账号菜单，验证原奖励入口不再出现；这不替代账号恢复与退出的 PCS01。
    await clickTestIdByDom(TID_LOGIN_TRIGGER);
    expect(await $('[data-testid="rewards-menu-item"]').isExisting()).toBe(false);
    await browser.keys("Escape");

    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_MARKETING_TASK_COMPLETE: Reply exactly E2E_MARKETING_TASK_DONE.");
    await waitForV4ConversationState((state) => state.runtimeStatus === "streaming", "任务未进入 running");
    await browser.execute(() => window.dispatchEvent(new Event("online")));
    await waitForV4AssistantMessageContaining("E2E_MARKETING_TASK_DONE");
    await assertNoCommercialTraffic();

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "usage"));
    await clickTestIdByDom(testId(TID_SETTINGS_USAGE_TAB, "app"));
    await browser.waitUntil(async () => /Token activity|Token 活动/i.test(await $("body").getText()), {
      timeout: 30_000,
      timeoutMsg: "App Usage 页面未加载",
    });
    await assertRemovedSurfaces();
    await assertNoCommercialTraffic();

    // 原营销 poll 间隔为 30 秒；必须经过完整周期，不以首次渲染的零请求代替。
    await browser.pause(32_000);
    await assertRemovedSurfaces();
    await assertNoCommercialTraffic();
  });
});
