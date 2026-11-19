import type { ZCodeOffPeakTask } from "@zcode/shared";
import { TID_OFFPEAK_EDIT_VIEW } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsBackButton } from "@/settings/SettingsBackButton.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { OffPeakHistoryTab } from "@/settings/OffPeakHistoryTab.js";

export function OffPeakHistoryView({
  task,
  busy,
  onBack,
  onOpenSession,
  onCancel,
  onDeleteHistory,
}: {
  task: ZCodeOffPeakTask;
  busy: boolean;
  onBack: () => void;
  onOpenSession: (task: ZCodeOffPeakTask) => void;
  onCancel: (task: ZCodeOffPeakTask) => void;
  onDeleteHistory: (task: ZCodeOffPeakTask) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid={TID_OFFPEAK_EDIT_VIEW}
      className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "space-y-4")}
    >
      <SettingsBackButton onClick={onBack}>
        {intl.formatMessage({ id: "common.back" })}
      </SettingsBackButton>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="break-words text-ui-lg font-medium text-foreground">
            {task.title || task.prompt}
          </h2>
          <p data-offpeak-status={task.status} className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: `offPeak.history.recordedStatus.${task.status}` })}
          </p>
        </div>
        {task.canCancel === true ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => onCancel(task)}>
            {intl.formatMessage({ id: "offPeak.action.cancel" })}
          </Button>
        ) : null}
      </div>
      <p data-testid="offpeak-retirement-notice" className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.retired.notice" })}
      </p>
      <p className="whitespace-pre-wrap break-words text-ui-base text-foreground">{task.prompt}</p>
      <OffPeakHistoryTab
        task={task}
        onOpenSession={onOpenSession}
        onDelete={busy ? undefined : onDeleteHistory}
      />
    </div>
  );
}
