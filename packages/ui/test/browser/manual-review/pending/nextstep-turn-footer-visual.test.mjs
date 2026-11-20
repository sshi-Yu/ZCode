// NST-VIS：NextStep 轮尾视觉合同浏览器受控验收（2026-11-20 视觉更新）。
// 真实 TurnFooterSlot + useTurnFooterSlot，经 ServiceProvider 注入受控 IExtensionsService：
// 证明迟发初读、刷新立即等待、迟到失效/旧读竞态、旧缓存五条渲染四条（ID 不变）、
// 200ms/30ms 入场与 prefers-reduced-motion、窄屏深色英文与纵向布局、重挂载只读。
// 不 mock 模块、不发网络；桌面全链路（真实插件/锚点/模型计数）仍由 packages/desktop
// pending E2E 承担，两份证据互补、不互相替代。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/nextstep-turn-footer-visual.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/nextstep-turn-footer-visual");
let server, browser, origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "nst-visual-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const CHANGE_ANCHOR = {
  workspaceKey: "/fixture-ws",
  sessionId: "sess_fixture",
  productTurnId: "turn_fixture",
  assistantMessageId: "msg_fixture",
};

// 存储顺序刻意乱序：码点长度 复核输入=4、😀审查=3（UTF-16 单位 4）、深化=2。
// 按码点排序应为 深化、😀审查、复核输入；按 UTF-16 单位排序会因 4=4 平局保留存储顺序而失败。
const V1_ITEMS = [
  {
    id: "vis-review",
    dimension: "review",
    label: "复核输入",
    prompt: "重新核对这轮输入与边界条件。",
  },
  { id: "vis-astral", dimension: "test", label: "😀审查", prompt: "带着表情符号审查关键路径。" },
  { id: "vis-deepen", dimension: "deepen", label: "深化", prompt: "把结论再推深一层。" },
];
const V1_EXPECTED = ["深化", "😀审查", "复核输入"];

// 旧版缓存形状：五条已持久化建议（传输 schema 允许 2–5）。
// 码点：验证这轮改动是否可靠=10（截断丢弃）、复核输入=4、补充测试=4（平局保持存储顺序）、😀审查=3、深化=2。
const LEGACY_ITEMS = [
  {
    id: "legacy-long",
    dimension: "verify",
    label: "验证这轮改动是否可靠",
    prompt: "旧缓存最长项应被截断。",
  },
  { id: "legacy-a", dimension: "review", label: "复核输入", prompt: "旧缓存 A。" },
  { id: "legacy-b", dimension: "mystery-unknown", label: "补充测试", prompt: "旧缓存 B。" },
  { id: "legacy-c", dimension: "test", label: "😀审查", prompt: "旧缓存 C。" },
  { id: "legacy-d", dimension: "deepen", label: "深化", prompt: "旧缓存 D。" },
];
const LEGACY_EXPECTED = ["深化", "😀审查", "复核输入", "补充测试"];
const LEGACY_EXPECTED_IDS = ["legacy-d", "legacy-c", "legacy-a", "legacy-b"];

const V2_ITEMS = [
  { id: "v2-deepen", dimension: "deepen", label: "继续深化方案", prompt: "第二版深化项。" },
  { id: "v2-followup", dimension: "followup", label: "追问细节", prompt: "第二版追问项。" },
];
const V2_EXPECTED = ["追问细节", "继续深化方案"];

const ready = (version, revision, items) => ({
  kind: "view",
  result: { version, revision, status: "ready", items },
});
const change = (version, revision) => ({ anchor: CHANGE_ANCHOR, version, revision });

async function openFixture(options = {}) {
  const {
    width = 1200,
    height = 900,
    locale = "zh-CN",
    theme = "light",
    reducedMotion = "no-preference",
  } = options;
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion });
  // 冷启动首屏的模块图转换可能远超默认 load 超时；DOM 就绪后由选择器等待接管。
  await page.goto(`${origin}fixture?locale=${locale}&theme=${theme}`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  await page.locator('[data-testid="turn-footer"]').waitFor();
  return { page, errors };
}

const releaseRead = (page, index, response) =>
  page.evaluate(({ index, response }) => window.__nstFixture.releaseRead(index, response), {
    index,
    response,
  });
const rejectRead = (page, index) =>
  page.evaluate((index) => window.__nstFixture.rejectRead(index), index);
const releaseRefresh = (page, index, response) =>
  page.evaluate(({ index, response }) => window.__nstFixture.releaseRefresh(index, response), {
    index,
    response,
  });
const emit = (page, value) => page.evaluate((value) => window.__nstFixture.emit(value), value);
const waitReads = (page, count) =>
  page.evaluate((count) => window.__nstFixture.waitReads(count), count);
const fixtureCalls = (page) => page.evaluate(() => window.__nstFixture.calls());
const heldCounts = (page) => page.evaluate(() => window.__nstFixture.heldCounts());
const remount = (page, value) =>
  page.evaluate((value) => window.__nstFixture.remount(value), value);

const labels = (page) =>
  page
    .locator('[data-testid="turn-footer-suggestion"]')
    .evaluateAll((rows) => rows.map((row) => (row.textContent ?? "").trim()));
const ids = (page) =>
  page
    .locator('[data-testid="turn-footer-suggestion"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-suggestion-id")));
const statusText = (page) => page.locator('[data-testid="turn-footer-status"]').innerText();
async function waitLabels(page, expected) {
  await page.waitForFunction((expected) => {
    const rows = Array.from(document.querySelectorAll('[data-testid="turn-footer-suggestion"]'));
    return (
      JSON.stringify(rows.map((row) => (row.textContent ?? "").trim())) === JSON.stringify(expected)
    );
  }, expected);
}

test("NST-VIS-a 迟发初读等待态与就绪排序（desktop/zh-CN/light）", async () => {
  const { page, errors } = await openFixture();
  try {
    // 初读被宿主挂起：等待态必须立即可见，而不是等首个响应回来才出现。
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="turn-footer"]')?.getAttribute("data-pending") ===
        "read",
    );
    assert.equal(await page.locator('[data-testid="turn-footer-loading"] > div').count(), 2);
    const status = page.locator('[data-testid="turn-footer-status"]');
    await status.waitFor();
    assert.equal(await status.getAttribute("role"), "status");
    assert.equal(await status.getAttribute("aria-live"), "polite");
    assert.equal((await statusText(page)).trim(), "正在读取推荐…");
    assert.equal(await page.locator('[data-testid="turn-footer-suggestion"]').count(), 0);
    assert.ok(await page.getByTestId("turn-footer-refresh").isDisabled());
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest"],
    );

    // 释放前安装入场动画采样器：200ms 窗口内按帧收集行动画计时。
    await page.evaluate(() => {
      window.__nstSamples = [];
      window.__nstStopSampler = false;
      const tick = () => {
        if (window.__nstStopSampler) return;
        for (const row of document.querySelectorAll('[data-testid="turn-footer-suggestion"]')) {
          const animation = row
            .getAnimations()
            .find((value) => value.animationName === "zcode-turn-footer-enter");
          if (animation) {
            const timing = animation.effect.getTiming();
            window.__nstSamples.push({
              label: (row.textContent ?? "").trim(),
              duration: timing.duration,
              delay: timing.delay,
              name: animation.animationName,
            });
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await releaseRead(page, 0, ready(1, 1, V1_ITEMS));
    await waitLabels(page, V1_EXPECTED);

    const footer = page.locator('[data-testid="turn-footer"]');
    assert.equal(await footer.getAttribute("data-version"), "1");
    assert.equal(await footer.getAttribute("data-pending"), null);
    assert.equal(await page.locator('[data-testid="turn-footer-loading"]').count(), 0);

    // 每行恰好一个维度图标；不同维度映射不同图标。
    const icons = await page.locator('[data-testid="turn-footer-suggestion"]').evaluateAll((rows) =>
      rows.map((row) => {
        const icon = row.querySelector('[data-testid="turn-footer-suggestion-icon"]');
        return {
          count: row.querySelectorAll('[data-testid="turn-footer-suggestion-icon"]').length,
          hidden: icon?.getAttribute("aria-hidden"),
          markup: icon?.outerHTML ?? null,
        };
      }),
    );
    assert.deepEqual(
      icons.map((icon) => icon.count),
      [1, 1, 1],
    );
    assert.deepEqual(
      icons.map((icon) => icon.hidden),
      ["true", "true", "true"],
    );
    assert.notEqual(icons[0].markup, icons[2].markup, "深化与复核输入应映射不同图标");

    // 可点击时 pointer；提示词沿用 Tooltip。
    assert.equal(
      await page
        .locator('[data-testid="turn-footer-suggestion"]')
        .first()
        .evaluate((row) => getComputedStyle(row).cursor),
      "pointer",
    );
    await page.locator('[data-testid="turn-footer-suggestion"]').first().hover();
    const tooltip = page.locator('[role="tooltip"]');
    await tooltip.waitFor({ state: "visible" });
    assert.match(await tooltip.innerText(), /把结论再推深一层。/);

    // 入场合同：每行 200ms 入场 + 30ms 错峰（内联自定义属性与计算样式同时核对）。
    const motion = await page
      .locator('[data-testid="turn-footer-suggestion"]')
      .evaluateAll((rows) =>
        rows.map((row) => {
          const style = getComputedStyle(row);
          return {
            duration: style.animationDuration,
            delay: style.animationDelay,
            name: style.animationName,
          };
        }),
      );
    for (const entry of motion) {
      assert.equal(entry.duration, "0.2s");
      assert.equal(entry.name, "zcode-turn-footer-enter");
    }
    assert.deepEqual(
      motion.map((entry) => Number.parseFloat(entry.delay)),
      [0, 0.03, 0.06],
    );
    await page.evaluate(() => {
      window.__nstStopSampler = true;
    });
    const samples = await page.evaluate(() => window.__nstSamples ?? []);
    assert.ok(samples.length >= 3, `应采样到入场动画，实际 ${JSON.stringify(samples.slice(0, 6))}`);
    for (const sample of samples) {
      assert.equal(sample.duration, 200);
      assert.equal(sample.name, "zcode-turn-footer-enter");
    }
    assert.deepEqual(
      [...new Set(samples.map((sample) => sample.delay))].sort((left, right) => left - right),
      [0, 30, 60],
    );

    // 键盘焦点始终可见：Tab 聚焦建议行后样式与未聚焦行可区分。
    let focused = false;
    for (let index = 0; index < 8 && !focused; index++) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(
        () => document.activeElement?.getAttribute("data-testid") === "turn-footer-suggestion",
      );
    }
    assert.ok(focused, "Tab 应能聚焦建议行");
    const focusSnapshot = await page.evaluate(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return {
        id: active.getAttribute("data-suggestion-id"),
        background: style.backgroundColor,
        border: style.borderColor,
      };
    });
    assert.equal(focusSnapshot.id, "vis-deepen");
    const unfocusedSnapshot = await page
      .locator('[data-testid="turn-footer-suggestion"]')
      .last()
      .evaluate((row) => {
        const style = getComputedStyle(row);
        return { background: style.backgroundColor, border: style.borderColor };
      });
    assert.ok(
      focusSnapshot.background !== unfocusedSnapshot.background ||
        focusSnapshot.border !== unfocusedSnapshot.border,
      "键盘焦点必须有可见样式差异",
    );
    await page.screenshot({ path: join(artifacts, "nst-vis-a-ready-zh-CN-light.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-b 旧缓存五条渲染四条且 ID/数据不变", async () => {
  const { page, errors } = await openFixture();
  try {
    await releaseRead(page, 0, ready(1, 3, LEGACY_ITEMS));
    await waitLabels(page, LEGACY_EXPECTED);
    assert.equal(await page.locator('[data-testid="turn-footer-suggestion"]').count(), 4);
    assert.deepEqual(await ids(page), LEGACY_EXPECTED_IDS);
    assert.equal(
      await page.locator('[data-testid="turn-footer"]').getAttribute("data-version"),
      "1",
    );
    assert.equal(await page.locator('[data-testid="turn-footer-loading"]').count(), 0);
    // 最长项被截断，不出现在 DOM。
    assert.ok((await labels(page)).every((label) => label !== "验证这轮改动是否可靠"));
    // 图标映射确定性：同映射维度图标一致，未知维度走探索兜底（与已映射维度不同）。
    const icons = await page
      .locator('[data-testid="turn-footer-suggestion"]')
      .evaluateAll((rows) =>
        rows.map(
          (row) =>
            row.querySelector('[data-testid="turn-footer-suggestion-icon"]')?.outerHTML ?? null,
        ),
      );
    assert.notEqual(icons[0], icons[1], "deepen 与 test 应映射不同图标");
    assert.equal(icons[1], icons[2], "test 与 review 同属校验映射，图标应一致");
    assert.notEqual(icons[3], icons[0], "未知维度应走探索兜底图标");
    assert.notEqual(icons[3], icons[1], "未知维度兜底不应撞上校验映射");

    // 同版本重读：ID 稳定、只读（无 refresh）。
    await emit(page, change(1, 4));
    await waitReads(page, 2);
    await releaseRead(page, 1, ready(1, 4, LEGACY_ITEMS));
    await waitLabels(page, LEGACY_EXPECTED);
    assert.deepEqual(await ids(page), LEGACY_EXPECTED_IDS);
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest", "readLatest"],
    );
    await page.screenshot({ path: join(artifacts, "nst-vis-b-legacy-five-zh-CN-light.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-c 刷新立即等待并区分持久 generating", async () => {
  const { page, errors } = await openFixture();
  try {
    await releaseRead(page, 0, ready(1, 1, V1_ITEMS));
    await waitLabels(page, V1_EXPECTED);
    // 在真实 click 事件时开始计时，排除 Playwright 等待元素稳定的时间。
    await page.evaluate(() => {
      window.__nstPendingSeenAt = null;
      window.__nstClickAt = null;
      const footer = document.querySelector('[data-testid="turn-footer"]');
      footer.querySelector('[data-testid="turn-footer-refresh"]').addEventListener(
        "click",
        () => {
          window.__nstClickAt = performance.now();
        },
        { once: true, capture: true },
      );
      new MutationObserver(() => {
        if (
          footer.getAttribute("data-pending") === "refresh" &&
          window.__nstPendingSeenAt === null
        ) {
          window.__nstPendingSeenAt = performance.now();
        }
      }).observe(footer, { attributes: true, attributeFilter: ["data-pending"] });
    });
    await page.getByTestId("turn-footer-refresh").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="turn-footer"]')?.getAttribute("data-pending") ===
        "refresh",
    );
    const { pendingSeenAt, clickStartedAt } = await page.evaluate(() => ({
      pendingSeenAt: window.__nstPendingSeenAt,
      clickStartedAt: window.__nstClickAt,
    }));
    assert.ok(
      pendingSeenAt !== null && clickStartedAt !== null && pendingSeenAt - clickStartedAt < 150,
      `pending=refresh 应立即出现，实测 ${pendingSeenAt === null || clickStartedAt === null ? "未观察到" : `${pendingSeenAt - clickStartedAt}ms`}`,
    );
    // 新版本受理后不把旧 ready 当作当前版：建议行消失并显示生成中状态。
    assert.equal(await page.locator('[data-testid="turn-footer-suggestion"]').count(), 0);
    assert.equal((await statusText(page)).trim(), "正在生成推荐…");
    assert.ok(await page.getByTestId("turn-footer-refresh").isDisabled());
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest", "refresh"],
    );
    // 受理回执返回持久 generating v2：等待期间禁用重复动作。
    await releaseRefresh(page, 0, {
      kind: "view",
      result: { version: 2, revision: 0, status: "generating" },
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="turn-footer"]')?.getAttribute("data-version") === "2",
    );
    assert.equal((await statusText(page)).trim(), "正在生成推荐…");
    assert.equal(await page.locator('[data-testid="turn-footer-loading"] > div').count(), 2);
    assert.ok(await page.getByTestId("turn-footer-refresh").isDisabled());
    // 结算失效 → 重读 → v2 ready。
    await emit(page, change(2, 1));
    await waitReads(page, 2);
    await releaseRead(page, 1, ready(2, 1, V2_ITEMS));
    await waitLabels(page, V2_EXPECTED);
    assert.equal(
      await page.locator('[data-testid="turn-footer"]').getAttribute("data-version"),
      "2",
    );
    assert.equal(
      await page.locator('[data-testid="turn-footer"]').getAttribute("data-pending"),
      null,
    );
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest", "refresh", "readLatest"],
    );
    await page.screenshot({ path: join(artifacts, "nst-vis-c-refreshed-v2-zh-CN-light.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-d 迟到失效与旧读不覆盖新读", async () => {
  const { page, errors } = await openFixture();
  try {
    // 读 1 挂起时收到 v2 失效通知 → 必须再发起读 2；读 2 先回 v2。
    await emit(page, change(2, 1));
    await waitReads(page, 2);
    await releaseRead(page, 1, ready(2, 1, V2_ITEMS));
    await waitLabels(page, V2_EXPECTED);
    // 迟到的读 1 返回 v1：持久版本水位不得让旧读覆盖新读。
    await releaseRead(page, 0, ready(1, 9, V1_ITEMS));
    await page.waitForTimeout(250);
    assert.deepEqual(await labels(page), V2_EXPECTED);
    // 更旧的失效通知被忽略：不发起第三次读。
    await emit(page, change(1, 99));
    await page.waitForTimeout(150);
    assert.equal((await heldCounts(page)).reads, 2);
    assert.deepEqual(await labels(page), V2_EXPECTED);
    // null 通知触发后台重读，保留现有 DOM，禁用动作；同版本返回不得重播入场。
    await page
      .locator('[data-testid="turn-footer-suggestion"]')
      .first()
      .evaluate((element) => {
        window.__nstOriginalRow = element;
        window.__nstAnimationStarts = 0;
        element.addEventListener("animationstart", () => window.__nstAnimationStarts++);
      });
    await emit(page, null);
    await waitReads(page, 3);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="turn-footer"]')?.getAttribute("data-pending") ===
        "read",
    );
    assert.deepEqual(await labels(page), V2_EXPECTED);
    assert.ok(await page.locator('[data-testid="turn-footer-suggestion"]').first().isDisabled());
    await releaseRead(page, 2, ready(2, 1, V2_ITEMS));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="turn-footer"]')?.hasAttribute("data-pending"),
    );
    assert.equal(
      await page
        .locator('[data-testid="turn-footer-suggestion"]')
        .first()
        .evaluate((element) => element === window.__nstOriginalRow),
      true,
    );
    assert.equal(await page.evaluate(() => window.__nstAnimationStarts), 0);
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest", "readLatest", "readLatest"],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-e unavailable 隐藏整个区域", async () => {
  const { page, errors } = await openFixture();
  try {
    await releaseRead(page, 0, { kind: "unavailable" });
    await page.waitForFunction(() => !document.querySelector('[data-testid="turn-footer"]'));
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest"],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-h 已知 generating 期间读取失败可读可重试且重试只读", async () => {
  const { page, errors } = await openFixture();
  try {
    // 初读返回持久 generating：等待生成，重复动作被禁用。
    await releaseRead(page, 0, {
      kind: "view",
      result: { version: 1, revision: 0, status: "generating" },
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="turn-footer"]')?.getAttribute("data-version") === "1",
    );
    assert.equal((await statusText(page)).trim(), "正在生成推荐…");
    assert.ok(await page.getByTestId("turn-footer-refresh").isDisabled());
    // 结算通知触发的重读失败：错误必须可读、不再被 busy 困住，重试入口可用。
    await emit(page, change(1, 1));
    await waitReads(page, 2);
    await rejectRead(page, 1);
    await page.waitForFunction(() =>
      (document.querySelector('[data-testid="turn-footer-status"]')?.textContent ?? "").includes(
        "推荐读取失败",
      ),
    );
    assert.equal(
      await page.locator('[data-testid="turn-footer"]').getAttribute("data-pending"),
      null,
    );
    assert.equal(await page.locator('[data-testid="turn-footer-suggestion"]').count(), 0);
    const retry = page.getByTestId("turn-footer-refresh");
    assert.ok(!(await retry.isDisabled()), "读取失败后重试入口必须可用");
    assert.equal(await retry.getAttribute("aria-label"), "重新读取推荐");
    // 重试只发起 readLatest，不产生 refresh。
    await retry.click();
    await waitReads(page, 3);
    await releaseRead(page, 2, ready(1, 1, V1_ITEMS));
    await waitLabels(page, V1_EXPECTED);
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest", "readLatest", "readLatest"],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-i 失效读失败后迟到刷新回执不可恢复旧操作", async () => {
  const { page, errors } = await openFixture();
  try {
    await releaseRead(page, 0, ready(1, 1, V1_ITEMS));
    await waitLabels(page, V1_EXPECTED);
    await page.getByTestId("turn-footer-refresh").click();
    // 两次失效读均失败，迟到的 v2 generating 回执不能压过较新的读取序列。
    await emit(page, change(2, 0));
    await waitReads(page, 2);
    await rejectRead(page, 1);
    await emit(page, change(2, 1));
    await waitReads(page, 3);
    await rejectRead(page, 2);
    await releaseRefresh(page, 0, {
      kind: "view",
      result: { version: 2, revision: 0, status: "generating" },
    });
    await page.waitForFunction(() => {
      const footer = document.querySelector('[data-testid="turn-footer"]');
      return (
        !footer?.hasAttribute("data-pending") &&
        (document.querySelector('[data-testid="turn-footer-status"]')?.textContent ?? "").includes(
          "推荐读取失败",
        )
      );
    });
    assert.equal(
      await page.locator('[data-testid="turn-footer"]').getAttribute("data-version"),
      "1",
    );
    assert.deepEqual(await labels(page), V1_EXPECTED);
    for (const button of await page.locator('[data-testid="turn-footer-suggestion"]').all()) {
      assert.ok(await button.isDisabled());
    }
    const retry = page.getByTestId("turn-footer-refresh");
    assert.ok(!(await retry.isDisabled()));
    assert.equal(await retry.getAttribute("aria-label"), "重新读取推荐");
    assert.equal((await fixtureCalls(page)).filter((call) => call.kind === "refresh").length, 1);
    assert.equal((await fixtureCalls(page)).filter((call) => call.kind === "submit").length, 0);
    await retry.click();
    await waitReads(page, 4);
    await releaseRead(page, 3, ready(2, 1, V2_ITEMS));
    await waitLabels(page, V2_EXPECTED);
    assert.equal(
      await page.locator('[data-testid="turn-footer"]').getAttribute("data-version"),
      "2",
    );
    assert.equal((await fixtureCalls(page)).filter((call) => call.kind === "refresh").length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-f prefers-reduced-motion 关闭位移/错峰/旋转但保留文字", async () => {
  const { page, errors } = await openFixture({ reducedMotion: "reduce" });
  try {
    assert.equal((await statusText(page)).trim(), "正在读取推荐…");
    assert.equal(
      await page.evaluate(() => document.getAnimations().length),
      0,
      "reduced-motion 下不应有旋转或入场动画运行",
    );
    await releaseRead(page, 0, ready(1, 1, LEGACY_ITEMS));
    await waitLabels(page, LEGACY_EXPECTED);
    const motion = await page
      .locator('[data-testid="turn-footer-suggestion"]')
      .evaluateAll((rows) =>
        rows.map((row) => {
          const style = getComputedStyle(row);
          return { name: style.animationName, duration: style.animationDuration };
        }),
      );
    for (const entry of motion) {
      assert.equal(entry.name, "none");
      assert.equal(entry.duration, "0s");
    }
    assert.equal(
      await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation.animationName === "zcode-turn-footer-enter").length,
      ),
      0,
    );
    await page.screenshot({ path: join(artifacts, "nst-vis-f-reduced-motion-zh-CN-light.png") });
    // 切回 no-preference：CSS 合同恢复（行上仍带入场动画规则）。
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-testid="turn-footer-suggestion"]'))
          .animationName === "zcode-turn-footer-enter",
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("NST-VIS-g 窄屏深色英文纵向布局与重挂载只读", async () => {
  const { page, errors } = await openFixture({
    width: 390,
    height: 800,
    locale: "en-US",
    theme: "dark",
  });
  try {
    assert.equal((await statusText(page)).trim(), "Loading suggestions…");
    await releaseRead(page, 0, ready(1, 2, LEGACY_ITEMS));
    await waitLabels(page, LEGACY_EXPECTED);
    const layout = await page
      .locator('[data-testid="turn-footer-suggestion"]')
      .evaluateAll((rows) => {
        const rects = rows.map((row) => row.getBoundingClientRect());
        const footerWidth = document
          .querySelector('[data-testid="turn-footer"]')
          .getBoundingClientRect().width;
        return {
          lefts: rects.map((rect) => rect.left),
          stacked: rects.every(
            (rect, index) => index === 0 || rect.top >= rects[index - 1].bottom - 1,
          ),
          footerWidth,
          horizontalOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
    assert.ok(
      layout.lefts.every((left) => Math.abs(left - layout.lefts[0]) <= 1),
      `建议行应左对齐，实际 left=${JSON.stringify(layout.lefts)}`,
    );
    assert.ok(layout.stacked, "建议行必须纵向堆叠，不允许横向并排");
    assert.ok(
      layout.footerWidth <= 448 + 1,
      `轮尾宽度不得超过 28rem，实际 ${layout.footerWidth}px`,
    );
    assert.ok(layout.horizontalOverflow <= 0, "390px 视口不得出现横向滚动");
    assert.equal(
      await page.getByTestId("turn-footer-refresh").getAttribute("aria-label"),
      "Refresh suggestions",
    );
    await page.screenshot({ path: join(artifacts, "nst-vis-g-narrow-dark-en-US.png") });
    // 切走再切回（重挂载）：一次新的 readLatest、零 refresh、ID 不变。
    await remount(page, false);
    await page.waitForFunction(() => !document.querySelector('[data-testid="turn-footer"]'));
    await remount(page, true);
    await page.locator('[data-testid="turn-footer"]').waitFor();
    await waitReads(page, 2);
    await releaseRead(page, 1, ready(1, 2, LEGACY_ITEMS));
    await waitLabels(page, LEGACY_EXPECTED);
    assert.deepEqual(await ids(page), LEGACY_EXPECTED_IDS);
    assert.deepEqual(
      (await fixtureCalls(page)).map((call) => call.kind),
      ["readLatest", "readLatest"],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
