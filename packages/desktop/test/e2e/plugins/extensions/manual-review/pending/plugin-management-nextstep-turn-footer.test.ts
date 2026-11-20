// PLM-EXT-NST：NST-02 切换会话只读与 NST-04 单次刷新冒烟，尚不代表完整覆盖。
// 复制真实 NextStep 插件到隔离 E2E HOME，通过 plugins.dirs 加载，不修改真实 profile。
// pending replay 必须显式传入 common.json 和本用例专属 provider fixture。
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXTENSION_SESSION_CONSENT_REVISION } from "@zcode/shared/extension-host";
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { resolveE2EStorageRoot } from "#e2e/helpers/e2e-runtime-paths";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { seedProviderReadinessHistoryFixture } from "#e2e/helpers/provider-readiness-history-fixture";
import { writePluginDirsConfig } from "#e2e/helpers/extension-host-views";
import { waitForTaskRowInProject } from "#e2e/helpers/project-sidebar";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import {
  capturePluginManualReview,
  setPluginPresentation,
} from "#e2e/helpers/plugin-management-lifecycle";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const PLUGIN_ID = "nextstep@inline";
const PLUGIN_SOURCE = resolve(process.cwd(), "../../plugins/nextstep");
const CLI_ENTRY = resolve(process.cwd(), "../../apps/zcode-cli/packages/cli/dist/zcode.cjs");
const OTHER_SESSION = "sess_e2e_nextstep_other";
const MARKER = "E2E_NEXTSTEP_TURNFOOTER";
const GENERATION_INSTRUCTION =
  "Recommend useful next steps for the user's task after the final assistant answer.";
const V1 = ["深化", "😀审查", "复核输入", "补充测试"];
const V2 = ["nextstep suggestion v2 deepen", "nextstep suggestion v2 followup"];
const GENERATION_FIXTURES = [
  "plugin-management-nextstep-turn-footer-generate-1",
  "plugin-management-nextstep-turn-footer-generate-2",
];
// 模拟升级前已保存的五条缓存；这是隔离 E2E HOME 中的测试数据，不更改生产插件。
const LEGACY = [
  {
    id: "legacy-long",
    dimension: "verify",
    label: "验证这轮改动是否可靠",
    prompt: "Verify the changes.",
  },
  { id: "legacy-review", dimension: "review", label: "复核输入", prompt: "Review the input." },
  { id: "legacy-extend", dimension: "extend", label: "补充测试", prompt: "Extend the tests." },
  { id: "legacy-test", dimension: "test", label: "😀审查", prompt: "Test the result." },
  { id: "legacy-deepen", dimension: "deepen", label: "深化", prompt: "Deepen the result." },
];
const LEGACY_IDS = ["legacy-deepen", "legacy-test", "legacy-review", "legacy-extend"];

async function setup(): Promise<void> {
  const home = getE2EAppDataPaths().homeDir;
  if (
    !process.env.ZCODE_E2E_HOME_DIR ||
    resolve(home) !== resolve(process.cwd(), ".e2e-home-nextstep") ||
    resolve(home) !== resolve(process.env.ZCODE_E2E_HOME_DIR)
  ) {
    throw new Error(
      "ZCODE_E2E_HOME_DIR must be the dedicated desktop .e2e-home-nextstep directory",
    );
  }
  const target = join(home, "fixtures", "nextstep-turn-footer", "nextstep");
  await mkdir(target, { recursive: true });
  await cp(PLUGIN_SOURCE, target, { recursive: true });
  await writePluginDirsConfig([target], [PLUGIN_ID]);
  const extensions = join(resolveE2EStorageRoot(), "v2", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "grants.json"),
    JSON.stringify({
      version: 1,
      plugins: {
        [PLUGIN_ID]: {
          grants: ["sessions.read", "turnFooter.generate"],
          consentedVersion: "0.1.1",
          consentRevision: EXTENSION_SESSION_CONSENT_REVISION,
          consentedAt: Date.now(),
        },
      },
    }),
  );
}

async function seedOtherSession(): Promise<void> {
  await seedProviderReadinessHistoryFixture({
    cliEntryPoint: CLI_ENTRY,
    e2eHomeDir: getE2EAppDataPaths().homeDir,
    workspacePath: DEFAULT_WORKSPACE,
    history: {
      sessionId: OTHER_SESSION,
      title: "nextstep other session",
      userText: "other user",
      assistantText: "other reply",
      modelId: "missing-model",
      runtimeProviderId: "missing-provider",
      taskProviderId: "glm",
      assistantInputTokens: 0,
      assistantOutputTokens: 0,
    },
  });
}

async function labels(): Promise<string[]> {
  return browser.execute(() => {
    const footer = document.querySelector<HTMLElement>('[data-testid="turn-footer"]');
    if (!footer || footer.getClientRects().length === 0) return [];
    return Array.from(
      footer.querySelectorAll<HTMLElement>('[data-testid="turn-footer-suggestion"]'),
    )
      .filter((item) => item.getClientRects().length > 0)
      .map((item) => (item.textContent ?? "").trim());
  });
}

async function waitForLabels(expected: string[]): Promise<void> {
  let actual: string[] = [];
  try {
    await browser.waitUntil(
      async () => {
        actual = await labels();
        return JSON.stringify(actual) === JSON.stringify(expected);
      },
      { timeout: 90000, interval: 300 },
    );
  } catch {
    throw new Error(`Expected ${JSON.stringify(expected)}; observed ${JSON.stringify(actual)}`);
  }
  expect(actual.length).toBeGreaterThanOrEqual(2);
  expect(actual.length).toBeLessThanOrEqual(4);
}

async function generationRequests() {
  return getUpstreamRequestEvidence({ includes: [MARKER, GENERATION_INSTRUCTION] });
}

function seedLegacyCache(sessionId: string): void {
  const database = new DatabaseSync(
    join(
      getE2EAppDataPaths().homeDir,
      ".zcode",
      "cli",
      "plugins",
      "data",
      PLUGIN_ID,
      "nextstep.sqlite",
    ),
  );
  try {
    const row = database
      .prepare("SELECT anchor_key FROM versions WHERE version = 1")
      .all() as Array<{ anchor_key: string }>;
    const anchor = row.find(
      (item) => (JSON.parse(item.anchor_key) as { sessionId: string }).sessionId === sessionId,
    );
    if (!anchor) throw new Error("Missing v1 anchor for legacy cache fixture");
    const result = database
      .prepare(
        "UPDATE versions SET items_json = ? WHERE anchor_key = ? AND version = 1 AND status = 'ready'",
      )
      .run(JSON.stringify(LEGACY), anchor.anchor_key);
    expect(Number(result.changes)).toBe(1);
  } finally {
    database.close();
  }
}

async function suggestionIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="turn-footer-suggestion"]'),
    ).map((item) => item.dataset.suggestionId ?? ""),
  );
}

function readVersions(sessionId: string): Array<{
  anchor_key: string;
  version: number;
  trigger_type: string;
  status: string;
  items_json: string | null;
}> {
  const database = new DatabaseSync(
    join(
      getE2EAppDataPaths().homeDir,
      ".zcode",
      "cli",
      "plugins",
      "data",
      PLUGIN_ID,
      "nextstep.sqlite",
    ),
    { readOnly: true },
  );
  try {
    const rows = database
      .prepare(
        "SELECT anchor_key, version, trigger_type, status, items_json FROM versions ORDER BY version",
      )
      .all() as Array<{
      anchor_key: string;
      version: number;
      trigger_type: string;
      status: string;
      items_json: string | null;
    }>;
    return rows.filter(
      (row) => (JSON.parse(row.anchor_key) as { sessionId: string }).sessionId === sessionId,
    );
  } finally {
    database.close();
  }
}

describe("PLM-EXT-NST NextStep 轮尾建议", () => {
  after(async () => {
    await clearAppData();
  });

  it("成功后显示建议，切回只读，刷新后显示第二版本", async function () {
    this.timeout(600000);
    expect(process.env.E2E_PROVIDER_CAPTURE_MODE).toBe("replay");
    await setup();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: seedOtherSession,
    });
    await prepareV4ConversationE2E();
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1400, height: 900 });
    const grants = JSON.parse(
      await readFile(join(resolveE2EStorageRoot(), "v2", "extensions", "grants.json"), "utf8"),
    ) as { plugins: Record<string, { grants: string[] }> };
    expect(grants.plugins[PLUGIN_ID]?.grants.sort()).toEqual([
      "sessions.read",
      "turnFooter.generate",
    ]);
    const manifest = JSON.parse(
      await readFile(join(PLUGIN_SOURCE, ".zcode-plugin", "plugin.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe("0.1.1");

    await sendV4Prompt(`${MARKER}: Reply with exactly "nextstep-e2e-ok" and no other text.`);
    const pane = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "session should be created",
      60000,
    );
    const sessionId = pane.sessionId!;
    await waitForV4AssistantMessageContaining("nextstep-e2e-ok");
    await waitForLabels(V1);
    await capturePluginManualReview("PLM-EXT-NST", "automatic-v1");
    let requests = await generationRequests();
    expect(requests.map((record) => record.fixtureId)).toEqual([GENERATION_FIXTURES[0]]);
    expect(requests[0]?.status).toBe("complete");
    expect(
      readVersions(sessionId).map((row) => [row.version, row.trigger_type, row.status]),
    ).toEqual([[1, "auto", "ready"]]);
    const originalItems = JSON.parse(readVersions(sessionId)[0]!.items_json!) as Array<{
      id: string;
      label: string;
    }>;
    expect(originalItems.map((item) => item.label)).toEqual(V1);
    expect(await suggestionIds()).toEqual(originalItems.map((item) => item.id));
    expect(await $('[data-testid="turn-footer"]').getAttribute("data-version")).toBe("1");

    // 关闭插件进程后注入旧版五条缓存，再重启读取，避免与存储 worker 并发写入。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: () => seedLegacyCache(sessionId),
    });
    await prepareV4ConversationE2E();
    await waitForTaskRowInProject(sessionId, DEFAULT_WORKSPACE);
    await $(`[data-testid="${testId(TID_TASK_ITEM, sessionId)}"]`).click();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId,
      "should reopen original session",
      30000,
    );
    await waitForLabels(V1);
    expect(await suggestionIds()).toEqual(LEGACY_IDS);
    expect(JSON.parse(readVersions(sessionId)[0]!.items_json!)).toEqual(LEGACY);
    expect((await generationRequests()).map((record) => record.fixtureId)).toEqual([
      GENERATION_FIXTURES[0],
    ]);

    await waitForTaskRowInProject(OTHER_SESSION, DEFAULT_WORKSPACE);
    await $(`[data-testid="${testId(TID_TASK_ITEM, OTHER_SESSION)}"]`).click();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === OTHER_SESSION,
      "should switch to the other session",
      30000,
    );
    await $(`[data-testid="${testId(TID_TASK_ITEM, sessionId)}"]`).click();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId,
      "should switch back to original session",
      30000,
    );
    await waitForLabels(V1);
    expect(await suggestionIds()).toEqual(LEGACY_IDS);
    expect(JSON.parse(readVersions(sessionId)[0]!.items_json!)).toEqual(LEGACY);
    expect((await generationRequests()).map((record) => record.fixtureId)).toEqual([
      GENERATION_FIXTURES[0],
    ]);
    expect(
      readVersions(sessionId).map((row) => [row.version, row.trigger_type, row.status]),
    ).toEqual([[1, "auto", "ready"]]);

    const refresh = await $('[data-testid="turn-footer"] [data-testid="turn-footer-refresh"]');
    await refresh.scrollIntoView();
    await refresh.click();
    await waitForLabels(V2);
    await capturePluginManualReview("PLM-EXT-NST", "refreshed-v2");
    requests = await generationRequests();
    expect(requests.map((record) => record.fixtureId)).toEqual(GENERATION_FIXTURES);
    expect(requests.every((record) => record.status === "complete")).toBe(true);
    const versions = readVersions(sessionId);
    expect(versions.map((row) => [row.version, row.trigger_type, row.status])).toEqual([
      [1, "auto", "ready"],
      [2, "manual", "ready"],
    ]);
    expect(
      versions.map((row) =>
        (JSON.parse(row.items_json!) as Array<{ label: string }>).map((item) => item.label),
      ),
    ).toEqual([LEGACY.map((item) => item.label), V2]);
  });
});
