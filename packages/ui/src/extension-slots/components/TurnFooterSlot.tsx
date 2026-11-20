import type { CSSProperties } from "react";
import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTurnFooterSlot } from "@/extension-slots/adapters/useTurnFooterSlot.js";
import { TurnFooterSuggestionIcon } from "@/extension-slots/components/TurnFooterSuggestionIcon.js";
import type { TurnFooterSlotProps } from "@/extension-slots/contract.js";

/** 原生轮尾：只渲染插件的纯文本数据，不接触输入框草稿或会话发送队列。 */
export function TurnFooterSlot(props: TurnFooterSlotProps) {
  const { intl } = useZCodeIntl();
  const model = useTurnFooterSlot(props);
  if (!model) return null;
  const { result, pending, submitted, error } = model;
  const readFailed = error === "read";
  // 失效重读失败必须能重读，不能被上一次 generating 状态遮成永久 Loading。
  const generating = pending === "refresh" || (result?.status === "generating" && !readFailed);
  const busy = pending !== null || generating;
  const refreshLabel = intl.formatMessage({
    id: readFailed
      ? "extensions.turnFooter.retryRead"
      : result
        ? "extensions.turnFooter.refresh"
        : "extensions.turnFooter.generate",
  });
  const statusId =
    pending === "submit"
      ? "extensions.turnFooter.status.submitting"
      : generating
        ? "extensions.turnFooter.status.generating"
        : pending === "read"
          ? "extensions.turnFooter.status.reading"
          : error
            ? `extensions.turnFooter.error.${error}`
            : submitted
              ? "extensions.turnFooter.submitted"
              : result && result.status !== "ready"
                ? `extensions.turnFooter.status.${result.status}`
                : null;
  // 旧版最多五条的缓存只做展示投影，不能改写原 ID/版本或触发重新生成。
  const items =
    result?.status === "ready" && !generating
      ? result.items
          .toSorted(
            (left, right) =>
              Array.from(left.label.trim()).length - Array.from(right.label.trim()).length,
          )
          .slice(0, 4)
      : [];
  const loading = generating || (pending === "read" && items.length === 0);
  const showGenerate = !result && pending === null && !readFailed;
  // 全局样式会清除 outline；按钮用语义背景和边框显式标出键盘焦点。
  const focusClass =
    "focus-visible:border-input-border-focused focus-visible:bg-hover focus-visible:text-foreground";
  return (
    <div
      data-testid="turn-footer"
      data-pending={pending ?? undefined}
      data-version={result?.version}
      aria-label={intl.formatMessage({ id: "extensions.turnFooter.label" })}
      aria-busy={busy}
      role="group"
      className="zcode-turn-footer-enter flex w-full min-w-0 max-w-md flex-col gap-1.5 text-ui-sm text-foreground-subtle"
    >
      <div className="flex min-h-7 items-center justify-between gap-3 pl-0.5">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "extensions.turnFooter.label" })}
        </span>
        <ControlHintTooltip title={refreshLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid="turn-footer-refresh"
            aria-label={refreshLabel}
            disabled={busy}
            onClick={readFailed ? model.retryRead : model.refresh}
            className={cn(
              "cursor-pointer rounded-lg text-foreground-subtle transition-colors duration-150 hover:text-foreground disabled:cursor-default motion-reduce:transition-none",
              focusClass,
            )}
          >
            {generating ? (
              <span className="inline-flex animate-spin motion-reduce:animate-none">
                <LoaderCircleIcon className="size-3.5" aria-hidden="true" />
              </span>
            ) : (
              <RefreshCwIcon className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        </ControlHintTooltip>
      </div>
      {statusId ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="turn-footer-status"
          className="flex min-h-5 items-center gap-2 px-0.5 text-ui-sm text-foreground-subtle"
        >
          {busy && !generating ? (
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 animate-spin motion-reduce:animate-none"
            >
              <LoaderCircleIcon className="size-3.5" />
            </span>
          ) : null}
          <span>{intl.formatMessage({ id: statusId })}</span>
        </div>
      ) : null}
      {loading ? (
        <div data-testid="turn-footer-loading" aria-hidden="true" className="flex flex-col gap-1.5">
          {["w-2/5", "w-3/5"].map((width) => (
            <div
              key={width}
              className="flex min-h-8 items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-2.5 py-1.5"
            >
              <span className="size-3.5 shrink-0 rounded-sm bg-foreground/5" />
              <span className={cn("h-2 rounded-sm bg-foreground/5", width)} />
            </div>
          ))}
        </div>
      ) : items.length > 0 && result?.status === "ready" ? (
        <div key={result.version} className="flex min-w-0 flex-col gap-1.5">
          {items.map((item, index) => (
            <ControlHintTooltip key={item.id} title={item.prompt} align="start">
              <Button
                type="button"
                variant="outline"
                size="default"
                data-testid="turn-footer-suggestion"
                data-suggestion-id={item.id}
                disabled={
                  busy || readFailed || submitted || props.submissionBlocked || error === "stale"
                }
                onClick={() => model.submit(item.id, result.version)}
                style={{ "--zcode-turn-footer-delay": `${index * 30}ms` } as CSSProperties}
                className={cn(
                  "zcode-turn-footer-enter group/nextstep h-auto min-h-8 w-full cursor-pointer items-start justify-start gap-2 rounded-lg border-border/60 bg-transparent px-2.5 py-1.5 text-left text-ui-sm text-foreground-subtle whitespace-normal break-words transition-[background-color,border-color,color,transform] duration-150 hover:border-border hover:bg-hover hover:text-foreground active:translate-y-px disabled:cursor-default motion-reduce:transform-none motion-reduce:transition-none",
                  focusClass,
                )}
              >
                <TurnFooterSuggestionIcon dimension={item.dimension} />
                <span className="min-w-0 flex-1">{item.label}</span>
              </Button>
            </ControlHintTooltip>
          ))}
        </div>
      ) : showGenerate || readFailed || error === "refresh" ? (
        <Button
          type="button"
          variant="outline"
          size="default"
          disabled={busy}
          onClick={readFailed ? model.retryRead : model.refresh}
          className={cn(
            "h-auto min-h-8 w-full cursor-pointer justify-start rounded-lg px-2.5 py-1.5 text-ui-sm text-foreground-subtle disabled:cursor-default",
            focusClass,
          )}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          {refreshLabel}
        </Button>
      ) : null}
    </div>
  );
}
