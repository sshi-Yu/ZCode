import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { transform } from "esbuild";

// 生产 HTML + 官方 App postMessage 握手；夹具只实现宿主三项专用工具，不接触供应商。
const html = await readFile(new URL("../dist/canvas.html", import.meta.url), "utf8");
// 单独加载同一 transport 源码来观察 SDK 本地 options；timeout 不属于 JSON-RPC wire params。
const transport = await transform(await readFile(new URL("../src/browser/app-transport.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
const preview = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const host = `<!doctype html><html><body style="margin:0"><iframe id="app" title="GenImage" src="/canvas.html" style="border:0;width:100vw;height:100dvh"></iframe><script>
window.calls=[];window.jobs=[];window.configured=false;window.accept=false;window.generateError=false;window.exportError=false;window.readError=false;window.saved=true;window.delay=0;window.nextId=5000;window.pending={};window.exportGate=false;window.exportReplies=[];window.exportStarted=0;
window.sendRequest=(method,params)=>new Promise(resolve=>{const id=window.nextId++;window.pending[id]=resolve;document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',id,method,params},'*')});
window.replyExport=()=>{const id=window.exportReplies.shift();if(id!==undefined)document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',id,result:{content:[],structuredContent:{saved:window.saved}}},'*');};
window.addEventListener('message',async e=>{if(e.source!==document.querySelector('iframe').contentWindow)return;const m=e.data;if(!m.method){window.pending[m.id]?.(m);return;}if(m.id===undefined)return;
let result={};let error;
if(m.method==='ui/initialize') result={protocolVersion:'2026-01-26',hostInfo:{name:'zcode',title:'GenImage',version:'1.0.0'},hostCapabilities:{serverTools:{}},hostContext:{zcodeGenImage:!location.search.includes('legacy'),theme:'dark',locale:'en-US',displayMode:'fullscreen',availableDisplayModes:['fullscreen']}};
else if(m.method==='tools/call'){window.calls.push(m.params);const {name,arguments:args}=m.params;
if(name==='genimage_read'){if(window.readError)error={code:-32603,message:'read unavailable'};else result={content:[],structuredContent:{settings:{modelId:'gpt-image-1',configured:window.configured},jobs:window.jobs}};}
else if(name==='genimage_generate'){if(window.delay)await new Promise(r=>setTimeout(r,window.delay));if(window.generateError)error={code:-32603,message:'connection lost'};else {if(window.accept)window.jobs=[{id:args.requestId,prompt:args.prompt,modelId:args.modelId,status:'running'},...window.jobs];result={content:[],structuredContent:{accepted:window.accept}};}}
else if(name==='genimage_export'){if(window.exportGate){window.exportReplies.push(m.id);window.exportStarted=Date.now();return;}if(window.exportError)error={code:-32603,message:'save unavailable'};else result={content:[],structuredContent:{saved:window.saved}};}
else error={code:-32601,message:'unexpected tool'};
}
e.source.postMessage({jsonrpc:'2.0',id:m.id,...(error?{error}:{result})},'*');});
</script></body></html>`;
const csp = "default-src 'none'; script-src 'self' 'unsafe-inline' data: blob:; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
const server = createServer((req, res) => {
  if (req.url === "/transport.js") { res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); res.end(transport.code); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(req.url === "/canvas.html" ? { "Content-Security-Policy": csp } : {}) });
  res.end(req.url === "/canvas.html" ? html : host);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.ZCODE_BROWSER_EXECUTABLE ? { executablePath: process.env.ZCODE_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
const errors = [];
const network = [];
page.on("pageerror", e => errors.push(e.message));
page.on("request", req => { if (!req.url().startsWith(origin) && !req.url().startsWith("data:")) network.push(req.url()); });
const app = page.frameLocator("#app");
const countCalls = name => page.evaluate(n => window.calls.filter(c => c.name === n).length, name);
const waitForRead = async previous => page.waitForFunction(n => window.calls.filter(c => c.name === "genimage_read").length > n, previous);
const refresh = async () => {
  const count = await countCalls("genimage_read");
  await app.getByTestId("genimage-refresh").click();
  await waitForRead(count);
};
try {
  await page.goto(origin);
  const sdkCalls = await page.evaluate(async () => {
    const { callHost } = await import("/transport.js");
    const calls = [];
    const sdk = { callServerTool: async (params, options) => { calls.push({ params, options: options ?? null }); return { structuredContent: {} }; } };
    await callHost(sdk, "genimage_read", {});
    await callHost(sdk, "genimage_generate", { requestId: "request-1", prompt: "An image", modelId: "gpt-image-1" });
    await callHost(sdk, "genimage_export", { assetId: "asset-1" });
    return calls;
  });
  assert.equal(sdkCalls[0].options, null, "read must keep SDK default timeout");
  assert.equal(sdkCalls[1].options, null, "generate must keep SDK default timeout");
  assert.deepEqual(sdkCalls[2].options, { timeout: 30 * 60_000 }, "export must pass the 30-minute SDK option");
  await app.locator('[data-genimage-mode="app"]').waitFor({ timeout: 5000 });
  await app.getByTestId("genimage-state").getByText("No images yet", { exact: true }).waitFor();
  assert.equal(await app.locator(".node").count(), 0, "app must start without fixture samples");
  assert.equal(await countCalls("genimage_read"), 1);
  const darkBackground = await app.locator(".canvas-app").evaluate(element => getComputedStyle(element).backgroundColor);
  const frame = page.frames().find(f => f.url().endsWith("/canvas.html"));
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light", locale: "zh-CN" } }, "*"));
  await app.getByText("还没有成图", { exact: true }).waitFor();
  assert.equal(await app.locator("[data-zcode-plugins-theme]").getAttribute("data-theme"), "light");
  assert.notEqual(await app.locator(".canvas-app").evaluate(element => getComputedStyle(element).backgroundColor), darkBackground);
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark", locale: "en-US" } }, "*"));
  await app.getByText("No images yet", { exact: true }).waitFor();
  await app.getByTestId("genimage-new").click();
  assert.equal(await app.getByTestId("genimage-prompt").getAttribute("maxlength"), "4000");
  await app.getByTestId("genimage-prompt").fill("  A quiet forest  ");
  assert.equal(await app.getByTestId("genimage-generate").isDisabled(), true, "unconfigured must not submit");
  await page.evaluate(() => { window.configured = true; });
  await refresh();
  await app.getByTestId("genimage-generate").click();
  await app.getByText("Cancelled. No request was sent.", { exact: true }).waitFor();
  assert.equal(await countCalls("genimage_generate"), 1);
  assert.equal(await app.locator(".node").count(), 0, "cancel must not invent results");
  await page.evaluate(() => { window.accept = true; window.delay = 250; });
  await app.getByTestId("genimage-generate").dblclick();
  await app.locator('[data-job-status="running"]').first().waitFor();
  assert.equal(await countCalls("genimage_generate"), 2, "double click admits once");
  const submitted = await page.evaluate(() => window.calls.filter(c => c.name === "genimage_generate").at(-1).arguments);
  assert.match(submitted.requestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
  assert.deepEqual(Object.keys(submitted).sort(), ["modelId", "prompt", "requestId"]);
  assert.equal(submitted.modelId, "gpt-image-1");
  assert.equal(submitted.prompt, "A quiet forest");
  assert.equal(await app.locator(".node").count(), 0, "running job is not an image");
  await page.evaluate(p => { window.jobs[0] = { ...window.jobs[0], status: "succeeded", asset: { id: "asset-1", preview: p } }; }, preview);
  const reads = await countCalls("genimage_read");
  await waitForRead(reads);
  await app.locator('[data-asset-id="asset-1"] img').first().waitFor();
  assert.equal(await app.locator(".node").count(), 1);
  assert.equal(await app.locator(".edge").count(), 0);
  assert.equal(await app.getByText("Derive from this image", { exact: true }).count(), 0);
  await app.locator(".node").press("Enter");
  await page.evaluate(() => { window.exportGate = true; });
  await app.getByTestId("genimage-export").dblclick();
  await page.waitForFunction(() => window.exportStarted > 0);
  assert.equal(await countCalls("genimage_export"), 1, "double click must keep one export request in flight");
  assert.equal(await app.getByTestId("genimage-export").isDisabled(), true);
  await app.getByTestId("genimage-export").evaluate(element => {
    element.click();
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(await countCalls("genimage_export"), 1, "pending export must not admit another save");
  await page.evaluate(() => window.replyExport());
  await app.getByText("Image saved.", { exact: true }).waitFor();
  assert.equal(await countCalls("genimage_export"), 1);
  assert.deepEqual(await page.evaluate(() => window.calls.find(c => c.name === "genimage_export").arguments), { assetId: "asset-1" });
  assert.equal(await app.getByTestId("genimage-export").isDisabled(), false, "the finished export must release its wait lock");
  await page.evaluate(() => { window.exportGate = false; window.saved = false; });
  await app.getByTestId("genimage-export").click();
  await app.getByText("Save cancelled.", { exact: true }).waitFor();
  await page.evaluate(() => { window.exportError = true; });
  await app.getByTestId("genimage-export").click();
  await app.getByText("Could not save the image. No automatic retry was made.", { exact: true }).waitFor();
  assert.equal(await countCalls("genimage_export"), 3);

  // 终态无自动读取；重新激活只读恢复，失活与 teardown 都停止轮询。
  const settledReads = await countCalls("genimage_read");
  await page.waitForTimeout(2200);
  assert.equal(await countCalls("genimage_read"), settledReads);
  await page.evaluate(() => { window.jobs.push({ id: "unknown", prompt: "Uncertain", modelId: "gpt-image-1", status: "outcome_unknown", error: "Disconnected" }, { id: "failed", prompt: "Failed prompt", modelId: "gpt-image-1", status: "failed", error: "Rejected" }); });
  await refresh();
  await app.getByTestId("genimage-history").click();
  await app.locator('[data-job-id="unknown"][data-job-status="outcome_unknown"]').waitFor();
  await app.getByText("Result or billing not confirmed", { exact: true }).waitFor();
  await app.locator('[data-job-id="failed"][data-job-status="failed"]').waitFor();
  const history = app.getByRole("dialog");
  const closeHistory = history.getByRole("button", { name: "Close History", exact: true });
  const historyCamera = await app.locator("#world").getAttribute("style");
  for (const key of ["ArrowLeft", "Shift+ArrowRight", "+", "n", "?"]) {
    await page.keyboard.press(key);
    assert.equal(await closeHistory.evaluate(element => element === document.activeElement), true);
    assert.equal(await app.locator("#world").getAttribute("style"), historyCamera);
  }
  await history.press("Escape");
  await app.getByTestId("genimage-new").click();
  await page.evaluate(() => { window.generateError = true; });
  await app.getByTestId("genimage-generate").click();
  await app.getByText("Submission outcome is unknown. Check history before starting a new request.", { exact: true }).waitFor();
  assert.equal(await countCalls("genimage_generate"), 3);
  await page.waitForTimeout(2200);
  assert.equal(await countCalls("genimage_generate"), 3, "errors must never replay a mutation");
  await page.evaluate(() => { window.readError = true; });
  await refresh();
  await app.getByText("Could not read the canvas. Refresh to check again.", { exact: true }).waitFor();
  assert.equal(await app.locator(".node").count(), 1, "read failure retains last projection");
  await page.evaluate(() => { window.readError = false; window.jobs.push({ id: "running-2", prompt: "Still running", modelId: "gpt-image-1", status: "running" }); });
  await refresh();
  await frame.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const hiddenReads = await countCalls("genimage_read");
  await page.waitForTimeout(2200);
  assert.equal(await countCalls("genimage_read"), hiddenReads, "hidden app must stop reading");
  await frame.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await waitForRead(hiddenReads);
  for (const width of [360, 600, 900]) {
    await page.setViewportSize({ width, height: 800 });
    await app.getByTestId("genimage-settings").click();
    const bounds = await app.getByRole("dialog").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.equal(await app.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await app.getByRole("dialog").press("Escape");
  }
  // 新结果前插与宿主记录重排都不能改变首见布局；微调仍由当前页面持有。
  const firstImage = app.locator('.node[data-asset-id="asset-1"]');
  const initialPosition = await firstImage.getAttribute("style");
  await page.evaluate(p => { window.jobs.unshift({ id: "layout-new", prompt: "A new result", modelId: "gpt-image-1", status: "succeeded", asset: { id: "asset-layout-new", preview: p } }); }, preview);
  await refresh();
  const newImage = app.locator('.node[data-job-id="layout-new"]');
  await newImage.waitFor();
  assert.equal(await firstImage.getAttribute("style"), initialPosition, "An untouched image must keep its first-seen position when a result is prepended");
  assert.notEqual(await newImage.getAttribute("style"), initialPosition, "New images must receive their own position");
  await firstImage.press("Shift+ArrowRight");
  const nudgedPosition = await firstImage.getAttribute("style");
  assert.notEqual(nudgedPosition, initialPosition);
  const newPosition = await newImage.getAttribute("style");
  const unchangedCamera = await app.locator("#world").getAttribute("style");
  await page.evaluate(p => { window.jobs.reverse(); window.jobs.unshift({ id: "layout-newest", prompt: "Another result", modelId: "gpt-image-1", status: "succeeded", asset: { id: "asset-layout-newest", preview: p } }); }, preview);
  await refresh();
  await app.locator('.node[data-job-id="layout-newest"]').waitFor();
  assert.equal(await firstImage.getAttribute("style"), nudgedPosition, "A user-positioned image must keep its position across refreshed job ordering");
  assert.equal(await newImage.getAttribute("style"), newPosition, "Previously untouched images must also stay fixed on the next refresh");
  assert.equal(await app.locator("#world").getAttribute("style"), unchangedCamera, "Refreshing jobs must not move the camera");
  const teardown = await page.evaluate(() => window.sendRequest("ui/resource-teardown", {}));  assert.deepEqual(teardown.result, {});
  const endReads = await countCalls("genimage_read");
  await page.waitForTimeout(2200);
  assert.equal(await countCalls("genimage_read"), endReads);
  await page.goto(`${origin}/?legacy`);
  await app.locator('.canvas-app:not([data-genimage-mode="app"])').waitFor();
  assert.equal(await app.locator(".node").count(), 3, "host title alone must keep legacy fixture mode");
  assert.equal(await countCalls("genimage_read"), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(network, [], "production app uses only its page bridge and local data previews");
  console.log("GenImage app browser smoke passed: explicit mode/empty/config/cancel/single admission/poll/projection/export-sdk-timeout/export-wait-single-flight/errors/visibility/narrow/teardown/legacy.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
