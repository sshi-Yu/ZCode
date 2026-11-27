import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { ScanEye, Wrench } from "lucide-react";
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
const FeatureModelMarkerContext = createContext<ToolModelMarkerState | null>(null);

export function ToolModelMarkerProvider({
  sourceRevision,
  children,
}: {
  sourceRevision?: number;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const service = useSpecializedModelSettingsService();
  const read = useCallback(
    () => service?.getToolModelSettings() ?? Promise.resolve(undefined),
    [service],
  );
  const { view, pending, mutate, refresh } = useSpecializedSettings(read, sourceRevision);
  const eligibleKeys = useMemo(
    () => new Set(view?.candidates.map(toolModelKey)),
    [view?.candidates],
  );
  const selectedKey = toolModelKey(view?.selection ?? null);
  const value =
    service && view
      ? {
          selectedKey,
          eligibleKeys,
          pending,
          toggle(model: ToolModelRef) {
            if (pending) return;
            const selection = toolModelKey(model) === selectedKey ? null : model;
            void mutate(() =>
              service.setToolModel({ expectedRevision: view.revision, selection }),
            ).then((saved) => {
              if (saved) return;
              refresh();
              toast(intl.formatMessage({ id: "settings.modelProvider.utilityModel.saveFailed" }));
            });
          },
        }
      : null;
  const readFeature = useCallback(
    () => service?.getFeatureModelSettings() ?? Promise.resolve(undefined),
    [service],
  );
  const feature = useSpecializedSettings(readFeature, sourceRevision);
  const featureCandidates = feature.view?.candidates;
  const featureKeys = useMemo(
    () => new Set(featureCandidates?.map(toolModelKey)),
    [featureCandidates],
  );
  const featureView = feature.view;
  const featureKey = toolModelKey(featureView?.selection ?? null);
  const featureValue =
    service && featureView
      ? {
          selectedKey: featureKey,
          eligibleKeys: featureKeys,
          pending: feature.pending,
          toggle(model: ToolModelRef) {
            if (feature.pending) return;
            const selection = toolModelKey(model) === featureKey ? null : model;
            void feature
              .mutate(() =>
                service.setFeatureModel({ expectedRevision: featureView.revision, selection }),
              )
              .then((saved) => {
                if (saved) return;
                feature.refresh();
                toast(intl.formatMessage({ id: "settings.modelProvider.featureModel.saveFailed" }));
              });
          },
        }
      : null;
  return (
    <ToolModelMarkerContext.Provider value={value}>
      <FeatureModelMarkerContext.Provider value={featureValue}>
        {children}
      </FeatureModelMarkerContext.Provider>
    </ToolModelMarkerContext.Provider>
  );
}

export function ToolModelMarker({ providerId, modelId }: ToolModelRef) {
  return (
    <>
      <ModelMarker providerId={providerId} modelId={modelId} kind="utilityModel" />
      <ModelMarker providerId={providerId} modelId={modelId} kind="featureModel" />
    </>
  );
}

function ModelMarker({
  providerId,
  modelId,
  kind,
}: ToolModelRef & { kind: "utilityModel" | "featureModel" }) {
  const { intl } = useZCodeIntl();
  const marker = useContext(
    kind === "utilityModel" ? ToolModelMarkerContext : FeatureModelMarkerContext,
  );
  const labelPrefix = `settings.modelProvider.${kind}`;
  const key = toolModelKey({ providerId, modelId });
  const selected = marker?.selectedKey === key;
  if (!marker || (!selected && !marker.eligibleKeys.has(key))) return null;

  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size="icon-sm"
      className="shrink-0"
      data-testid={kind === "utilityModel" ? "model-utility-toggle" : "model-feature-toggle"}
      aria-pressed={selected}
      aria-label={intl.formatMessage({ id: `${labelPrefix}.label` })}
      title={intl.formatMessage({
        id: selected ? `${labelPrefix}.clear` : `${labelPrefix}.set`,
      })}
      disabled={marker.pending}
      onClick={() => marker.toggle({ providerId, modelId })}
    >
      {kind === "utilityModel" ? <Wrench /> : <ScanEye />}
    </Button>
  );
}
