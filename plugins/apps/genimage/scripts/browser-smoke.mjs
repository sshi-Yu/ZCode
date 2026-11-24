import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

/**
 * 可重复浏览器验收（安装产物，不跑 Vite 源码）：
 * 只监听 loopback，模拟官方 MCP Apps JSON-RPC 宿主，给 iframe 施加与生产等价的离线 CSP。
 * 使用已经安装的 Chrome，或 ZCODE_BROWSER_EXECUTABLE 指定路径；不下载浏览器。
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const html = await readFile(path.join(root, "dist/canvas.html"), "utf8");
const offlineCsp = "default-src 'none'; script-src 'self' 'unsafe-inline' blob: data:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe id="app" title="GenImage fixture" src="/canvas.html" style="border:0;width:100vw;height:100dvh"></iframe><script>
window.messages = []; window.nextId = 1000; window.responses = {};
window.sendNotification = (method, params) => document.getElementById('app').contentWindow.postMessage({jsonrpc:'2.0',method,params}, '*');
window.sendRequest = (method, params) => new Promise(resolve => {const id=window.nextId++; window.responses[id]=resolve; document.getElementById('app').contentWindow.postMessage({jsonrpc:'2.0',id,method,params}, '*');});
window.addEventListener('message', e => {if(e.source !== document.getElementById('app').contentWindow) return; const m=e.data; window.messages.push(m); if(m.id!==undefined && !m.method){window.responses[m.id]?.(m);delete window.responses[m.id];return;} if(!m.method || m.id===undefined)return; const result=m.method==='ui/initialize' ? {protocolVersion:'2026-01-26',hostInfo:{name:'zcode-browser-fixture',version:'0.1.1'},hostCapabilities:{},hostContext:{theme:'dark',locale:'zh-CN',displayMode:'inline',availableDisplayModes:['fullscreen'],styles:{variables:{'--color-background-primary':'#161616'}}}} : m.method==='ui/request-display-mode' ? {mode:'fullscreen'} : {}; e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');});
</script></body></html>`;
const server = createServer((req, res) => {
  if (req.url === "/canvas.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": offlineCsp });
    // 与生产相同：首帧前只注入 data-theme，不提供外链脚本、字体或网络权限。
    res.end(html.replace(/<html(?=[\s>])/i, '<html data-theme="dark"'));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(hostHtml);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.ZCODE_BROWSER_EXECUTABLE ? { executablePath: process.env.ZCODE_BROWSER_EXECUTABLE } : { channel: "chrome" }),
});
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
const errors = [];
const network = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (!request.url().startsWith(`http://127.0.0.1:${address.port}/`)) network.push(request.url()); });
const canvas = page.frameLocator("#app");
try {
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await canvas.getByText("已连接 ZCode 宿主", { exact: true }).waitFor();
  assert.equal(await canvas.locator(".node").count(), 3);
  await page.waitForFunction(() => window.messages.some((m) => m.method === "ui/request-display-mode"));
  const init = await page.evaluate(() => window.messages.find((m) => m.method === "ui/initialize"));
  assert.deepEqual(init.params.appCapabilities.availableDisplayModes, ["fullscreen"]);
  assert.equal(await canvas.locator("[data-zcode-plugins-theme]").getAttribute("data-theme"), "dark");
  const darkBackground = await canvas.locator(".canvas-app").evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(darkBackground, "rgba(0, 0, 0, 0)", `semantic background token resolves; ${JSON.stringify(await canvas.locator(".canvas-app").evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(["--color-background", "--background", "--fallback-background", "--color-background-primary", "--text-ui-base", "--ui-font-size"].map((name) => [name, style.getPropertyValue(name)]));
  }))}`);
  assert.equal(await canvas.locator(".node-title").first().evaluate((element) => getComputedStyle(element).fontSize), "14px");

  // 会话 brief 只带入空草稿；已有修改不会被重放覆盖；超限输入也不覆盖。
  await page.evaluate(() => window.sendNotification("ui/notifications/tool-result", { content: [], structuredContent: { brief: "从会话带入的森林" } }));
  await canvas.locator("#prompt").waitFor();
  assert.equal(await canvas.locator("#prompt").inputValue(), "从会话带入的森林");
  await canvas.locator("#prompt").fill("保留我的草稿");
  await page.evaluate(() => window.sendNotification("ui/notifications/tool-result", { content: [], structuredContent: { brief: "不能覆盖" } }));
  await canvas.getByText("已保留当前草稿；会话需求未覆盖你的输入。", { exact: true }).waitFor();
  assert.equal(await canvas.locator("#prompt").inputValue(), "保留我的草稿");

  const beforeTransform = await canvas.locator("#world").getAttribute("style");
  await page.evaluate(() => window.sendNotification("ui/notifications/host-context-changed", { theme: "light", locale: "en-US", styles: { variables: { "--color-background-primary": "#f8f8f8" } } }));
  await canvas.getByText("Simulate one image", { exact: true }).waitFor();
  assert.equal(await canvas.locator("[data-zcode-plugins-theme]").getAttribute("data-theme"), "light");
  assert.equal(await canvas.locator("#prompt").inputValue(), "保留我的草稿");
  assert.equal(await canvas.locator(".node").count(), 3);
  assert.equal(await canvas.locator("#world").getAttribute("style"), beforeTransform);
  const lightBackground = await canvas.locator(".canvas-app").evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(lightBackground, darkBackground, "host theme changes semantic background");
  assert.notEqual(lightBackground, "rgba(0, 0, 0, 0)", "semantic light color resolves");
  await page.evaluate(() => window.sendNotification("ui/notifications/host-context-changed", { locale: "http://invalid.example", styles: { variables: { "--color-background-primary": "url(https://blocked.invalid/)" } } }));
  await page.evaluate(() => window.sendNotification("ui/notifications/host-context-changed", { theme: "light" }));
  // 通知与本页更新在同一通道有序：之后的工具结果可作为前面 locale 更新已处理的栅栏。
  await page.evaluate(() => window.sendNotification("ui/notifications/tool-result", { content: [], structuredContent: { brief: "keep draft" } }));
  await canvas.getByText("Kept the current draft; the session brief did not overwrite it.", { exact: true }).waitFor();
  assert.equal(await canvas.locator(".canvas-app").getAttribute("lang"), "en");
  assert.equal(await canvas.locator("[data-zcode-plugins-theme]").getAttribute("lang"), "en-US");
  assert.equal(await canvas.locator(".canvas-app").evaluate((element) => getComputedStyle(element).backgroundColor), lightBackground, "invalid/partial host values preserve the previous valid projection");
  await page.evaluate(() => window.sendNotification("ui/notifications/tool-result", { content: [], structuredContent: { brief: "😀".repeat(2001) } }));
  await canvas.getByText("The session brief exceeds 2,000 characters; draft untouched.", { exact: true }).waitFor();
  assert.equal(await canvas.locator("#prompt").inputValue(), "保留我的草稿");
  await canvas.locator("#prompt").press("Escape");
  assert.equal(await canvas.getByRole("button", { name: "New", exact: true }).evaluate((element) => element === document.activeElement), true);

  // 浮窗里的键盘操作不改变画布；关闭后画布节点仍可用方向键导航。
  const historyButton = canvas.getByRole("button", { name: "History", exact: true });
  const rootNode = canvas.locator('.node[data-id="A"]');
  const childNode = canvas.locator('.node[data-id="B"]');
  await childNode.focus();
  await historyButton.click();
  const history = canvas.getByRole("dialog", { name: "History 3", exact: true });
  const closeHistory = history.getByRole("button", { name: "Close History", exact: true });
  const panelCamera = await canvas.locator("#world").getAttribute("style");
  const panelNodePosition = await childNode.getAttribute("style");
  for (const key of ["ArrowLeft", "Shift+ArrowRight", "+", "n", "?"]) {
    await page.keyboard.press(key);
    assert.equal(await history.count(), 1, `${key} must leave History open`);
    assert.equal(await closeHistory.evaluate((element) => element === document.activeElement), true, `${key} must leave focus in History`);
  }
  assert.equal(await canvas.locator("#world").getAttribute("style"), panelCamera);
  assert.equal(await childNode.getAttribute("style"), panelNodePosition, "Floating panel keys must not nudge the selected node");
  await page.keyboard.press("Escape");
  assert.equal(await history.count(), 0);
  assert.equal(await historyButton.evaluate((element) => element === document.activeElement), true);
  await childNode.press("ArrowLeft");
  assert.equal(await rootNode.evaluate((element) => element === document.activeElement), true);
  await canvas.getByRole("button", { name: "Fit all", exact: true }).click();
  const beforePan = await canvas.locator("#world").getAttribute("style");

  // 空白拖拽与滚轮改变相机，节点拖动只改变位置，不改变来源。
  const blank = await canvas.locator("#viewport").boundingBox();
  await page.mouse.move(blank.x + 820, blank.y + 600);
  await page.mouse.down(); await page.mouse.move(blank.x + 850, blank.y + 625, { steps: 4 }); await page.mouse.up();
  assert.notEqual(await canvas.locator("#world").getAttribute("style"), beforePan);
  const beforeWheel = await canvas.locator("#world").getAttribute("style");
  await page.mouse.wheel(0, -50);
  await canvas.locator("#world").evaluate((element, before) => new Promise((resolve) => {
    if (element.getAttribute("style") !== before) { resolve(); return; }
    const observer = new MutationObserver(() => { if (element.getAttribute("style") !== before) { observer.disconnect(); resolve(); } });
    observer.observe(element, { attributes: true, attributeFilter: ["style"] });
  }), beforeWheel);
  assert.notEqual(await canvas.locator("#world").getAttribute("style"), beforeWheel);
  await canvas.getByRole("button", { name: "Fit all", exact: true }).click();

  // 派生节点 B -> D；原图不可变，拖动/键盘微调不改连线的来源。
  await canvas.locator('.node[data-id="B"]').focus();
  await canvas.locator('.node[data-id="B"]').press("Enter");
  await canvas.getByRole("button", { name: "Derive from this image", exact: true }).last().click();
  await canvas.locator("#prompt").fill("A quiet green night");
  await canvas.getByRole("button", { name: "Simulate derivation", exact: true }).click();
  assert.equal(await canvas.locator(".node").count(), 4);
  assert.equal(await canvas.locator('.node[data-id="D"]').getAttribute("data-source"), "B");
  assert.equal(await canvas.locator('.edge[data-source="B"][data-target="D"]').count(), 1);
  const oldPosition = await canvas.locator('.node[data-id="D"]').getAttribute("style");
  await canvas.locator('.node[data-id="D"]').press("Shift+ArrowRight");
  assert.notEqual(await canvas.locator('.node[data-id="D"]').getAttribute("style"), oldPosition);
  await canvas.locator('.node[data-id="D"]').press("ArrowLeft");
  assert.equal(await canvas.locator('.node[data-id="B"]').evaluate((el) => el === document.activeElement), true);
  const nodeB = await canvas.locator('.node[data-id="B"]').boundingBox();
  const oldBPosition = await canvas.locator('.node[data-id="B"]').getAttribute("style");
  await page.mouse.move(nodeB.x + 60, nodeB.y + 30); await page.mouse.down();
  await page.mouse.move(nodeB.x + 90, nodeB.y + 50, { steps: 4 }); await page.mouse.up();
  assert.notEqual(await canvas.locator('.node[data-id="B"]').getAttribute("style"), oldBPosition);
  assert.equal(await canvas.locator('.node[data-id="B"]').getAttribute("data-source"), "A");

  for (const width of [360, 600, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await canvas.getByRole("button", { name: "Fit all", exact: true }).click();
    await canvas.getByRole("button", { name: "Settings", exact: true }).click();
    assert.equal(await canvas.locator('[role="dialog"]').count(), 1);
    const bounds = await canvas.locator('[role="dialog"]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `panel fits ${width}px viewport`);
    assert.equal(await canvas.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await canvas.locator('[role="dialog"]').press("Escape");
  }
  // teardown 被确认，页面不继续处理宿主结果或保持活动连接。
  const teardown = await page.evaluate(() => window.sendRequest("ui/resource-teardown", {}));
  assert.deepEqual(teardown.result, {});
  assert.deepEqual(errors, [], "page must not throw");
  assert.deepEqual(network, [], "production canvas must remain offline under default CSP");
  console.log("GenImage browser smoke passed: handshake/fullscreen/brief/theme/lineage/keyboard/360-600-900/teardown, offline CSP.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
