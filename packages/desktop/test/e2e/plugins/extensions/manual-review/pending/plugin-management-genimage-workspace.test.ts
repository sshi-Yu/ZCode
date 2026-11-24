// PLM-GENIMAGE-WORKSPACE candidate: GI01 navigation and GI02 unconfigured state.
// This seeds the real market build as an inline plugin, not a marketplace-install UI test.
// A loopback fixture counts any attempted Images request; no paid provider is contacted.
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
import {
  evaluateInViewPage,
  waitForViewPage,
  waitForViewPane,
  writePluginDirsConfig,
} from "#e2e/helpers/extension-host-views";

const PLUGIN_ID = "genimage@inline";
const VIEW_ID = `${PLUGIN_ID}/workspace`;
const PLUGIN_SOURCE = resolve(
  process.env.ZCODE_E2E_GENIMAGE_PLUGIN_DIR?.trim() ||
    resolve(process.cwd(), "../../plugins/apps/genimage/dist/market/genimage"),
);

const FIXTURE_URL = "http://127.0.0.1:43971/v1/images/generations";
let fixture: Server | undefined;
let requests: Array<{ method: string; url: string; body: string }> = [];
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAI0lEQVR4AYXBAQEAMAiAME6394+kDWR7/BkOEiRIkCBBgoQFVvsCUyvaXNIAAAAASUVORK5CYII=";

async function startImagesFixture(): Promise<void> {
  if (process.env.ZCODE_E2E_GENIMAGE_ENDPOINT !== FIXTURE_URL || !process.env.ZCODE_E2E_RUN_ID) {
    throw new Error(`Set ZCODE_E2E_GENIMAGE_ENDPOINT=${FIXTURE_URL} before starting WDIO`);
  }
  fixture = createServer((request, response) => {
    const receivedAt = new Date().toISOString();
    process.stdout.write(
      `[genimage-e2e] fixture-request ${receivedAt} ${request.method ?? ""} ${request.url ?? ""} count=${requests.length + 1}\n`,
    );
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
      });
      if (requests.length === 2) {
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

async function chatDefaultSelection() {
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

async function activeTasks(): Promise<Array<string | null>> {
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

async function seedGenImage(): Promise<void> {
  const home = getE2EAppDataPaths().homeDir;
  if (
    !process.env.ZCODE_E2E_HOME_DIR ||
    resolve(home) !== resolve(process.cwd(), ".e2e-home-genimage")
  ) {
    throw new Error(
      "ZCODE_E2E_HOME_DIR must be the dedicated desktop .e2e-home-genimage directory",
    );
  }
  const manifest = JSON.parse(
    await readFile(join(PLUGIN_SOURCE, ".zcode-plugin", "plugin.json"), "utf8").catch(
      (error: unknown) => {
        throw new Error(
          "Missing GenImage app market artifact; build it or set ZCODE_E2E_GENIMAGE_PLUGIN_DIR",
          { cause: error },
        );
      },
    ),
  ) as { name?: string; version?: string };
  expect(manifest.name).toBe("genimage");
  expect(typeof manifest.version).toBe("string");
  const target = join(home, "fixtures", "genimage-workspace", "genimage");
  await mkdir(target, { recursive: true });
  await cp(PLUGIN_SOURCE, target, { recursive: true });
  await writePluginDirsConfig([target], [PLUGIN_ID]);
}

describe("PLM-GENIMAGE-WORKSPACE independent image workspace", () => {
  after(async () => {
    try {
      const events = await browser.execute(
        () => (window as typeof window & { __genimageTrace?: unknown[] }).__genimageTrace ?? [],
      );
      process.stdout.write(`[genimage-e2e] passive-trace ${JSON.stringify(events)}\n`);
    } catch {
      /* Renderer may already be gone; the test result remains authoritative. */
    }
    await clearAppData();
    if (fixture?.listening) {
      await new Promise<void>((resolveClose, reject) =>
        fixture!.close((error) => (error ? reject(error) : resolveClose())),
      );
    }
  });

  it("GI01–GI03 app navigation, safe confirmation, original export, and recovery", async function () {
    this.timeout(600000);
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await startImagesFixture();
    await seedGenImage();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () =>
        seedTurboAgentStartupModel("fixture-chat-provider", "fixture-chat-model"),
    });
    const chatSelection = await chatDefaultSelection();
    expect(chatSelection).toMatchObject({
      providerId: "fixture-chat-provider",
      modelId: "fixture-chat-model",
    });
    expect(await browser.electron.execute(() => process.env.ZCODE_E2E_GENIMAGE_ENDPOINT)).toBe(
      FIXTURE_URL,
    );
    // Inspect selection in the store before and after navigation, not the hidden chat pane.
    expect((await activeTasks()).every((id) => id === null)).toBe(true);
    const entry = $('[data-testid="genimage-sidebar-open"]');
    await entry.waitForDisplayed({ timeout: 60000 });
    await entry.click();
    const pane = await waitForViewPane(
      VIEW_ID,
      (view) => view.displayed && view.phase === "running",
      "GenImage app view should be running",
    );
    expect(pane.scope).toBe("app");
    expect(pane.instance).toBeTruthy();
    expect(pane.sandbox).toBeTruthy();
    expect((await activeTasks()).every((id) => id === null)).toBe(true);
    const appMode = await evaluateInViewPage<boolean>(
      pane.sandbox!,
      `Boolean(document.querySelector('[data-genimage-mode="app"]'))`,
    );
    expect(appMode).toBe(true);
    await waitForViewPage(
      VIEW_ID,
      (view) => /请前往 ZCode 设置|Configure OpenAI Images in ZCode Settings/i.test(view.text),
      "unconfigured GenImage should explain how to configure Images",
    );
    expect(
      await evaluateInViewPage<boolean>(
        pane.sandbox!,
        `(() => { const b = document.querySelector('[data-testid="genimage-new"]'); if (!b) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          pane.sandbox!,
          `document.querySelector('[data-testid="genimage-prompt"]') instanceof HTMLTextAreaElement`,
        )) === true,
      { timeout: 10000, timeoutMsg: "new generation prompt should appear" },
    );
    expect(
      await evaluateInViewPage<boolean>(
        pane.sandbox!,
        `(() => { const p = document.querySelector('[data-testid="genimage-prompt"]'); if (!(p instanceof HTMLTextAreaElement)) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(p, 'A blue square'); p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          pane.sandbox!,
          `(() => { const p = document.querySelector('[data-testid="genimage-prompt"]'); const b = document.querySelector('[data-testid="genimage-generate"]'); return p instanceof HTMLTextAreaElement && p.value === 'A blue square' && b instanceof HTMLButtonElement && b.disabled; })()`,
        )) === true,
      {
        timeout: 10000,
        timeoutMsg: "unconfigured generation should stay disabled for a nonempty prompt",
      },
    );
    expect(requests).toHaveLength(0);

    await $('[data-testid="genimage-open-model-settings"]').click();
    const key = $('[data-testid="genimage-api-key"]');
    await key.waitForEnabled({ timeout: 30000 });
    await key.setValue("e2e-image-fixture-key");
    await $('[data-testid="genimage-save-settings"]').click();
    await browser.waitUntil(async () => (await key.getValue()) === "", {
      timeout: 30000,
      timeoutMsg: "saving the test Images credential should clear the input",
    });
    await $(`[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`).click();
    const configuredPane = await waitForViewPane(
      VIEW_ID,
      (view) => view.displayed && view.phase === "running",
      "configured app view should run",
    );
    const sandbox = configuredPane.sandbox!;
    await waitForViewPage(
      VIEW_ID,
      (view) =>
        !/请前往 ZCode 设置|Configure OpenAI Images in ZCode Settings/i.test(view.text) &&
        /还没有成图|No images yet/i.test(view.text),
      "configured canvas should load",
    );
    expect(
      await evaluateInViewPage<boolean>(
        sandbox,
        `(() => { const b = document.querySelector('[data-testid="genimage-new"]'); if (!b) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          sandbox,
          `document.querySelector('[data-testid="genimage-prompt"]') instanceof HTMLTextAreaElement`,
        )) === true,
      { timeout: 10000 },
    );
    expect(
      await evaluateInViewPage<boolean>(
        sandbox,
        `(() => { const p = document.querySelector('[data-testid="genimage-prompt"]'); if (!(p instanceof HTMLTextAreaElement)) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(p, 'A blue square'); p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          sandbox,
          `(() => { const b = document.querySelector('[data-testid="genimage-generate"]'); return b instanceof HTMLButtonElement && !b.disabled; })()`,
        )) === true,
      { timeout: 10000, timeoutMsg: "configured generation should be enabled" },
    );
    const submit = async () =>
      expect(
        await evaluateInViewPage<boolean>(
          sandbox,
          `(() => { const b = document.querySelector('[data-testid="genimage-generate"]'); if (!(b instanceof HTMLButtonElement) || b.disabled) return false; b.click(); return true; })()`,
        ),
      ).toBe(true);
    await submit();
    const dialog = $('[data-confirm-intent="genimage-generate"]');
    await dialog.waitForDisplayed({ timeout: 30000 });
    expect(await dialog.getText()).toContain("gpt-image-1");
    expect(await dialog.getText()).toContain("A blue square");
    const focusIsCancel = await browser.execute((confirmId) => {
      const dialog = document.querySelector('[data-confirm-intent="genimage-generate"]');
      const focused = document.activeElement;
      return (
        focused instanceof HTMLButtonElement &&
        !!dialog?.contains(focused) &&
        focused.dataset.testid !== confirmId
      );
    }, TID_CONFIRM_DIALOG_CONFIRM);
    expect(focusIsCancel).toBe(true);
    await browser.keys(["Enter"]);
    await dialog.waitForDisplayed({ reverse: true, timeout: 10000 });
    expect(requests).toHaveLength(0);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          sandbox,
          `(() => { const b = document.querySelector('[data-testid="genimage-generate"]'); return b instanceof HTMLButtonElement && !b.disabled; })()`,
        )) === true,
      { timeout: 10000 },
    );
    await browser.execute(() => {
      const trace: unknown[] = [];
      (window as typeof window & { __genimageTrace?: unknown[] }).__genimageTrace = trace;
      const record = (event: Event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('[data-confirm-intent="genimage-generate"]')) return;
        if (event instanceof KeyboardEvent && !["Enter", "Escape"].includes(event.key)) return;
        trace.push({
          at: new Date().toISOString(),
          type: event.type,
          trusted: event.isTrusted,
          key: event instanceof KeyboardEvent ? event.key : null,
          testId: target.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        });
      };
      for (const type of ["click", "pointerdown", "focus", "keydown"])
        document.addEventListener(type, record, true);
      let previous = false;
      const check = () => {
        const visible = Boolean(
          document.querySelector('[data-confirm-intent="genimage-generate"]'),
        );
        if (visible !== previous) {
          previous = visible;
          trace.push({
            at: new Date().toISOString(),
            monotonicMs: performance.now(),
            dialog: visible ? "open" : "closed",
          });
        }
      };
      new MutationObserver(check).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      check();
    });
    const rendererUrl = await browser.getUrl();
    const windowId = await browser.electron.execute((electron, url) => {
      if (electron.app.getName() !== "ZCode E2E" || !process.env.ZCODE_E2E_RUN_ID) {
        throw new Error("Refusing to isolate a window outside the E2E app");
      }
      const matches = electron.BrowserWindow.getAllWindows().filter(
        (candidate) => !candidate.isDestroyed() && candidate.webContents.getURL() === url,
      );
      if (matches.length !== 1 || !matches[0]!.isVisible()) {
        throw new Error("Expected exactly one visible current E2E renderer window");
      }
      const window = matches[0]!;
      // 共享桌面曾在等待时收到可信点击；仅隔离本测试窗口的原生鼠标，保持页面可见以验证真实 SDK 取消。
      window.setIgnoreMouseEvents(true);
      return window.id;
    }, rendererUrl);
    try {
      await submit();
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Boolean(document.querySelector('[data-confirm-intent="genimage-generate"]')),
          ),
        {
          timeout: 30000,
          timeoutMsg: "confirmation should open during E2E pointer isolation",
        },
      );
      await browser.waitUntil(
        () =>
          browser.execute(
            () => !document.querySelector('[data-confirm-intent="genimage-generate"]'),
          ),
        {
          timeout: 80000,
          timeoutMsg: "tool timeout should cancel the pending host confirmation",
        },
      );
      const duration = await browser.execute(() => {
        const trace =
          (
            window as typeof window & {
              __genimageTrace?: Array<{
                dialog?: string;
                monotonicMs?: number;
              }>;
            }
          ).__genimageTrace ?? [];
        const open = trace.find((event) => event.dialog === "open")?.monotonicMs;
        const closed = trace.find((event) => event.dialog === "closed")?.monotonicMs;
        return open === undefined || closed === undefined ? null : closed - open;
      });
      expect(duration).not.toBeNull();
      expect(duration!).toBeGreaterThanOrEqual(59000);
      expect(requests).toHaveLength(0);
    } finally {
      await browser.electron.execute((electron, id) => {
        if (electron.app.getName() !== "ZCode E2E" || !process.env.ZCODE_E2E_RUN_ID) {
          throw new Error("Refusing to restore a window outside the E2E app");
        }
        const window = electron.BrowserWindow.fromId(id);
        if (!window || window.isDestroyed())
          throw new Error("Isolated E2E window no longer exists");
        window.setIgnoreMouseEvents(false);
      }, windowId);
    }
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          sandbox,
          `(() => { const b = document.querySelector('[data-testid="genimage-generate"]'); return b instanceof HTMLButtonElement && !b.disabled; })()`,
        )) === true,
      { timeout: 10000 },
    );
    process.stdout.write("[genimage-e2e] sdk-timeout-cancelled\n");
    await submit();
    await dialog.waitForDisplayed({ timeout: 30000 });
    await $(
      `[data-confirm-intent="genimage-generate"] [data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`,
    ).click();
    await browser.waitUntil(() => requests.length > 0, {
      timeout: 30000,
      timeoutMsg: "confirmation should send one Images fixture request",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    process.stdout.write("[genimage-e2e] first-request-received\n");
    expect(requests[0]?.url).toBe("/v1/images/generations");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      model: "gpt-image-1",
      prompt: "A blue square",
      n: 1,
    });
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          sandbox,
          `Boolean(document.querySelector('[data-job-status="succeeded"][data-asset-id]'))`,
        )) === true,
      {
        timeout: 60000,
        timeoutMsg: "fixture PNG should become a successful canvas asset",
      },
    );
    expect(requests).toHaveLength(1);
    expect(await chatDefaultSelection()).toEqual(chatSelection);
    const asset = await evaluateInViewPage<string>(
      sandbox,
      `document.querySelector('[data-job-status="succeeded"][data-asset-id]')?.getAttribute('data-asset-id') ?? ''`,
    );
    expect(asset).toBeTruthy();
    process.stdout.write("[genimage-e2e] asset-succeeded\n");
    const target = join(getE2EAppDataPaths().homeDir, "genimage-e2e-export.png");
    const save = await browser.electron.mock("dialog", "showSaveDialog");
    await save.mockResolvedValue({ canceled: false, filePath: target });
    const hit = await evaluateInViewPage<{
      panel: boolean;
      hitTag: string | null;
      hitClass: string | null;
    }>(
      sandbox,
      `(() => { const b = document.querySelector('[data-job-status="succeeded"][data-asset-id] button'); const r = b?.getBoundingClientRect(); const h = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null; return { panel: Boolean(document.querySelector('[data-testid="genimage-prompt"]')), hitTag: h?.tagName ?? null, hitClass: h?.getAttribute('class') ?? null }; })()`,
    );
    expect(hit?.panel).toBe(true);
    expect(
      await evaluateInViewPage<boolean>(
        sandbox,
        `(() => { const b = document.querySelector('[role="dialog"] .panel-head button'); if (!(b instanceof HTMLButtonElement)) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          sandbox,
          `!document.querySelector('[data-testid="genimage-prompt"]')`,
        )) === true,
      {
        timeout: 10000,
        timeoutMsg: "close button should close the create panel",
      },
    );
    // 非活动 iframe 的程序 focus 可更新 activeElement 却不派发 focusin；这里只补标准事件，不能作为原生焦点验收。
    const focused = await evaluateInViewPage<boolean>(
      sandbox,
      `(() => { const node = document.querySelector('[data-job-status="succeeded"][data-asset-id]'); if (!(node instanceof HTMLElement)) return false; node.focus(); if (document.activeElement !== node) return false; if (!document.hasFocus()) node.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); return true; })()`,
    );
    expect(focused).toBe(true);
    try {
      await browser.waitUntil(
        async () =>
          (await evaluateInViewPage<boolean>(
            sandbox,
            `Boolean(document.querySelector('[data-job-status="succeeded"][data-asset-id].selected'))`,
          )) === true,
        {
          timeout: 10000,
          timeoutMsg: "focused image should become selected before opening details",
        },
      );
    } catch (error) {
      const state = await evaluateInViewPage<unknown>(
        sandbox,
        `(() => { const node = document.querySelector('[data-job-status="succeeded"][data-asset-id]'); const active = document.activeElement; return { hasFocus: document.hasFocus(), nodeClass: node?.getAttribute('class') ?? null, jobId: node?.getAttribute('data-job-id') ?? null, assetId: node?.getAttribute('data-asset-id') ?? null, activeTag: active?.tagName ?? null, activeClass: active?.getAttribute('class') ?? null, activeIsNode: active === node, connected: node?.isConnected ?? false }; })()`,
      );
      throw new Error(`Image selection evidence: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
    expect(
      await evaluateInViewPage<boolean>(
        sandbox,
        `(() => { const node = document.querySelector('[data-job-status="succeeded"][data-asset-id]'); if (!(node instanceof HTMLElement) || document.activeElement !== node) return false; node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`,
      ),
    ).toBe(true);
    try {
      await browser.waitUntil(
        async () =>
          (await evaluateInViewPage<boolean>(
            sandbox,
            `document.querySelector('[data-testid="genimage-export"]') instanceof HTMLButtonElement`,
          )) === true,
        {
          timeout: 10000,
          timeoutMsg: "selected image inspector should expose export",
        },
      );
    } catch (error) {
      const state = await evaluateInViewPage<unknown>(
        sandbox,
        `(() => { const node = document.querySelector('[data-job-status="succeeded"][data-asset-id]'); const active = document.activeElement; const panel = document.querySelector('[role="dialog"]'); return { nodeClass: node?.getAttribute('class') ?? null, assetId: node?.getAttribute('data-asset-id') ?? null, activeTag: active?.tagName ?? null, activeClass: active?.getAttribute('class') ?? null, panelText: panel?.textContent ?? null, hasExport: Boolean(document.querySelector('[data-testid="genimage-export"]')), frame: location.protocol }; })()`,
      );
      throw new Error(`Image inspector evidence: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
    expect(
      await evaluateInViewPage<boolean>(
        sandbox,
        `(() => { const b = document.querySelector('[data-testid="genimage-export"]'); if (!(b instanceof HTMLButtonElement) || b.disabled) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await readFile(target).catch(() => Buffer.alloc(0))).equals(
          Buffer.from(PNG_BASE64, "base64"),
        ),
      {
        timeout: 30000,
        timeoutMsg: "export must preserve exact original PNG bytes",
      },
    );
    process.stdout.write("[genimage-e2e] export-bytes-match\n");
    await browser.electron.restoreAllMocks();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    const restartEntry = $('[data-testid="genimage-sidebar-open"]');
    await restartEntry.waitForDisplayed({ timeout: 60000 });
    await restartEntry.click();
    const restored = await waitForViewPane(
      VIEW_ID,
      (view) => view.displayed && view.phase === "running",
      "canvas should reopen after restart",
    );
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          restored.sandbox!,
          `Boolean(document.querySelector('[data-job-status="succeeded"][data-asset-id="${asset}"]'))`,
        )) === true,
      { timeout: 60000, timeoutMsg: "successful image must survive restart" },
    );
    expect(requests).toHaveLength(1);
    expect(await chatDefaultSelection()).toEqual(chatSelection);
    process.stdout.write("[genimage-e2e] first-restart-restored\n");
    const restoredSandbox = restored.sandbox!;
    expect(
      await evaluateInViewPage<boolean>(
        restoredSandbox,
        `(() => { const b = document.querySelector('[data-testid="genimage-new"]'); if (!(b instanceof HTMLButtonElement)) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          restoredSandbox,
          `document.querySelector('[data-testid="genimage-prompt"]') instanceof HTMLTextAreaElement`,
        )) === true,
      { timeout: 10000 },
    );
    expect(
      await evaluateInViewPage<boolean>(
        restoredSandbox,
        `(() => { const p = document.querySelector('[data-testid="genimage-prompt"]'); if (!(p instanceof HTMLTextAreaElement)) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(p, 'Disconnect after send'); p.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          restoredSandbox,
          `(() => { const b = document.querySelector('[data-testid="genimage-generate"]'); return b instanceof HTMLButtonElement && !b.disabled; })()`,
        )) === true,
      { timeout: 10000 },
    );
    expect(
      await evaluateInViewPage<boolean>(
        restoredSandbox,
        `(() => { const b = document.querySelector('[data-testid="genimage-generate"]'); if (!(b instanceof HTMLButtonElement) || b.disabled) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    // WebDriver 元素绑定原 session；重启后重新查询，不能复用旧确认框。
    const restoredDialog = $('[data-confirm-intent="genimage-generate"]');
    await restoredDialog.waitForDisplayed({ timeout: 30000 });
    await $(
      `[data-confirm-intent="genimage-generate"] [data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`,
    ).click();
    await browser.waitUntil(() => requests.length === 2, { timeout: 30000 });
    expect(JSON.parse(requests[1]!.body)).toMatchObject({
      model: "gpt-image-1",
      prompt: "Disconnect after send",
      n: 1,
    });
    expect(
      await evaluateInViewPage<boolean>(
        restoredSandbox,
        `(() => { const b = document.querySelector('[data-testid="genimage-history"]'); if (!(b instanceof HTMLButtonElement)) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          restoredSandbox,
          `Array.from(document.querySelectorAll('[data-job-status="outcome_unknown"]')).some(e => e.textContent.includes('Disconnect after send'))`,
        )) === true,
      {
        timeout: 60000,
        timeoutMsg: "disconnect after dispatch must show outcome unknown",
      },
    );
    process.stdout.write("[genimage-e2e] outcome-unknown-visible\n");
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    const secondRestartEntry = $('[data-testid="genimage-sidebar-open"]');
    await secondRestartEntry.waitForDisplayed({ timeout: 60000 });
    await secondRestartEntry.click();
    const again = await waitForViewPane(
      VIEW_ID,
      (view) => view.displayed && view.phase === "running",
      "canvas should reopen after unknown outcome",
    );
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          again.sandbox!,
          `Boolean(document.querySelector('[data-job-status="succeeded"][data-asset-id="${asset}"]'))`,
        )) === true,
      { timeout: 60000 },
    );
    expect(
      await evaluateInViewPage<boolean>(
        again.sandbox!,
        `(() => { const b = document.querySelector('[data-testid="genimage-history"]'); if (!(b instanceof HTMLButtonElement)) return false; b.click(); return true; })()`,
      ),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        (await evaluateInViewPage<boolean>(
          again.sandbox!,
          `Array.from(document.querySelectorAll('[data-job-status="outcome_unknown"]')).some(e => e.textContent.includes('Disconnect after send'))`,
        )) === true,
      { timeout: 60000 },
    );
    expect(requests).toHaveLength(2);
    expect(await chatDefaultSelection()).toEqual(chatSelection);
    process.stdout.write("[genimage-e2e] second-restart-no-replay\n");
  });
});
