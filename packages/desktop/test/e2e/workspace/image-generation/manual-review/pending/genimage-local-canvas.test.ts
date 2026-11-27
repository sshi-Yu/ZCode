import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Key } from "webdriverio";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";

type ElectronMock = Awaited<ReturnType<typeof browser.electron.mock>>;

const workspace = '[data-testid="genimage-workspace"]';
const entry = '[data-testid="genimage-sidebar-open"]';
const localMode = '[data-testid="genimage-local-mode"]';
const node = (id: string) => `${workspace} [data-genimage-node="${id}"]`;

interface NodePosition {
  version: number;
  x: number;
  y: number;
}

async function readNodeIds(): Promise<string[]> {
  return browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
        (element) => element.dataset.genimageNode ?? "",
      ),
    `${workspace} [data-genimage-node]`,
  ) as unknown as Promise<string[]>;
}

async function waitForNodeCount(count: number, timeout = 30_000): Promise<void> {
  await browser.waitUntil(async () => (await readNodeIds()).length === count, {
    timeout,
    timeoutMsg: `GenImage 本机画布节点数没有达到 ${count}`,
  });
}

async function waitForNewNode(previous: readonly string[]): Promise<string> {
  let id = "";
  let generateError = "";
  await browser.waitUntil(
    async () => {
      const current = await readNodeIds();
      id = current.find((candidate) => !previous.includes(candidate)) ?? "";
      if (id) return true;
      generateError =
        (await browser.execute(() => {
          const panel = document.querySelector<HTMLElement>('[data-testid="genimage-panel"]');
          return panel?.querySelector<HTMLElement>('[role="alert"]')?.textContent?.trim() ?? "";
        })) ?? "";
      return Boolean(generateError);
    },
    { timeout: 30_000, timeoutMsg: "提交后没有出现新的 GenImage 节点，也没有生成错误提示" },
  );
  if (generateError) throw new Error(`GenImage 生成失败: ${generateError}`);
  return id;
}

async function waitForMode(mode: "fixture" | "local"): Promise<void> {
  await browser.waitUntil(
    async () => (await $(workspace).getAttribute("data-genimage-mode")) === mode,
    { timeout: 30_000, timeoutMsg: `GenImage 没有进入 ${mode} 模式` },
  );
}

async function openGenImage(): Promise<void> {
  await $(entry).waitForClickable({ timeout: 30_000 });
  await $(entry).click();
  await $(workspace).waitForDisplayed({ timeout: 30_000 });
}

async function enterLocalSimulation(expectedCount?: number): Promise<void> {
  await $(localMode).waitForClickable({ timeout: 30_000 });
  await $(localMode).click();
  await waitForMode("local");
  if (expectedCount === undefined) {
    await $('[data-testid="genimage-empty"]').waitForDisplayed({ timeout: 30_000 });
  } else {
    await waitForNodeCount(expectedCount);
  }
}

async function focusNode(id: string): Promise<void> {
  // 完成的节点不会自动抢焦点；派生和详情前显式聚焦目标节点。
  await browser.execute((nodeId) => {
    const element = document.querySelector<HTMLElement>(`[data-genimage-node="${nodeId}"]`);
    if (!element) throw new Error(`GenImage 节点不存在: ${nodeId}`);
    element.focus({ preventScroll: true });
  }, id);
  await browser.waitUntil(
    async () => (await $(node(id)).getAttribute("data-selected")) === "true",
    { timeout: 10_000, timeoutMsg: `GenImage 节点没有被选中: ${id}` },
  );
}

async function clickNodeAction(id: string, testId: string): Promise<void> {
  await browser.execute(
    (nodeId, actionTestId) => {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-genimage-node="${nodeId}"] [data-testid="${actionTestId}"]`,
      );
      if (!button) throw new Error(`GenImage 节点动作不存在: ${actionTestId}`);
      if (button.disabled) throw new Error(`GenImage 节点动作不可用: ${actionTestId}`);
      button.click();
    },
    id,
    testId,
  );
}

async function generate(prompt: string, sourceId?: string): Promise<string> {
  const before = await readNodeIds();
  if (sourceId) {
    await focusNode(sourceId);
    const derive = $(`${node(sourceId)} [data-testid="genimage-derive"]`);
    await derive.waitForEnabled({ timeout: 10_000 });
    await clickNodeAction(sourceId, "genimage-derive");
  } else {
    await $('[data-testid="genimage-new"]').click();
  }
  const promptInput = $('[data-testid="genimage-prompt"]');
  await promptInput.waitForDisplayed({ timeout: 10_000 });
  await promptInput.setValue(prompt);
  const submit = $('[data-testid="genimage-submit"]');
  await submit.waitForEnabled({ timeout: 10_000 });
  await submit.click();
  const id = await waitForNewNode(before);
  await $(node(id)).waitForDisplayed({ timeout: 10_000 });
  return id;
}

async function readNodePosition(id: string): Promise<NodePosition> {
  const element = $(node(id));
  const x = await element.getAttribute("data-genimage-x");
  const y = await element.getAttribute("data-genimage-y");
  const version = await element.getAttribute("data-genimage-version");
  if (x === null || y === null) throw new Error(`GenImage 节点缺少坐标: ${id}`);
  return { version: Number(version ?? "0"), x: Number(x), y: Number(y) };
}

async function nudgeRightAndWaitPersisted(id: string): Promise<NodePosition> {
  const before = await readNodePosition(id);
  await focusNode(id);
  await browser
    .action("key")
    .down(Key.Shift)
    .down(Key.ArrowRight)
    .up(Key.ArrowRight)
    .up(Key.Shift)
    .perform();
  await browser.waitUntil(
    async () => {
      const current = await readNodePosition(id);
      return current.x > before.x && current.version > before.version;
    },
    { timeout: 15_000, timeoutMsg: "键盘微移没有提交新的节点坐标和版本" },
  );
  return readNodePosition(id);
}

async function closePanelIfOpen(): Promise<void> {
  if (await $('[data-testid="genimage-panel"]').isExisting()) {
    await browser.keys("Escape");
    await $('[data-testid="genimage-panel"]').waitForExist({
      reverse: true,
      timeout: 10_000,
    });
  }
}

async function closeOriginalDialog(): Promise<void> {
  if (await $('[data-testid="genimage-original-dialog"]').isExisting()) {
    await browser.keys("Escape");
    await $('[data-testid="genimage-original-dialog"]').waitForExist({
      reverse: true,
      timeout: 10_000,
    });
  }
}

async function locateFromHistory(id: string): Promise<void> {
  await closeOriginalDialog();
  await closePanelIfOpen();
  await $('[data-testid="genimage-history"]').click();
  const row = $(`[data-genimage-history="${id}"]`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.click();
  await browser.waitUntil(
    async () => (await $(node(id)).getAttribute("data-selected")) === "true",
    { timeout: 10_000, timeoutMsg: `历史记录没有定位到节点 ${id}` },
  );
}

async function openOriginalPreview(id: string): Promise<string> {
  await closeOriginalDialog();
  await closePanelIfOpen();
  await focusNode(id);
  await clickNodeAction(id, "genimage-details");
  await $('[data-testid="genimage-panel"]').waitForDisplayed({ timeout: 10_000 });
  await $('[data-testid="genimage-preview"]').click();
  await $('[data-testid="genimage-original-dialog"]').waitForDisplayed({ timeout: 10_000 });
  await browser.waitUntil(
    async () =>
      (
        (await browser.execute(
          () =>
            document
              .querySelector<HTMLImageElement>('[data-testid="genimage-original"]')
              ?.getAttribute("src") ?? "",
        )) as string
      ).startsWith("zcode-media://local/preview?path="),
    { timeout: 30_000, timeoutMsg: "原图预览没有加载 Host 授权的本机图片" },
  );
  return browser.execute(
    () =>
      document
        .querySelector<HTMLImageElement>('[data-testid="genimage-original"]')
        ?.getAttribute("src") ?? "",
  ) as unknown as Promise<string>;
}

async function waitForFileHead(path: string, head: number[], timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        if ((await stat(path)).size < head.length) return false;
        const bytes = await readFile(path);
        return head.every((value, index) => bytes[index] === value);
      } catch {
        return false;
      }
    },
    { timeout: 20_000, timeoutMsg },
  );
}

describe("GENIMAGE-LOCAL persistent local canvas", () => {
  let tempDir = "";
  let saveDialog: ElectronMock;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-e2e-genimage-local-"));
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("生成 A → B/C → D，恢复坐标、历史和重启，并预览导出原图", async function () {
    this.timeout(300_000);

    // 本机模拟不依赖云凭据；测试启动前凭据库必须保持匿名。
    const credentials = JSON.parse(
      await readFile(getE2EAppDataPaths().credentialsFile, "utf8").catch(() => "{}"),
    ) as Record<string, unknown>;
    expect(
      Object.keys(credentials).filter(
        (key) => key.startsWith("oauth:") || key === "auth_token" || key === "zcodejwttoken",
      ),
    ).toEqual([]);

    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await openGenImage();
    await enterLocalSimulation();
    expect(await readNodeIds()).toEqual([]);

    const rootId = await generate("GENIMAGE local root");
    expect((await $(node(rootId)).getAttribute("data-source")) ?? "").toBe("");
    expect(await $$(`${workspace} [data-genimage-node]`).length).toBe(1);

    const childB = await generate("GENIMAGE local child B", rootId);
    const childC = await generate("GENIMAGE local child C", rootId);
    const childD = await generate("GENIMAGE local grandchild D", childB);
    expect(await $(node(childB)).getAttribute("data-source")).toBe(rootId);
    expect(await $(node(childC)).getAttribute("data-source")).toBe(rootId);
    expect(await $(node(childD)).getAttribute("data-source")).toBe(childB);
    expect(await readNodeIds()).toHaveLength(4);

    // 历史行使用服务端 UUID；点击后关闭历史并选中目标节点。
    await locateFromHistory(childD);
    expect(await $(node(childD)).getAttribute("data-selected")).toBe("true");

    // 坐标持久化：键盘微移提交坐标与版本，离开重进后必须保持。
    await closePanelIfOpen();
    const movedPosition = await nudgeRightAndWaitPersisted(childB);

    await $('[data-testid="desktop-top-nav-back"]').click();
    await $(workspace).waitForExist({ reverse: true, timeout: 10_000 });
    await openGenImage();
    await enterLocalSimulation(4);
    expect(await readNodeIds()).toHaveLength(4);
    expect(await readNodePosition(childB)).toEqual(movedPosition);

    // 完整重启后从同一 scope 恢复节点、谱系、坐标和历史。
    await reloadElectronSessionPreservingBrowserProfile(browser);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);
    await $(entry).waitForClickable({ timeout: 60_000 });
    await openGenImage();
    await enterLocalSimulation(4);
    expect(await readNodeIds()).toHaveLength(4);
    expect(await $(node(childB)).getAttribute("data-source")).toBe(rootId);
    expect(await $(node(childD)).getAttribute("data-source")).toBe(childB);
    expect(await readNodePosition(childB)).toEqual(movedPosition);
    await locateFromHistory(childC);
    expect(await $(node(childC)).getAttribute("data-selected")).toBe("true");

    // 原图预览与导出：预览指向 Host 授权的本机原图，导出字节必须与预览原图一致。
    const previewSrc = await openOriginalPreview(childD);
    const previewUrl = new URL(previewSrc);
    expect(previewUrl.protocol).toBe("zcode-media:");
    const originalPath = previewUrl.searchParams.get("path");
    expect(originalPath).toBeTruthy();
    const originalBytes = await readFile(originalPath!);
    await closeOriginalDialog();

    saveDialog = await browser.electron.mock("dialog", "showSaveDialog");
    const exportPath = join(tempDir, "genimage-export.png");
    await saveDialog.mockResolvedValueOnce({ canceled: false, filePath: exportPath });
    const exportButton = $('[data-testid="genimage-export"]');
    await exportButton.waitForEnabled({ timeout: 30_000 });
    await exportButton.click();
    await waitForFileHead(exportPath, [0x89, 0x50, 0x4e, 0x47], "GenImage 导出没有写出 PNG 文件");
    await browser.waitUntil(async () => (await stat(exportPath)).size === originalBytes.length, {
      timeout: 20_000,
      timeoutMsg: "GenImage 导出文件没有写完整",
    });
    expect((await readFile(exportPath)).equals(originalBytes)).toBe(true);
  });
});
