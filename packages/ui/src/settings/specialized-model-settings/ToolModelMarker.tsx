import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toolModelKey, type ToolModelRef } from "./contract.js";
import {
  useSpecializedModelSettingsService,
  useSpecializedSettings,
} from "./useSpecializedSettings.js";

interface ToolModelMarkerState {
  selectedKey: string;
  eligibleKeys: ReadonlySet<string>;
  pending: boolean;
  toggle(model: ToolModelRef): void;
}

const ToolModelMarkerContext = createContext<ToolModelMarkerState | null>(null);

export function ToolModelMarkerProvider({
  sourceRevision,
  children,
}: {
  sourceRevision?: number;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const service = useSpecializedModelSettingsService();
  const read = useCallback(() => service?.getToolModelSettings() ?? Promise.resolve(undefined), [
    service,
  ]);
  const { view, pending, mutate, refresh } = useSpecializedSettings(read, sourceRevision);
  const eligibleKeys = useMemo(() => new Set(view?.candidates.map(toolModelKey)), [view?.candidates]);
  const selectedKey = toolModelKey(view?.selection ?? null);
  const value = service && view
    ? {
        selectedKey,
        eligibleKeys,
        pending,
        toggle(model: ToolModelRef) {
          if (pending) return;
          const selection = toolModelKey(model) === selectedKey ? null : model;
          void mutate(() => service.setToolModel({ expectedRevision: view.revision, selection }))
            .then((saved) => {
              if (saved) return;
              refresh();
              toast(intl.formatMessage({ id: "settings.modelProvider.utilityModel.saveFailed" }));
            });
        },
      }
    : null;
  return <ToolModelMarkerContext.Provider value={value}>{children}</ToolModelMarkerContext.Provider>;
}

export function ToolModelMarker({ providerId, modelId }: ToolModelRef) {
  const { intl } = useZCodeIntl();
  const marker = useContext(ToolModelMarkerContext);
  const key = toolModelKey({ providerId, modelId });
  const selected = marker?.selectedKey === key;
  if (!marker || (!selected && !marker.eligibleKeys.has(key))) return null;

  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size="icon-sm"
      className="shrink-0"
      data-testid="model-utility-toggle"
      aria-pressed={selected}
      aria-label={intl.formatMessage({ id: "settings.modelProvider.utilityModel.label" })}
      title={intl.formatMessage({
        id: selected
          ? "settings.modelProvider.utilityModel.clear"
          : "settings.modelProvider.utilityModel.set",
      })}
      disabled={marker.pending}
      onClick={() => marker.toggle({ providerId, modelId })}
    >
      <Wrench />
    </Button>
  );
}
