// BUILTIN-IMAGE-GENERATION 候选（BI01、BI02、BI05、BI06、BI08 切片），保留人工审核状态。
// Windows qa03 已验证初版主链，新增的多模型草稿断言以更新版本的运行记录为准。
// 被测对象是桌面 Renderer 直接渲染的原生生图工作台：不安装插件，不经过扩展沙箱、webview 或 AppBridge。
// 回环 Images 夹具记录每个请求：第 1 个返回 PNG，第 2 个在完整收到请求后断开；全程不接触付费服务。
//
// 已写入的断言：无插件、无会话打开；未配置不可生成且零请求；取消确认零请求且不产生任务；
// 双栏配置、临时模型、新建恢复默认、草稿离开门禁，以及 Base64 协议保存重开零请求；
// 首次确认只发一次固定模型请求；导出与原图字节一致、取消保存不落文件；发送后断连显示结果未知与费用提示且不重发；
// 冷重启只读恢复两条记录；旧插件已安装时入口仍走原生链路且没有第二条受理链。
// 未覆盖（不得据此计为通过）：同进程切换项目、远端／手机／普通 Web 拒绝、等待中重启、同请求 ID 冲突、多窗口并发、
// 分页、主题与窄窗口视觉、旧会话模拟卡片打开兼容、真实保存对话框与原生焦点、旧插件确实已加载。
//
// 运行前置：回放 provider 模式、未打包的 "ZCode E2E" 进程、
// ZCODE_E2E_HOME_DIR 指向 packages/desktop/.e2e-home-genimage、ZCODE_E2E_GENIMAGE_ENDPOINT 等于下方夹具地址。
// 外层 Mocha 预算需用 ZCODE_E2E_MANUAL_REVIEW_HOLD_MS 放宽；用例内 this.timeout 无法覆盖外层计时器。
import { createServer, type Server } from "node:http";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { TID_CONFIRM_DIALOG_CONFIRM, TID_SETTINGS_BACK_BUTTON } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import {
  restartIntoWorkspacePreservingProfile,
  seedTurboAgentStartupModel,
} from "#e2e/helpers/model-provider-restart-runtime";
import { writePluginDirsConfig } from "#e2e/helpers/extension-host-views";

const FIXTURE_URL = "http://127.0.0.1:43971/v1/images/generations";
const DEDICATED_HOME_NAME = ".e2e-home-genimage";
const DISCONNECT_AT_REQUEST = 2;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAI0lEQVR4AYXBAQEAMAiAME6394+kDWR7/BkOEiRIkCBBgoQFVvsCUyvaXNIAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const WORKSPACE_SELECTOR = '[data-testid="genimage-workspace"]';
const CONFIRM_DIALOG_SELECTOR = '[data-confirm-intent="genimage-generate"]';
const PROMPT_FIRST = "A blue square";
const PROMPT_DISCONNECT = "Disconnect after send";
const PROMPT_LEGACY_PLUGIN = "Legacy plugin installed";
const LEGACY_PLUGIN_ID = "genimage@inline";

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  receivedAt: string;
}

interface ControlState {
  count: number;
  displayed: boolean;
  enabled: boolean;
}

interface JobState {
  status: string;
  jobId: string | null;
  assetId: string | null;
  text: string;
}

interface WorkspaceSnapshot {
  displayed: boolean;
  sandboxCount: number;
  genImageViewCount: number;
  sidebarPressed: string | null;
  controls: Record<
    "new" | "history" | "openModelSettings" | "prompt" | "generate" | "export",
    ControlState
  >;
  promptValue: string | null;
  jobs: JobState[];
  unknownCostNotice: string | null;
  activeTestid: string | null;
}

interface ConfirmDialogState {
  displayed: boolean;
  text: string;
  focusOnNonConfirmButton: boolean;
}

let fixture: Server | undefined;
const requests: RecordedRequest[] = [];
let historyOpenedByTest = false;
const flow: { chatSelection: unknown; assetId: string; completed: Set<string> } = {
  chatSelection: undefined,
  assetId: "",
  completed: new Set(),
};

function trace(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`[image-generation-e2e] ${event} ${JSON.stringify(detail)}\n`);
}

function settle(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function controlSelector(control: string): string {
  const name = control === "openModelSettings" ? "open-model-settings" : control;
  return `${WORKSPACE_SELECTOR} [data-testid="genimage-${name}"]`;
}

function requireStep(step: string): void {
  if (!flow.completed.has(step)) {
    throw new Error(
      `Precondition not met: "${step}" did not complete, so this test cannot produce a verdict.`,
    );
  }
}

async function startImagesFixture(): Promise<void> {
  fixture = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
        receivedAt: new Date().toISOString(),
      });
      trace("fixture-request", {
        index: requests.length,
        method: request.method ?? "",
        url: request.url ?? "",
      });
      if (requests.length === DISCONNECT_AT_REQUEST) {
        // Host 先持久化发送屏障再联网；完整收到请求后断开，只能结算为结果未知，读取与重启都不得补发。
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    fixture!.once("error", reject);
    fixture!.listen(43971, "127.0.0.1", resolveListen);
  });
}

function assertE2EPreconditions(): void {
  if (process.env.E2E_PROVIDER_CAPTURE_MODE !== "replay") {
    throw new Error(
      "Run this candidate in the replay provider mode (E2E_PROVIDER_HTTP_MODE=replay); no real model or image provider may be contacted.",
    );
  }
  if (
    process.env.ZCODE_E2E_GENIMAGE_ENDPOINT !== FIXTURE_URL ||
    !process.env.ZCODE_E2E_RUN_ID?.trim()
  ) {
    throw new Error(`Set ZCODE_E2E_GENIMAGE_ENDPOINT=${FIXTURE_URL} before starting WDIO`);
  }
  if (resolve(getE2EAppDataPaths().homeDir) !== resolve(process.cwd(), DEDICATED_HOME_NAME)) {
    throw new Error(
      `ZCODE_E2E_HOME_DIR must be the dedicated desktop ${DEDICATED_HOME_NAME} directory`,
    );
  }
  if (!process.env.ZCODE_E2E_ARTIFACT_DIR?.trim()) {
    throw new Error("ZCODE_E2E_ARTIFACT_DIR is required for evidence screenshots");
  }
}

/** 夹具入口只在未打包的 E2E 进程内由 Main 转发给 Host；任一条件缺失时 Host 会使用固定生产目的地，必须停止。 */
async function assertFixtureRoutingInAppProcess(): Promise<void> {
  const state = await browser.electron.execute((electron) => ({
    name: electron.app.getName(),
    packaged: electron.app.isPackaged,
    endpoint: process.env.ZCODE_E2E_GENIMAGE_ENDPOINT ?? "",
    runId: process.env.ZCODE_E2E_RUN_ID ?? "",
    homeDir: process.env.ZCODE_E2E_HOME_DIR ?? "",
  }));
  trace("app-process-routing", state);
  expect(state.name).toBe("ZCode E2E");
  expect(state.packaged).toBe(false);
  expect(state.endpoint).toBe(FIXTURE_URL);
  expect(state.runId.trim()).not.toBe("");
  expect(state.homeDir.trim()).not.toBe("");
}

/** 本文件的主流程要求隔离 profile 里没有任何 genimage 插件；环境不符合时失败，不降级为跳过。 */
async function assertNoGenImagePluginInProfile(): Promise<void> {
  const config = await readFile(
    join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "config.json"),
    "utf8",
  ).catch(() => "");
  expect(config.toLowerCase().includes("genimage")).toBe(false);
}

async function chatDefaultSelection(): Promise<unknown> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: getE2EAppDataPaths().configFile,
    pollingIntervalMs: false,
  });
  try {
    return (await repository.read()).defaultModelSelection;
  } finally {
    repository.dispose();
  }
}

async function activeTaskIds(): Promise<Array<string | null>> {
  return browser.execute(() => {
    const bridge = (
      window as typeof window & {
        __zcodeSessionStoreE2E?: {
          getState?: () => {
            workspaces?: Record<string, { activeTaskId?: string | null }>;
          };
        };
      }
    ).__zcodeSessionStoreE2E;
    if (typeof bridge?.getState !== "function")
      throw new Error("Session store E2E bridge is unavailable");
    return Object.values(bridge.getState().workspaces ?? {}).map(
      (workspace) => workspace.activeTaskId ?? null,
    );
  });
}

async function assertNoSession(): Promise<void> {
  const ids = await activeTaskIds();
  trace("session-store", { activeTaskIds: ids });
  expect(ids.every((id) => id === null)).toBe(true);
}

/** 只读取主 Renderer 文档里的原生工作台；返回值全部是可序列化数据，失败时作为最后读数输出。 */
async function readWorkspaceSnapshot(): Promise<WorkspaceSnapshot | null> {
  return browser.execute((): WorkspaceSnapshot | null => {
    const workspace = document.querySelector<HTMLElement>('[data-testid="genimage-workspace"]');
    if (!workspace) return null;
    const rect = workspace.getBoundingClientRect();
    const describe = (testId: string) => {
      const elements = Array.from(
        workspace.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
      );
      const visible = elements.filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      return {
        count: elements.length,
        displayed: visible.length > 0,
        enabled: visible.some((element) => !(element as HTMLButtonElement).disabled),
      };
    };
    const prompt = workspace.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      '[data-testid="genimage-prompt"]',
    );
    const focused = document.activeElement;
    return {
      displayed: rect.width > 0 && rect.height > 0,
      sandboxCount: workspace.querySelectorAll("webview, iframe").length,
      genImageViewCount: document.querySelectorAll(
        '[data-testid="extension-view"][data-extension-view-id*="genimage"]',
      ).length,
      sidebarPressed:
        document
          .querySelector('[data-testid="genimage-sidebar-open"]')
          ?.getAttribute("aria-pressed") ?? null,
      controls: {
        new: describe("genimage-new"),
        history: describe("genimage-history"),
        openModelSettings: describe("genimage-open-model-settings"),
        prompt: describe("genimage-prompt"),
        generate: describe("genimage-generate"),
        export: describe("genimage-export"),
      },
      promptValue: prompt && "value" in prompt ? prompt.value : null,
      jobs: Array.from(workspace.querySelectorAll<HTMLElement>("[data-job-status]")).map(
        (element) => ({
          status: element.dataset.jobStatus ?? "",
          jobId: element.dataset.jobId ?? null,
          assetId: element.dataset.assetId ?? null,
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
        }),
      ),
      unknownCostNotice:
        workspace.querySelector('[data-testid="genimage-outcome-unknown-notice"]')?.textContent ??
        null,
      activeTestid: focused?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
    };
  });
}

async function waitForWorkspace(
  predicate: (snapshot: WorkspaceSnapshot) => boolean,
  message: string,
  timeout = 30000,
): Promise<WorkspaceSnapshot> {
  let latest: WorkspaceSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readWorkspaceSnapshot();
        return latest !== null && predicate(latest);
      },
      { timeout, interval: 200 },
    );
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(latest)}`, { cause: error });
  }
  return latest!;
}

async function readConfirmDialog(): Promise<ConfirmDialogState> {
  return browser.execute((confirmId) => {
    const dialog = document.querySelector<HTMLElement>('[data-confirm-intent="genimage-generate"]');
    if (!dialog) return { displayed: false, text: "", focusOnNonConfirmButton: false };
    const rect = dialog.getBoundingClientRect();
    const focused = document.activeElement;
    return {
      displayed: rect.width > 0 && rect.height > 0,
      text: (dialog.textContent ?? "").replace(/\s+/g, " ").trim(),
      focusOnNonConfirmButton:
        focused instanceof HTMLButtonElement &&
        dialog.contains(focused) &&
        focused.dataset.testid !== confirmId,
    };
  }, TID_CONFIRM_DIALOG_CONFIRM);
}

async function waitForRequestCount(count: number, message: string): Promise<void> {
  await browser.waitUntil(async () => requests.length >= count, {
    timeout: 30000,
    interval: 100,
    timeoutMsg: `${message} (recorded ${requests.length})`,
  });
}

async function saveEvidence(name: string): Promise<void> {
  await browser.saveScreenshot(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, `image-generation-${name}.png`),
  );
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

async function clickControl(control: string): Promise<void> {
  const element = await $(controlSelector(control));
  await element.waitForDisplayed({ timeout: 30000 });
  await element.waitForEnabled({ timeout: 30000 });
  await element.click();
}

/** 详情里的导出等控件可能随选中状态出现；只点击当前可见且可用的那一个。 */
async function clickDisplayedControl(control: string): Promise<void> {
  let clicked = false;
  await browser.waitUntil(
    async () => {
      for (const element of await $$(controlSelector(control))) {
        if (!(await element.isDisplayed()) || !(await element.isEnabled())) continue;
        await element.click();
        clicked = true;
        return true;
      }
      return false;
    },
    {
      timeout: 30000,
      interval: 200,
      timeoutMsg: `an enabled ${control} control should be displayed`,
    },
  );
  expect(clicked).toBe(true);
}

/** 重启后 WebDriver 元素绑定随旧 session 失效，入口每次都重新查询。 */
async function openWorkspaceFromSidebar(): Promise<WorkspaceSnapshot> {
  historyOpenedByTest = false;
  const entry = $('[data-testid="genimage-sidebar-open"]');
  await entry.waitForDisplayed({ timeout: 60000 });
  await entry.click();
  return waitForWorkspace(
    (snapshot) =>
      snapshot.displayed &&
      snapshot.controls.new.displayed &&
      snapshot.controls.history.displayed &&
      snapshot.controls.openModelSettings.displayed,
    "the native image workspace should open from the primary sidebar",
    60000,
  );
}

async function openGenerationComposer(): Promise<void> {
  const current = await readWorkspaceSnapshot();
  if (!current?.controls.prompt.displayed) {
    await clickControl("new");
    // 生成与历史共用页内浮层位置：重新打开生成面板后，历史是否仍打开由产品决定，这里不再假定。
    historyOpenedByTest = false;
  }
  await waitForWorkspace(
    (snapshot) => snapshot.controls.prompt.displayed,
    "new generation should show the prompt field",
  );
}

async function enterPrompt(text: string): Promise<void> {
  const prompt = await $(controlSelector("prompt"));
  await prompt.waitForDisplayed({ timeout: 30000 });
  await prompt.setValue(text);
}

async function openConfirmationFor(prompt: string): Promise<void> {
  await openGenerationComposer();
  await enterPrompt(prompt);
  await waitForWorkspace(
    (snapshot) =>
      snapshot.promptValue === prompt &&
      snapshot.controls.generate.displayed &&
      snapshot.controls.generate.enabled,
    `generate should be enabled for the configured prompt: ${prompt}`,
  );
  await clickControl("generate");
  await browser.waitUntil(async () => (await readConfirmDialog()).displayed, {
    timeout: 30000,
    interval: 200,
    timeoutMsg: "the generation confirmation should open",
  });
}

async function confirmGeneration(): Promise<void> {
  const confirm = $(`${CONFIRM_DIALOG_SELECTOR} [data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
  await confirm.waitForDisplayed({ timeout: 30000 });
  await confirm.click();
}

/** 画布上没有任务节点时先打开历史；每次打开生成面板或重启后重新计算，避免把切换按钮点成关闭。 */
async function revealJobs(): Promise<void> {
  const snapshot = await readWorkspaceSnapshot();
  if (!snapshot || snapshot.jobs.length > 0 || historyOpenedByTest) return;
  await clickControl("history");
  historyOpenedByTest = true;
  await settle(500);
}

async function seedLegacyGenImagePlugin(): Promise<void> {
  const source = resolve(
    process.env.ZCODE_E2E_GENIMAGE_PLUGIN_DIR?.trim() ||
      resolve(process.cwd(), "../../plugins/apps/genimage/dist/market/genimage"),
  );
  const manifest = JSON.parse(
    await readFile(join(source, ".zcode-plugin", "plugin.json"), "utf8").catch((error: unknown) => {
      throw new Error(
        "Missing the legacy GenImage market artifact; build plugins/apps/genimage or set ZCODE_E2E_GENIMAGE_PLUGIN_DIR",
        { cause: error },
      );
    }),
  ) as { name?: string; version?: string };
  expect(manifest.name).toBe("genimage");
  expect(typeof manifest.version).toBe("string");
  const target = join(getE2EAppDataPaths().homeDir, "fixtures", "genimage-legacy", "genimage");
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  await writePluginDirsConfig([target], [LEGACY_PLUGIN_ID]);
}

describe("BUILTIN-IMAGE-GENERATION native image workspace", () => {
  before(async function () {
    this.timeout(600000);
    assertE2EPreconditions();
    await startImagesFixture();
    await assertNoGenImagePluginInProfile();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () =>
        seedTurboAgentStartupModel("fixture-chat-provider", "fixture-chat-model"),
    });
    await assertFixtureRoutingInAppProcess();
    flow.chatSelection = await chatDefaultSelection();
    expect(flow.chatSelection).toMatchObject({
      providerId: "fixture-chat-provider",
      modelId: "fixture-chat-model",
    });
    trace("prepared", { chatSelection: flow.chatSelection });
  });

  after(async () => {
    trace("summary", { requestCount: requests.length, completedSteps: [...flow.completed] });
    try {
      await clearAppData();
    } finally {
      if (fixture?.listening) {
        await new Promise<void>((resolveClose, reject) =>
          fixture!.close((error) => (error ? reject(error) : resolveClose())),
        );
      }
    }
  });

  it("BI01/BI05 opens with no plugin and no session; an unconfigured profile cannot generate", async function () {
    this.timeout(600000);
    const entry = $('[data-testid="genimage-sidebar-open"]');
    await entry.waitForDisplayed({ timeout: 60000 });
    await assertNoSession();
    expect(requests).toHaveLength(0);
    await entry.click();
    const opened = await waitForWorkspace(
      (snapshot) =>
        snapshot.displayed &&
        snapshot.controls.new.displayed &&
        snapshot.controls.history.displayed &&
        snapshot.controls.openModelSettings.displayed,
      "the native image workspace should render in the main area",
      60000,
    );
    expect(opened.sidebarPressed).toBe("true");
    // 原生工作台直接渲染在主 Renderer：内部没有 webview／iframe，也没有 genimage 的扩展视图窗格。
    expect(opened.sandboxCount).toBe(0);
    expect(opened.genImageViewCount).toBe(0);
    await assertNoSession();
    await saveEvidence("bi01-opened-unconfigured");

    await openGenerationComposer();
    const composer = await readWorkspaceSnapshot();
    if (composer?.controls.prompt.displayed) await enterPrompt(PROMPT_FIRST);
    await settle(1000);
    const unconfigured = await readWorkspaceSnapshot();
    trace("unconfigured", {
      controls: unconfigured?.controls,
      promptValue: unconfigured?.promptValue,
    });
    expect(unconfigured?.controls.generate.enabled).toBe(false);
    expect((await readConfirmDialog()).displayed).toBe(false);
    expect(requests).toHaveLength(0);
    await assertNoSession();
    flow.completed.add("bi01");
  });

  it("BI02 (initial API key card) saving the key sends nothing and leaving settings returns to the workspace", async function () {
    this.timeout(600000);
    requireStep("bi01");
    await clickControl("openModelSettings");
    const key = $('[data-testid="genimage-api-key"]');
    try {
      await key.waitForEnabled({ timeout: 30000 });
    } catch (error) {
      const evidence = await browser.execute(() => ({
        settings: Array.from(document.querySelectorAll<HTMLElement>('[data-testid*="settings"]'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map((element) => ({
            testId: element.dataset.testid ?? null,
            text: (element.innerText ?? "").replace(/\s+/g, " ").slice(0, 500),
          }))
          .slice(0, 30),
        keyCount: document.querySelectorAll('[data-testid="genimage-api-key"]').length,
        workspaceVisible: Boolean(document.querySelector('[data-testid="genimage-workspace"]')),
      }));
      trace("settings-key-unavailable", evidence);
      await saveEvidence("bi02-settings-key-unavailable");
      throw new Error(`Image settings key unavailable: ${JSON.stringify(evidence)}`, {
        cause: error,
      });
    }
    await key.setValue("e2e-image-fixture-key");
    await $('[data-testid="genimage-save-settings"]').click();
    await browser.waitUntil(async () => (await key.getValue()) === "", {
      timeout: 30000,
      timeoutMsg: "saving the image credential should clear the input",
    });
    expect(requests).toHaveLength(0);
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await waitForWorkspace(
      (snapshot) => snapshot.displayed && snapshot.controls.new.displayed,
      "leaving settings should return to the image workspace rather than chat",
      60000,
    );
    expect(requests).toHaveLength(0);
    await assertNoSession();
    flow.completed.add("bi02");
  });

  it("BI02: a temporary image model choice applies to one generation draft", async function () {
    requireStep("bi02");
    await clickControl("openModelSettings");
    const addModel = $('[data-testid="genimage-add-model"]');
    await addModel.waitForEnabled({ timeout: 30000 });
    await addModel.click();
    const modelFields = '[data-testid="genimage-settings"] fieldset[data-model-key]';
    await browser.waitUntil(async () => (await $$(modelFields).length) === 2, { timeout: 30000 });
    const addedModel = $$(modelFields)[1]!;
    await addedModel.$('input[id$="-name"]').setValue("Alternate image fixture");
    await addedModel.$('input[id$="-model"]').setValue("alternate-image-fixture");
    const save = $('[data-testid="genimage-save-settings"]');
    await save.click();
    await browser.waitUntil(async () => !(await save.isEnabled()), { timeout: 30000 });
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await openGenerationComposer();
    const picker = $(`${WORKSPACE_SELECTOR} select`);
    const defaultValue = await picker.getValue();
    await picker.selectByVisibleText("OpenAI · Alternate image fixture");
    const temporaryValue = await picker.getValue();
    expect(temporaryValue).not.toBe(defaultValue);
    await enterPrompt(PROMPT_FIRST);
    await clickControl("generate");
    await browser.waitUntil(async () => (await readConfirmDialog()).displayed, { timeout: 30000 });
    expect((await readConfirmDialog()).text).toContain("alternate-image-fixture");
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await readConfirmDialog()).displayed, { timeout: 10000 });
    expect(await picker.getValue()).toBe(temporaryValue);
    await clickControl("new");
    expect(await picker.getValue()).toBe(defaultValue);
    expect(requests).toHaveLength(0);
  });

  it("BI02: keyboard and Quick Pick respect the settings draft before leaving", async function () {
    requireStep("bi02");
    const sidebarEntry = $('[data-testid="genimage-sidebar-open"]');
    const key = $('[data-testid="genimage-api-key"]');
    const discard = $('[data-confirm-intent="genimage-settings-discard"]');
    const settingsBack = $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`);
    const modifier = process.platform === "darwin" ? "Command" : "Control";
    const draft = "e2e-unsaved-image-key";

    await sidebarEntry.waitForDisplayed();
    await clickControl("openModelSettings");
    await key.waitForEnabled();
    await key.setValue(draft);
    await browser.keys([modifier, "b"]);
    await discard.waitForDisplayed();
    await browser.keys(["Escape"]);
    await discard.waitForDisplayed({ reverse: true });
    expect(await key.getValue()).toBe(draft);
    expect(requests).toHaveLength(0);

    await browser.keys([modifier, "k"]);
    const commandSearch = $('[role="dialog"] [cmdk-input]');
    await commandSearch.waitForDisplayed();
    await commandSearch.setValue("toggle sidebar");
    const sidebarCommand = $('[cmdk-item][data-value*="toggle sidebar"]');
    await sidebarCommand.waitForDisplayed();
    expect(await discard.isDisplayed()).toBe(false);
    await sidebarCommand.click();
    await discard.waitForDisplayed();
    expect(await key.getValue()).toBe(draft);
    await discard.$(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).click();
    await waitForWorkspace((snapshot) => snapshot.displayed, "the command should return to images");
    await sidebarEntry.waitForDisplayed({ reverse: true });

    await clickControl("openModelSettings");
    await key.waitForEnabled();
    expect(await key.getValue()).toBe("");
    await settingsBack.click();
    await waitForWorkspace(
      (snapshot) => snapshot.displayed,
      "clean settings should close directly",
    );
    expect(await discard.isDisplayed()).toBe(false);
    expect(await sidebarEntry.isDisplayed()).toBe(false);
    await browser.keys([modifier, "b"]);
    await sidebarEntry.waitForDisplayed();
    expect(requests).toHaveLength(0);
    await assertNoSession();
  });

  it("BI02: native new task and both folder pickers preserve a draft when cancelled", async function () {
    requireStep("bi02");
    const key = $('[data-testid="genimage-api-key"]');
    const discard = $('[data-confirm-intent="genimage-settings-discard"]');
    const modifier = process.platform === "darwin" ? "Command" : "Control";
    const draft = "e2e-native-navigation-unsaved-key";
    const otherWorkspace = join(getE2EAppDataPaths().homeDir, "image-other-workspace");
    await mkdir(otherWorkspace, { recursive: true });
    const readTabs = () =>
      browser.execute(() => {
        const bridge = (
          window as typeof window & {
            __zcodeTabStoreE2E?: {
              getState(): { activeTabId: string | null; activeWorkspacePath: string | null };
            };
          }
        ).__zcodeTabStoreE2E;
        if (!bridge) throw new Error("Tab store E2E bridge is unavailable");
        const { activeTabId, activeWorkspacePath } = bridge.getState();
        return { activeTabId, activeWorkspacePath };
      });
    const cancelDiscard = async () => {
      await discard.waitForDisplayed();
      await browser.keys(["Escape"]);
      await discard.waitForDisplayed({ reverse: true });
      expect(await key.getValue()).toBe(draft);
    };
    // WDIO 注入的 Ctrl+N 未到达 Windows 原生菜单；激活实际菜单项，保留 Main → Renderer IPC。
    const openFileMenuCommand = (accelerator: string) =>
      browser.electron.execute((electron, expected) => {
        const item = electron.Menu.getApplicationMenu()
          ?.items.flatMap((menu) => menu.submenu?.items ?? [])
          .find((entry) => entry.accelerator?.toLowerCase() === expected.toLowerCase());
        const target = electron.BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes("/renderer/index.html"),
        );
        if (!item?.enabled || !target)
          throw new Error(`Native menu command unavailable: ${expected}`);
        target.focus();
        item.click(item, target, {} as never);
      }, accelerator);
    const openQuickPickFolder = async () => {
      await browser.keys([modifier, "k"]);
      const input = $('[role="dialog"] [cmdk-input]');
      await input.waitForDisplayed();
      await input.setValue("open workspace");
      await $('[cmdk-item][data-value*="open workspace"]').click();
      await input.waitForDisplayed({ reverse: true });
    };

    await clickControl("openModelSettings");
    await key.waitForEnabled();
    await key.setValue(draft);
    const before = await readTabs();
    await openFileMenuCommand("CmdOrCtrl+N");
    await cancelDiscard();
    expect(await readTabs()).toEqual(before);
    await assertNoSession();

    // 只替代系统目录选择结果，不绕过原生菜单、Quick Pick 或导航门禁。
    const picker = await browser.electron.mock("dialog", "showOpenDialog");
    try {
      const openFolder = [() => openFileMenuCommand("CmdOrCtrl+O"), openQuickPickFolder];
      for (const [index, open] of openFolder.entries()) {
        await picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
        await open();
        await expect(picker).toHaveBeenCalledTimes(index * 2 + 1);
        expect(await discard.isDisplayed()).toBe(false);
        expect(await key.getValue()).toBe(draft);
        expect(await readTabs()).toEqual(before);

        await picker.mockResolvedValueOnce({ canceled: false, filePaths: [otherWorkspace] });
        await open();
        await cancelDiscard();
        await expect(picker).toHaveBeenCalledTimes(index * 2 + 2);
        expect(await readTabs()).toEqual(before);
      }
    } finally {
      await picker.mockRestore();
    }
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await discard.waitForDisplayed();
    await discard.$(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).click();
    await waitForWorkspace(
      (snapshot) => snapshot.displayed,
      "leaving settings should restore images",
    );
    expect(requests).toHaveLength(0);
    await assertNoSession();
  });

  it("BI02/BI09: a custom Base64 connection saves and reopens without a provider request", async function () {
    requireStep("bi02");
    await clickControl("openModelSettings");
    const settings = $('[data-testid="genimage-settings"]');
    const protocol = settings.$('[data-testid="genimage-protocol"]');
    const key = settings.$('[data-testid="genimage-api-key"]');
    const connections = settings.$('[data-testid="genimage-connection-select"]');
    const save = settings.$('[data-testid="genimage-save-settings"]');
    const connectionName = "Base64 Images fixture";
    const baseUrl = "https://images.example.com/v1";
    await key.waitForEnabled();
    expect(await protocol.isEnabled()).toBe(false);
    const officialId = await connections.getValue();
    await settings.$('[data-testid="genimage-add-connection"]').click();
    await protocol.waitForEnabled();
    await settings.$('fieldset > div input[id$="-name"]').setValue(connectionName);
    await settings.$('input[id$="-base"]').setValue(baseUrl);
    await settings.$('input[id$="-generation"]').setValue("/images/generations");
    await settings.$('input[id$="-probe"]').setValue("/models");
    await key.setValue("e2e-base64-fixture-key");
    await settings.$('[data-testid="genimage-add-model"]').click();
    const model = settings.$("fieldset[data-model-key]");
    await model.$('input[id$="-name"]').setValue("Base64 fixture model");
    await model.$('input[id$="-model"]').setValue("base64-fixture-model");
    const size = model.$('select[id$="-size"]');
    const quality = model.$('select[id$="-quality"]');
    const background = model.$('select[id$="-background"]');
    await size.selectByAttribute("value", "1024x1536");
    await background.selectByAttribute("value", "transparent");
    await quality.selectByAttribute("value", "high");
    await protocol.selectByAttribute("value", "openai-images-b64");
    expect(await size.getValue()).toBe("");
    expect(await quality.getValue()).toBe("high");
    expect(await background.isExisting()).toBe(false);
    await size.selectByAttribute("value", "2048x2048");
    await save.waitForEnabled();
    await save.click();
    const destination = $('[data-confirm-intent="genimage-destination"]');
    await destination.waitForDisplayed();
    expect(await destination.getText()).toContain(`${baseUrl}/images/generations`);
    expect(await destination.getText()).toContain(`${baseUrl}/models`);
    expect(requests).toHaveLength(0);
    await destination.$(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`).click();
    await browser.waitUntil(async () => !(await save.isEnabled()) && (await key.getValue()) === "");
    const customId = await connections.getValue();
    expect(customId).not.toBe(officialId);
    expect(customId).not.toBe("");
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await waitForWorkspace((snapshot) => snapshot.displayed, "settings should close after saving");
    await clickControl("openModelSettings");
    await key.waitForEnabled();
    await connections.selectByAttribute("value", customId);
    await browser.waitUntil(async () => (await protocol.getValue()) === "openai-images-b64");
    expect(await key.getValue()).toBe("");
    expect(await size.getValue()).toBe("2048x2048");
    expect(await quality.getValue()).toBe("high");
    expect(await background.isExisting()).toBe(false);
    expect(requests).toHaveLength(0);
    await saveEvidence("bi02-base64-settings-reopened");
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    await waitForWorkspace((snapshot) => snapshot.displayed, "reopened settings should close");
  });

  it("BI05 cancelling the confirmation (Enter on the focused cancel, then Escape) sends nothing and records no job", async function () {
    this.timeout(600000);
    requireStep("bi02");
    await openConfirmationFor(PROMPT_FIRST);
    const dialog = await readConfirmDialog();
    expect(dialog.text).toContain("gpt-image-1");
    expect(dialog.text).toContain(PROMPT_FIRST);
    // 生成是需要明确确认的动作：初始焦点在取消而不是确认按钮。
    expect(dialog.focusOnNonConfirmButton).toBe(true);
    await saveEvidence("bi05-confirmation");
    await browser.keys(["Enter"]);
    await browser.waitUntil(async () => !(await readConfirmDialog()).displayed, {
      timeout: 10000,
      timeoutMsg: "Enter on the focused cancel should dismiss the confirmation",
    });
    trace("after-cancel-enter", {
      activeTestid: (await readWorkspaceSnapshot())?.activeTestid ?? null,
    });
    await settle(1000);
    expect(requests).toHaveLength(0);
    expect((await readWorkspaceSnapshot())?.jobs ?? []).toHaveLength(0);

    await openConfirmationFor(PROMPT_FIRST);
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await readConfirmDialog()).displayed, {
      timeout: 10000,
      timeoutMsg: "Escape should dismiss the confirmation",
    });
    await revealJobs();
    await settle(1000);
    expect((await readWorkspaceSnapshot())?.jobs ?? []).toHaveLength(0);
    expect(requests).toHaveLength(0);
    await assertNoSession();
    flow.completed.add("bi05-cancel");
  });

  it("BI05/BI06 the first confirmed generation sends exactly one fixed-model request; a double activation adds nothing", async function () {
    this.timeout(600000);
    requireStep("bi05-cancel");
    await openGenerationComposer();
    await enterPrompt(PROMPT_FIRST);
    await waitForWorkspace(
      (snapshot) =>
        snapshot.promptValue === PROMPT_FIRST &&
        snapshot.controls.generate.displayed &&
        snapshot.controls.generate.enabled,
      "generate should be enabled for the configured prompt",
    );
    // 同一任务内连续两次激活，等价于确认框出现前的连击；断言上游请求与受理结果，不断言浮层实现。
    expect(
      await browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid="genimage-workspace"] [data-testid="genimage-generate"]',
        );
        if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
        button.click();
        button.click();
        return true;
      }),
    ).toBe(true);
    await browser.waitUntil(async () => (await readConfirmDialog()).displayed, {
      timeout: 30000,
      timeoutMsg: "double activation should open the generation confirmation",
    });
    const confirmation = await readConfirmDialog();
    expect(confirmation.displayed).toBe(true);
    expect(confirmation.text).toContain("gpt-image-1");
    expect(confirmation.text).toContain(PROMPT_FIRST);
    await confirmGeneration();
    await waitForRequestCount(
      1,
      "one explicit confirmation should send one Images fixture request",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("/v1/images/generations");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      model: "gpt-image-1",
      prompt: PROMPT_FIRST,
      n: 1,
    });
    trace("first-request", { request: requests[0] });
    await settle(1000);
    await revealJobs();
    const succeeded = await waitForWorkspace(
      (snapshot) => snapshot.jobs.some((job) => job.status === "succeeded" && Boolean(job.assetId)),
      "the fixture PNG should become a succeeded job",
      60000,
    );
    const asset = succeeded.jobs.find((job) => job.status === "succeeded")?.assetId ?? "";
    expect(asset).toBeTruthy();
    flow.assetId = asset;
    const jobIds = new Set(
      succeeded.jobs.map((job) => job.jobId).filter((jobId): jobId is string => Boolean(jobId)),
    );
    expect(jobIds.size).toBe(1);
    let residualConfirmations = 0;
    while ((await readConfirmDialog()).displayed && residualConfirmations < 3) {
      residualConfirmations += 1;
      await browser.keys(["Escape"]);
      await settle(300);
    }
    trace("double-activation", { residualConfirmations });
    await settle(1500);
    expect(requests).toHaveLength(1);
    expect(await chatDefaultSelection()).toEqual(flow.chatSelection);
    await assertNoSession();
    await saveEvidence("bi05-first-generation-succeeded");
    flow.completed.add("bi05-first-call");
  });

  it("BI06 exporting the original PNG preserves its bytes, a cancelled save writes nothing, and no request is sent", async function () {
    this.timeout(600000);
    requireStep("bi05-first-call");
    await revealJobs();
    const jobSelector = `${WORKSPACE_SELECTOR} [data-job-status="succeeded"][data-asset-id="${flow.assetId}"]`;
    const job = await $(`${jobSelector} button`);
    await job.waitForDisplayed({ timeout: 30000 });
    await job.click();
    await $(`${WORKSPACE_SELECTOR} [data-testid="genimage-view-original"]`).click();
    const original = await $('[data-testid="genimage-original-image"]');
    await original.waitForDisplayed({ timeout: 30000 });
    await browser.keys(["Escape"]);
    await original.waitForDisplayed({ reverse: true, timeout: 10000 });
    expect(requests).toHaveLength(1);
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR!;
    const cancelledTarget = join(artifactDir, "image-generation-export-cancelled.png");
    const target = join(artifactDir, "image-generation-export.png");
    const save = await browser.electron.mock("dialog", "showSaveDialog");
    try {
      await save.mockResolvedValue({ canceled: true, filePath: cancelledTarget });
      if (!(await readWorkspaceSnapshot())?.controls.export.displayed) await job.click();
      await clickDisplayedControl("export");
      await settle(1500);
      expect(await fileExists(cancelledTarget)).toBe(false);
      await save.mockResolvedValue({ canceled: false, filePath: target });
      if (!(await readWorkspaceSnapshot())?.controls.export.displayed) await job.click();
      await clickDisplayedControl("export");
      await browser.waitUntil(
        async () => (await readFile(target).catch(() => Buffer.alloc(0))).equals(PNG_BYTES),
        {
          timeout: 30000,
          interval: 200,
          timeoutMsg: "export must preserve the exact original PNG bytes",
        },
      );
    } finally {
      await browser.electron.restoreAllMocks();
    }
    trace("export-bytes-match", { target });
    expect(requests).toHaveLength(1);
    flow.completed.add("bi06-export");
  });

  it("BI05 a disconnect after dispatch settles as outcome unknown with a cost notice and is never retried", async function () {
    this.timeout(600000);
    requireStep("bi06-export");
    await openConfirmationFor(PROMPT_DISCONNECT);
    expect((await readConfirmDialog()).text).toContain(PROMPT_DISCONNECT);
    await confirmGeneration();
    await waitForRequestCount(
      DISCONNECT_AT_REQUEST,
      "the second confirmation should reach the loopback fixture exactly once",
    );
    await settle(1000);
    await revealJobs();
    const unknown = await waitForWorkspace(
      (snapshot) =>
        snapshot.jobs.some(
          (job) => job.status === "outcome_unknown" && job.text.includes(PROMPT_DISCONNECT),
        ),
      "a disconnect after dispatch must be shown as outcome unknown",
      60000,
    );
    // 结果未知必须提示费用可能已发生，不能显示成「已取消」或「未扣费」。
    expect(unknown.unknownCostNotice).toMatch(
      /可能.{0,20}(费用|计费|扣费)|(?:may|might|could).{0,40}(?:charg|cost|bill)/i,
    );
    expect(unknown.jobs.some((job) => job.status === "running")).toBe(false);
    await settle(3000);
    expect(requests).toHaveLength(DISCONNECT_AT_REQUEST);
    expect(await chatDefaultSelection()).toEqual(flow.chatSelection);
    await assertNoSession();
    await saveEvidence("bi05-outcome-unknown");
    flow.completed.add("bi05-outcome-unknown");
  });

  it("BI06 a cold restart restores both jobs read-only without another request", async function () {
    this.timeout(600000);
    requireStep("bi05-outcome-unknown");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await assertFixtureRoutingInAppProcess();
    const reopened = await openWorkspaceFromSidebar();
    expect(reopened.sandboxCount).toBe(0);
    expect(reopened.genImageViewCount).toBe(0);
    await revealJobs();
    const restored = await waitForWorkspace(
      (snapshot) =>
        snapshot.jobs.some((job) => job.status === "succeeded" && job.assetId === flow.assetId) &&
        snapshot.jobs.some(
          (job) => job.status === "outcome_unknown" && job.text.includes(PROMPT_DISCONNECT),
        ),
      "the succeeded job and the outcome-unknown job should both survive a cold restart",
      60000,
    );
    expect(restored.jobs.some((job) => job.status === "running")).toBe(false);
    await settle(2000);
    expect(requests).toHaveLength(DISCONNECT_AT_REQUEST);
    expect(await chatDefaultSelection()).toEqual(flow.chatSelection);
    await assertNoSession();
    await saveEvidence("bi06-cold-restart-restored");
    flow.completed.add("bi06-cold-restart");
  });

  it("BI08 with the legacy plugin installed the native workspace is still used and adds no second admission chain", async function () {
    this.timeout(600000);
    requireStep("bi06-cold-restart");
    await seedLegacyGenImagePlugin();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await assertFixtureRoutingInAppProcess();
    const native = await openWorkspaceFromSidebar();
    // 旧插件已启用：入口仍是原生工作台，不挂载它的 App 作用域沙箱视图。
    expect(native.sandboxCount).toBe(0);
    expect(native.genImageViewCount).toBe(0);
    await revealJobs();
    await waitForWorkspace(
      (snapshot) =>
        snapshot.jobs.some((job) => job.status === "succeeded" && job.assetId === flow.assetId),
      "the gallery should still be readable with the legacy plugin installed",
      60000,
    );
    await openConfirmationFor(PROMPT_LEGACY_PLUGIN);
    await confirmGeneration();
    await waitForRequestCount(
      DISCONNECT_AT_REQUEST + 1,
      "the native chain should send exactly one request with the legacy plugin installed",
    );
    await settle(1000);
    await revealJobs();
    await waitForWorkspace(
      (snapshot) =>
        snapshot.jobs.some(
          (job) => job.status === "succeeded" && job.text.includes(PROMPT_LEGACY_PLUGIN),
        ),
      "the generation with the legacy plugin installed should succeed through the native chain",
      60000,
    );
    await settle(1500);
    expect(requests).toHaveLength(DISCONNECT_AT_REQUEST + 1);
    expect((await readWorkspaceSnapshot())?.genImageViewCount ?? 0).toBe(0);
    expect(await chatDefaultSelection()).toEqual(flow.chatSelection);
    await assertNoSession();
    await saveEvidence("bi08-legacy-plugin-native");
    flow.completed.add("bi08-legacy-plugin");
  });
});
