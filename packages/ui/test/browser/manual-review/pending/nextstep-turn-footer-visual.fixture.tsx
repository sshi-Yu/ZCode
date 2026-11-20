// NST-VIS：NextStep 轮尾视觉合同浏览器夹具。真实 TurnFooterSlot + useTurnFooterSlot，
// 经真实 ServiceProvider 注入受控 IExtensionsService：读取/刷新响应由测试显式释放，
// 失效通知由测试显式发布。不 mock 模块、不建 runtime、不发网络请求。
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type {
  TurnFooterChange,
  TurnFooterRequest,
  TurnFooterResponse,
} from "@zcode/shared/extension-host";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TurnFooterSlot } from "@/extension-slots/components/TurnFooterSlot.js";
import "@/styles.css";

interface RecordedCall {
  kind: TurnFooterRequest["kind"];
  at: number;
  requestId?: string;
  version?: number;
  suggestionId?: string;
  commandId?: string;
}

interface HeldCall {
  resolve(response: TurnFooterResponse): void;
  reject(error: Error): void;
}

const calls: RecordedCall[] = [];
const heldReads: HeldCall[] = [];
const heldRefresh: HeldCall[] = [];
const readArrivals: Array<() => void> = [];
let changeListener: ((change: TurnFooterChange | null) => void) | null = null;

function notifyReadArrival(): void {
  for (const arrival of readArrivals.splice(0)) arrival();
}

// 受控服务：所有 readLatest/refresh 都挂起等待测试释放；submit 立即回 accepted。
// 未用到的 IExtensionsService 面在真实链路里不会触发，这里显式抛错防止误用。
const extensionsService = {
  turnFooter(input: TurnFooterRequest): Promise<TurnFooterResponse> {
    const at = performance.now();
    if (input.kind === "readLatest") {
      calls.push({ kind: "readLatest", at });
      return new Promise((resolve, reject) => {
        heldReads.push({ resolve, reject });
        notifyReadArrival();
      });
    }
    if (input.kind === "refresh") {
      calls.push({ kind: "refresh", at, requestId: input.requestId });
      return new Promise((resolve, reject) => {
        heldRefresh.push({ resolve, reject });
      });
    }
    calls.push({
      kind: "submit",
      at,
      version: input.version,
      suggestionId: input.suggestionId,
      commandId: input.commandId,
    });
    return Promise.resolve({ kind: "submitted", status: "accepted" });
  },
  onDynamicTurnFooterChanged() {
    return (listener: (change: TurnFooterChange | null) => void) => {
      changeListener = listener;
      return {
        dispose() {
          if (changeListener === listener) changeListener = null;
        },
      };
    };
  },
  onDynamicContributions() {
    throw new Error("fixture: onDynamicContributions 未在轮尾视觉合同中使用");
  },
  onDynamicHostStatus() {
    throw new Error("fixture: onDynamicHostStatus 未在轮尾视觉合同中使用");
  },
  executeCommand() {
    throw new Error("fixture: executeCommand 未在轮尾视觉合同中使用");
  },
  provideMentionItems() {
    throw new Error("fixture: provideMentionItems 未在轮尾视觉合同中使用");
  },
  reload() {
    throw new Error("fixture: reload 未在轮尾视觉合同中使用");
  },
  reportWorkbench() {
    throw new Error("fixture: reportWorkbench 未在轮尾视觉合同中使用");
  },
  reportEnv() {
    throw new Error("fixture: reportEnv 未在轮尾视觉合同中使用");
  },
  getLogs() {
    throw new Error("fixture: getLogs 未在轮尾视觉合同中使用");
  },
  onDynamicLogs() {
    throw new Error("fixture: onDynamicLogs 未在轮尾视觉合同中使用");
  },
} as unknown as IServiceAccessor["extensionsService"];

const services = { extensionsService } as unknown as IServiceAccessor;

const query = new URLSearchParams(location.search);
const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
const theme = query.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;

const sampleItems = [
  { id: "review", dimension: "review", label: "复核输入", prompt: "核对输入和边界条件。" },
  { id: "test", dimension: "test", label: "😀审查", prompt: "审查关键路径。" },
  { id: "deepen", dimension: "deepen", label: "深化", prompt: "继续深化结论。" },
  { id: "unknown", dimension: "other", label: "补充测试", prompt: "补充一组测试。" },
  { id: "long", dimension: "verify", label: "验证这轮改动是否可靠", prompt: "验证改动。" },
];
let refreshCursor = 0;
function FixtureControls() {
  const [dark, setDark] = useState(theme === "dark");
  const [version, setVersion] = useState(1);
  const resolveLatest = () => {
    const held = heldReads.at(-1);
    if (!held) return;
    held.resolve({
      kind: "view",
      result: { version, revision: 1, status: "ready", items: sampleItems },
    });
  };
  return (
    <nav aria-label="Fixture controls" className="mb-6 flex flex-wrap gap-2 text-sm">
      <button type="button" onClick={resolveLatest}>
        Resolve example
      </button>
      <button
        type="button"
        onClick={() => {
          const held = heldRefresh.at(-1);
          if (!held || heldRefresh.length <= refreshCursor) return;
          refreshCursor = heldRefresh.length;
          const next = version + 1;
          setVersion(next);
          held.resolve({
            kind: "view",
            result: { version: next, revision: 0, status: "generating" },
          });
        }}
      >
        Start fixture generation
      </button>
      <button
        type="button"
        onClick={() => {
          changeListener?.({
            anchor: {
              workspaceKey: "/fixture-ws",
              sessionId: "sess_fixture",
              productTurnId: "turn_fixture",
              assistantMessageId: "msg_fixture",
            },
            version,
            revision: 1,
          });
          // The user explicitly releases the resulting read with Resolve example.
        }}
      >
        Finish generation
      </button>
      <button
        type="button"
        onClick={() => {
          const next = !dark;
          setDark(next);
          document.documentElement.className = `${next ? "dark" : "light"} theme-zai-${next ? "dark" : "light"}`;
        }}
      >
        Toggle theme
      </button>
    </nav>
  );
}

let harnessControls: {
  setMounted(value: boolean): void;
  setBlocked(value: boolean): void;
} | null = null;

function Harness() {
  const [mounted, setMounted] = useState(true);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    harnessControls = { setMounted, setBlocked };
    return () => {
      harnessControls = null;
    };
  }, [setMounted]);
  if (!mounted) return null;
  return (
    <TurnFooterSlot
      target={{ workspacePath: "/fixture-ws", sessionId: "sess_fixture", rowId: 7 }}
      productTurnId="turn_fixture"
      submissionBlocked={blocked}
    />
  );
}

declare global {
  interface Window {
    __nstFixture: {
      waitReads(count: number): Promise<void>;
      releaseRead(index: number, response: TurnFooterResponse): void;
      rejectRead(index: number): void;
      releaseRefresh(index: number, response: TurnFooterResponse): void;
      emit(change: TurnFooterChange | null): void;
      calls(): RecordedCall[];
      heldCounts(): { reads: number; refresh: number };
      remount(value: boolean): void;
      setBlocked(value: boolean): void;
    };
  }
}

window.__nstFixture = {
  async waitReads(count) {
    if (heldReads.length >= count) return;
    await new Promise<void>((resolve) => {
      readArrivals.push(resolve);
    });
    // 逐级等待，避免一次唤醒只覆盖部分到达。
    if (heldReads.length < count) await window.__nstFixture.waitReads(count);
  },
  releaseRead(index, response) {
    const held = heldReads[index];
    if (!held) throw new Error(`fixture: read #${index} 未处于挂起状态`);
    held.resolve(response);
  },
  rejectRead(index) {
    const held = heldReads[index];
    if (!held) throw new Error(`fixture: read #${index} 未处于挂起状态`);
    held.reject(new Error("fixture: controlled read failure"));
  },
  releaseRefresh(index, response) {
    const held = heldRefresh[index];
    if (!held) throw new Error(`fixture: refresh #${index} 未处于挂起状态`);
    held.resolve(response);
  },
  emit(change) {
    if (!changeListener) throw new Error("fixture: 轮尾失效通知没有订阅者");
    changeListener(change);
  },
  calls() {
    return calls.slice();
  },
  heldCounts() {
    return { reads: heldReads.length, refresh: heldRefresh.length };
  },
  remount(value) {
    harnessControls?.setMounted(value);
  },
  setBlocked(value) {
    harnessControls?.setBlocked(value);
  },
};

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={locale}>
      <TooltipProvider>
        <main className="min-h-dvh bg-background text-foreground">
          <div className="mx-auto w-full max-w-2xl p-6">
            <FixtureControls />
            <Harness />
          </div>
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
