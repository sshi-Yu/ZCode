import { openStatusCapsule } from "#e2e/helpers/status-capsule";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  restartIntoWorkspace,
  seedReplayProvider,
  seedTurboAgentStartupModel,
} from "#e2e/helpers/model-provider-restart";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared/test-ids";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "#e2e/helpers/conversation-session";
import { sel } from "#e2e/helpers/selectors";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

const TEST_TIMEOUT_MS = 120000;
const COMMIT_MESSAGE = "test(git): verify commit dialog keyboard flow";
const TARGET_BRANCH = "e2e-target";
const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
const GIT_CAPSULE_CONTENT = '[data-status-capsule-content="git"]';
const GIT_FIXTURE_FILE = join(".zcode-e2e", "git-commit-dialog", "tracked-file.md");
const GIT_FIXTURE_STAGED_FILE = join(".zcode-e2e", "git-commit-dialog", "staged-file.md");
const execGit = promisify(execFile);

function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

describe("Git 提交弹窗 UI manual-review E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await enlargeWindowIfSupported();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await prepareGitRepositoryFixture();
    await createActiveTaskForSummaryPanel();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("GCD-UI-01: 打开提交弹窗后可聚焦输入、切换未暂存范围、用方向键切换 Command 动作并展开分支列表", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await expandSummaryPanelIfCollapsed();
    await openCommitDialog();
    await waitForCommitDialogReady();
    await $(GIT_CAPSULE_CONTENT).waitForDisplayed({ reverse: true });

    await assertDialogOverlayVisible();
    // 圆角规范迁移：提交弹窗曾局部覆盖为 xl，读取计算样式防止覆盖共享 2xl 默认值。
    const radius = await browser.execute((id) => {
      const dialog = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!dialog) throw new Error("Git 提交弹窗不存在");
      return getComputedStyle(dialog).borderTopLeftRadius;
    }, TID_GIT_COMMIT_DIALOG);
    expect(radius).toBe("16px");
    await assertMessageInputFocused();
    await assertGenerateButtonIsIconOnly();
    await setCommitMessage(COMMIT_MESSAGE);
    await toggleIncludeUnstaged();

    await assertSelectedAction("commit");
    await pressArrowInMessageInput("ArrowDown");
    await assertSelectedAction("commitAndPush");
    await assertSelectedActionShowsShortcutOnly("commitAndPush");
    await pressArrowInMessageInput("ArrowUp");
    await assertSelectedAction("commit");

    await focusActionCommand();
    await browser.keys("ArrowDown");
    await assertSelectedAction("commitAndPush");

    await openBranchSwitcherFromDialog();
    await waitForBranchOption(TARGET_BRANCH);
    await browser.keys("Escape");
    await $(sel(testId(TID_GIT_COMMIT_ACTION_ITEM, "push"))).click();
    await $(
      `[data-slot="dialog-content"]:not(${sel(TID_GIT_COMMIT_DIALOG)}) [data-slot="dialog-title"]`,
    ).waitForDisplayed();
    await $(sel(TID_GIT_COMMIT_DIALOG)).waitForDisplayed({ reverse: true });
    await $(GIT_CAPSULE_CONTENT).waitForDisplayed({ reverse: true });
    await browser.keys("Escape");
    await $(GIT_CAPSULE_CONTENT).waitForDisplayed({ reverse: true });
  });

  it("uses the marked model, then falls back to the session model after clearing it", async function () {
    this.timeout(180_000);
    let requests = 0;
    const fixture = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { model } = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
        if (model !== "git-tool-model") {
          response.writeHead(400).end();
          return;
        }
        requests += 1;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            id: "tool-git-response",
            object: "chat.completion",
            created: 1,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "test(git): review generated draft" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      })().catch(() => response.writeHead(400).end());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        fixture.once("error", reject);
        fixture.listen(0, "127.0.0.1", resolve);
      });
      const address = fixture.address();
      if (!address || typeof address === "string") throw new Error("Git fixture did not bind");
      await restartIntoWorkspace({
        afterElectronProcessExit: async () => {
          await seedReplayProvider({
            id: "git-tool-provider",
            name: "Git Tool Provider",
            apiKey: "e2e-only",
            models: ["git-tool-model"],
            baseURL: `http://127.0.0.1:${address.port}/v1`,
          });
          await seedTurboAgentStartupModel("git-tool-provider", "git-tool-model");
        },
      });
      const head = (await execGit("git", ["rev-parse", "HEAD"], { cwd: DEFAULT_WORKSPACE })).stdout;
      await toggleUtilityModel(true);
      await generateAndExpectDraft("test(git): review generated draft");
      await browser.keys("Escape");
      await toggleUtilityModel(false);
      await generateAndExpectDraft("test(git): use the session model");
      expect(requests).toBe(1);
      expect((await execGit("git", ["rev-parse", "HEAD"], { cwd: DEFAULT_WORKSPACE })).stdout).toBe(
        head,
      );
    } finally {
      if (fixture.listening) await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });
});

async function toggleUtilityModel(pressed: boolean) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, "custom:git-tool-provider"));
  const button =
    '[data-model-provider-model-id="git-tool-model"] [data-testid="model-utility-toggle"]';
  await $(button).waitForEnabled();
  await $(button).click();
  await browser.waitUntil(
    async () => (await $(button).getAttribute("aria-pressed")) === String(pressed),
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}

async function generateAndExpectDraft(message: string) {
  await expandSummaryPanelIfCollapsed();
  await openCommitDialog();
  await waitForCommitDialogReady();
  await $(sel(TID_GIT_COMMIT_GENERATE_BUTTON)).click();
  await browser.waitUntil(
    async () => (await $(sel(TID_GIT_COMMIT_MESSAGE_INPUT)).getValue()) === message,
    { timeout: 30_000 },
  );
}

async function enlargeWindowIfSupported() {
  try {
    await browser.setWindowSize(1440, 900);
  } catch {
    // Electron Chromedriver 并不总是支持 window/rect；宽度只影响摘要面板自动展开策略。
  }
}

async function prepareGitRepositoryFixture(): Promise<void> {
  const fixturePath = join(DEFAULT_WORKSPACE, GIT_FIXTURE_FILE);
  await mkdir(dirname(fixturePath), { recursive: true });
  await execGit("git", ["init", "-q"], { cwd: DEFAULT_WORKSPACE });
  await execGit("git", ["config", "user.email", "zcode-e2e@example.invalid"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await execGit("git", ["config", "user.name", "ZCode E2E"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await writeFile(fixturePath, "baseline\n", "utf8");
  await execGit("git", ["add", GIT_FIXTURE_FILE], { cwd: DEFAULT_WORKSPACE });
  await execGit("git", ["commit", "-qm", "test: git dialog baseline"], {
    cwd: DEFAULT_WORKSPACE,
  });
  await execGit("git", ["branch", "-f", TARGET_BRANCH], {
    cwd: DEFAULT_WORKSPACE,
  });
  // 该用例会关闭“包含未暂存更改”。因此 fixture 必须同时提供一个已暂存和一个未暂存
  // 改动；之前只有未暂存改动，关闭后提交动作正确地变为 disabled，却被误判为 UI 回归。
  await writeFile(
    join(DEFAULT_WORKSPACE, GIT_FIXTURE_STAGED_FILE),
    "staged working tree change\n",
    "utf8",
  );
  await execGit("git", ["add", GIT_FIXTURE_STAGED_FILE], {
    cwd: DEFAULT_WORKSPACE,
  });
  await writeFile(fixturePath, "baseline\nworking tree change\n", "utf8");
}

async function createActiveTaskForSummaryPanel() {
  await ensureReadonlyToolFixtureFile();
  await prepareV4ConversationE2E();
  const marker = `E2E_GIT_COMMIT_DIALOG_${Date.now()}`;
  await sendV4Prompt(buildReadonlyToolPrompt(marker));
  await waitForV4TimelineContaining(marker);
  await waitForV4AssistantMessageContaining("e2e-ok", 90000);
  await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
    "Git 提交弹窗 E2E 的真实 v4 session 没有完成",
    90000,
  );

  // 修复原因：直接向 Zustand 塞一个 CLI 不存在的 task 会被 v4 session 订阅校验清掉，
  // 导致 activeTaskId 竞态归零。测试必须通过真实 createSession/sendText 建立活动任务。
  await $('[data-status-capsule="git"]').waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "Git 提交弹窗 E2E 没有显示摘要面板",
  });
}

interface SummaryPanelSnapshot {
  buttonCount?: number;
  exists: boolean;
  gitActionVisible?: boolean;
  state?: string | null;
  text?: string;
}

async function expandSummaryPanelIfCollapsed() {
  await openStatusCapsule("git");
}

async function openCommitDialog() {
  let latest: SummaryPanelSnapshot | null = null;

  try {
    await browser.waitUntil(
      async () => {
        const result = (await browser.execute(
          (panelTestId: string, triggerTestId: string) => {
            const panel = document.querySelector<HTMLElement>(panelTestId);
            const testIdTrigger = Array.from(
              document.querySelectorAll<HTMLElement>(`[data-testid="${triggerTestId}"]`),
            ).find((element) => {
              const disabled =
                (element instanceof HTMLButtonElement ||
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement) &&
                element.disabled;
              // macOS ChromeDriver 在状态面板 container query 切换后可能把已渲染的
              // button 报为 0×0；test id 和 disabled 才是这里的交互合同，DOM click
              // 也正是通用 helper 用于跨平台处理该 WebDriver 限制的路径。
              return !disabled;
            });
            // Git 汇总卡会把变更统计拼进可见文案（例如“提交或推送更改+3-0”）。
            // 保留 test id 优先级，并兼容旧渲染树只暴露文案入口的情形。
            const trigger =
              testIdTrigger ??
              Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((element) => {
                const text = element.innerText.trim();
                const label = element.getAttribute("aria-label")?.trim();
                return (
                  !element.disabled &&
                  [text, label].some(
                    (value) =>
                      value?.startsWith("Commit or push") || value?.startsWith("提交或推送"),
                  )
                );
              });
            trigger?.click();
            return {
              buttonCount: panel?.querySelectorAll("button").length,
              exists: Boolean(trigger),
              gitActionVisible: Boolean(trigger),
              state: panel?.getAttribute("data-state"),
              text: panel?.textContent?.trim().slice(0, 200) ?? "",
            };
          },
          '[data-status-capsule-content="git"]',
          TID_GIT_ACTION_TRIGGER,
        )) as SummaryPanelSnapshot;
        latest = result;
        return result.gitActionVisible === true;
      },
      {
        timeout: 30000,
        timeoutMsg: "Git 提交或推送入口没有出现或不可点击",
      },
    );
  } catch (error) {
    throw new Error(`Git 提交或推送入口没有出现或不可点击: ${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function waitForCommitDialogReady() {
  await $(sel(TID_GIT_COMMIT_DIALOG)).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "Git 提交弹窗没有打开",
  });
  await $(sel(TID_GIT_COMMIT_MESSAGE_INPUT)).waitForDisplayed({
    timeout: 30000,
    timeoutMsg: "Git 提交信息输入框没有出现",
  });
}

async function assertDialogOverlayVisible() {
  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector('[data-slot="dialog-overlay"]'))),
    {
      timeout: 10000,
      timeoutMsg: "Git 提交弹窗没有显示 overlay",
    },
  );
}

async function assertMessageInputFocused() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (inputTestId: string) =>
          document.activeElement?.getAttribute("data-testid") === inputTestId,
        TID_GIT_COMMIT_MESSAGE_INPUT,
      ),
    {
      timeout: 10000,
      timeoutMsg: "提交弹窗打开后没有自动聚焦提交信息输入框",
    },
  );
}

async function assertGenerateButtonIsIconOnly() {
  const snapshot = (await browser.execute((buttonTestId: string) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="${buttonTestId}"]`);
    return {
      exists: Boolean(button),
      hasIcon: Boolean(button?.querySelector("svg")),
      text: button?.textContent?.trim() ?? "",
    };
  }, TID_GIT_COMMIT_GENERATE_BUTTON)) as {
    exists: boolean;
    hasIcon: boolean;
    text: string;
  };

  expect(snapshot).toEqual({ exists: true, hasIcon: true, text: "" });
}

async function setCommitMessage(message: string) {
  const input = $(sel(TID_GIT_COMMIT_MESSAGE_INPUT));
  await input.setValue(message);
  expect(await input.getValue()).toBe(message);
}

async function toggleIncludeUnstaged() {
  const checkbox = $(sel(TID_GIT_COMMIT_INCLUDE_UNSTAGED));
  await checkbox.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: "包含未暂存更改 checkbox 没有出现",
  });
  expect(await checkbox.getAttribute("aria-checked")).toBe("true");
  await checkbox.click();
  await browser.waitUntil(async () => (await checkbox.getAttribute("aria-checked")) === "false", {
    timeout: 10000,
    timeoutMsg: "包含未暂存更改 checkbox 点击后没有切到 false",
  });
}

async function pressArrowInMessageInput(key: "ArrowDown" | "ArrowUp") {
  const input = $(sel(TID_GIT_COMMIT_MESSAGE_INPUT));
  await input.click();
  await browser.keys(key);
}

async function focusActionCommand() {
  await browser.execute((commandTestId: string) => {
    const command = document.querySelector<HTMLElement>(`[data-testid="${commandTestId}"]`);
    command?.focus();
  }, TID_GIT_COMMIT_ACTION_COMMAND);
}

async function assertSelectedAction(actionId: string) {
  await browser.waitUntil(async () => (await getSelectedActionId()) === actionId, {
    timeout: 10000,
    timeoutMsg: `提交弹窗选中动作不是 ${actionId}`,
  });
}

async function getSelectedActionId() {
  return browser.execute((actionItemBaseTestId: string) => {
    const prefix = `${actionItemBaseTestId}-`;
    const selected = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"][data-selected="true"]`),
    )[0];
    return selected?.dataset.testid?.slice(prefix.length) ?? null;
  }, TID_GIT_COMMIT_ACTION_ITEM);
}

async function assertSelectedActionShowsShortcutOnly(actionId: string) {
  const actionTestId = testId(TID_GIT_COMMIT_ACTION_ITEM, actionId);
  const snapshot = (await browser.execute((currentActionTestId: string) => {
    const action = document.querySelector<HTMLElement>(`[data-testid="${currentActionTestId}"]`);
    return {
      checked: action?.getAttribute("data-checked") ?? null,
      hasShortcut: Boolean(action?.querySelector('[data-slot="command-shortcut"]')),
    };
  }, actionTestId)) as { checked: string | null; hasShortcut: boolean };

  expect(snapshot).toEqual({ checked: null, hasShortcut: true });
}

async function openBranchSwitcherFromDialog() {
  await browser.waitUntil(
    async () =>
      browser.execute((dialogTestId: string) => {
        const dialog = document.querySelector(`[data-testid="${dialogTestId}"]`);
        const trigger = dialog
          ?.querySelector('[data-branch-switcher-primary-icon="true"]')
          ?.closest("button");
        trigger?.click();
        return Boolean(trigger);
      }, TID_GIT_COMMIT_DIALOG),
    {
      timeout: 10000,
      timeoutMsg: "提交弹窗顶部的分支切换入口没有出现",
    },
  );
}

async function waitForBranchOption(branchName: string) {
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).some(
          (item) => item.textContent?.includes("e2e-target"),
        ),
      ),
    {
      timeout: 15000,
      timeoutMsg: `分支下拉列表没有展示可切换分支 ${branchName}`,
    },
  );
}
