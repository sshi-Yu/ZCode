/* 闲时任务列表（Figma「Automations - Task list Idle-time task」/ node 4866-1735）：
   2 列卡片网格，卡片结构与定时任务卡同源（MR 1622 设计）：标题 + 指令描述 +
   底部（moon + #N in queue 位次徽章）。按创建时间倒序；hover 菜单按状态收敛（D29/D30）。
   位次无 Est.（D30-1）。 */
import type { ComponentType, SVGProps } from "react";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { type ZCodeOffPeakTask } from "@zcode/shared";
import {
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
  TID_OFFPEAK_CARD_MENU,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  AutomationCancelActionIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationMoreHorizontalIcon,
  AutomationPausedIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  resolveFailedOffPeakQueueFooter,
  resolveOffPeakStatusFooter,
  type OffPeakStatusIconKind,
} from "@/settings/offPeakUiPresentation.js";

interface OffPeakTaskListProps {
  tasks: readonly ZCodeOffPeakTask[];
  busyOperationId: string | null;
  onOpen: (task: ZCodeOffPeakTask) => void;
  onCancel: (task: ZCodeOffPeakTask) => void;
  onDelete: (task: ZCodeOffPeakTask) => void;
  onOpenSession: (task: ZCodeOffPeakTask) => void;
}

// 按状态分组会让任务在运行和终态切换时跳位，破坏用户对已有卡片位置的预期；
// 列表只按不可变的创建时间倒序，状态变化不再影响顺序。
export function sortOffPeakTasksByCreatedAt(
  tasks: readonly ZCodeOffPeakTask[],
): ZCodeOffPeakTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/** 与 AutomationsSection 定时任务列表相同的滚动阈值（Figma 规范最多露出 8 张卡片）。 */
export const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;

const STATUS_ICON: Record<OffPeakStatusIconKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  moon: AutomationIdleTimeIcon,
  // 设计稿中 Paused 状态是圆形停止图标，旧双竖线会被误读为媒体暂停控件。
  pause: AutomationPausedIcon,
  spinner: LoaderCircle,
  success: CircleCheck,
  warning: TriangleAlert,
  stopped: AutomationPausedIcon,
};

export function OffPeakTaskList({
  tasks,
  busyOperationId,
  onOpen,
  onCancel,
  onDelete,
  onOpenSession,
}: OffPeakTaskListProps) {
  const { intl } = useZCodeIntl();
  const sorted = sortOffPeakTasksByCreatedAt(tasks);

  if (sorted.length === 0) {
    return (
      <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.list.empty" })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid auto-rows-[156px] grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2",
        // 与定时任务列表同一口径：最多露出 8 张卡片，超出由 grid 自身滚动，避免页面无限拉长。
        sorted.length > OFFPEAK_LIST_SCROLL_THRESHOLD &&
          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
      )}
    >
      {sorted.map((task) => {
        const footer = resolveOffPeakStatusFooter(task);
        const FooterIcon = STATUS_ICON[footer.icon];
        const failedQueueFooter = resolveFailedOffPeakQueueFooter(task);
        const FailedQueueIcon = failedQueueFooter ? STATUS_ICON[failedQueueFooter.icon] : null;
        const busy = busyOperationId?.endsWith(task.offPeakTaskId) ?? false;
        return (
          <div
            key={task.offPeakTaskId}
            data-testid={TID_OFFPEAK_CARD}
            data-offpeak-status={task.status}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(task)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task);
              }
            }}
            className={cn(
              // inset surface shadow 不是 Card 描边语义，明暗主题下会与首页卡片产生色差。
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-[10px] border border-card-border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // 完成态保持整体置灰，但仍需用 hover 背景反馈卡片可点击、更多菜单可操作。
              task.status === "completed" ? "opacity-60 hover:bg-hover" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-14 text-ui-base font-medium leading-5 text-foreground">
                {task.title || task.prompt}
              </span>
              {/* 修复原因：任务卡正文与状态字号可缩放，固定 18px 行高会在大字号下挤压或裁切文字。 */}
              <p className="line-clamp-2 h-9 text-ui-base font-normal leading-snug text-foreground-subtle">
                {task.prompt}
              </p>
              {task.status === "queued" || task.status === "paused" ? (
                <p data-offpeak-retired="true" className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "offPeak.retired.pending" })}
                </p>
              ) : null}
              <div className="mt-auto flex h-6 min-w-0 items-center gap-[10px] text-ui-base leading-snug">
                {/* Bug 原因：状态徽章与右侧「运行会话：…」都允许收缩，长会话标题会把状态文字压到只剩一个字。
                   状态是脚注的主信息，改为 shrink-0 不可压缩，只让会话标题那一段 truncate。 */}
                <div
                  className={cn(
                    "flex w-fit shrink-0 items-center gap-0.5 font-normal",
                    footer.className,
                    (task.status === "queued" || task.status === "paused") &&
                      // Zai Dark 的 brand 是白色，闲时排队 Tag 必须使用设计稿专用紫色语义。
                      "rounded-[8px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <FooterIcon
                      className={cn("size-4 shrink-0", task.status === "running" && "animate-spin")}
                      strokeWidth={1.33}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate">
                    {intl.formatMessage({ id: footer.labelId }, footer.labelValues)}
                  </span>
                </div>
                {failedQueueFooter && FailedQueueIcon ? (
                  <div className="flex w-fit shrink-0 items-center gap-0.5 rounded-[6px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task opacity-40">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <FailedQueueIcon
                        className="size-4 shrink-0"
                        strokeWidth={1.33}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="truncate">
                      {intl.formatMessage(
                        { id: failedQueueFooter.labelId },
                        failedQueueFooter.labelValues,
                      )}
                    </span>
                  </div>
                ) : null}
                {task.sessionTitle ? (
                  // 会话内创建的任务绑定并运行在创建它的会话里，脚注露出会话标题。
                  <span
                    data-testid={TID_OFFPEAK_CARD_SESSION}
                    className="ml-auto min-w-0 truncate text-foreground-subtle"
                    title={task.sessionTitle}
                  >
                    {intl.formatMessage(
                      { id: "offPeak.boundSession.label" },
                      { title: task.sessionTitle },
                    )}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="absolute right-3 top-3 flex items-center gap-1">
              {task.sessionId ? (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "offPeak.goToSession",
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(task);
                  }}
                >
                  <AutomationExternalLinkIcon
                    className="size-4 text-foreground-subtle"
                    aria-hidden="true"
                  />
                </button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-white/10 md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-white/10 data-[state=open]:opacity-100"
                    data-testid={TID_OFFPEAK_CARD_MENU}
                    aria-label={intl.formatMessage({
                      id: "automations.moreActions",
                    })}
                    disabled={busy}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AutomationMoreHorizontalIcon
                      className="size-4 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="w-[190px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.canCancel === true ? (
                    <DropdownMenuItem className="gap-1" onSelect={() => onCancel(task)}>
                      {/* 修复原因：细描边 X 比相邻操作图标轻，且与首页 Chat 的暂停生成语义不一致。 */}
                      <span className="flex size-5 items-center justify-center">
                        <AutomationCancelActionIcon
                          className="size-4 fill-current"
                          aria-hidden="true"
                        />
                      </span>
                      {intl.formatMessage({ id: "offPeak.action.cancel" })}
                    </DropdownMenuItem>
                  ) : null}
                  {/* 修复原因：终态菜单只有删除一项时，固定分割线会变成没有分组语义的顶线。 */}
                  {task.canCancel === true ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                    data-testid={TID_OFFPEAK_ACTION_DELETE}
                    onSelect={() => onDelete(task)}
                  >
                    <AutomationTrashIcon />
                    {intl.formatMessage({ id: "automations.delete" })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
