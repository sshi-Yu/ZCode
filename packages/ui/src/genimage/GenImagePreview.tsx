import { Download, ImageIcon, ScanEye, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { ImagePreviewSurface } from "@/image-preview-editor/index.js";
import type { FeatureModelSettingsView, GenImageNode } from "./contract.js";
import type { GenImageText } from "./text.js";
import type { GenImageMedia } from "./useGenImageLocal.js";

interface GenImagePreviewProps {
  node: GenImageNode;
  text: GenImageText;
  media: GenImageMedia;
  trigger: HTMLElement;
  initialDetails?: boolean;
  featureModel?: FeatureModelSettingsView;
  pending?: string;
  error?: string;
  onClose(): void;
  onExtract(revision: number, routeKey: string): void;
  onRefreshModel(): void;
  onOpenModelSettings?: () => void;
}

export function GenImagePreview({
  node,
  text,
  media,
  trigger,
  initialDetails,
  featureModel,
  pending,
  error,
  onClose,
  onExtract,
  onRefreshModel,
  onOpenModelSettings,
}: GenImagePreviewProps) {
  const [details, setDetails] = useState(Boolean(initialDetails));
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [exportStatus, setExportStatus] = useState<"busy" | "done" | "failed">();
  const exportPending = useRef(false);
  const title = node.fileName ?? node.title;
  const source = node.fileName ? text.imported : text.generated;
  const selection = featureModel?.selection;
  const routeKey = featureModel?.routeKey;
  const endpointHost = featureModel?.endpointHost;
  const fresh = Boolean(
    selection &&
    routeKey &&
    node.features?.routeKey === routeKey &&
    node.features?.modelRevision === featureModel?.revision &&
    node.features?.providerId === selection.providerId &&
    node.features?.modelId === selection.modelId,
  );
  const ownPending = pending === node.id;
  const revisionConflict = error?.endsWith("revision-conflict");
  const closeButton = useRef<HTMLButtonElement>(null);
  const detailToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void media.original(node.id).then(
      (asset) => {
        if (active) setUrl(asset.url);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [media, node.id]);

  async function exportImage() {
    if (!media.exportOriginal || exportPending.current) return null;
    exportPending.current = true;
    setExportStatus("busy");
    try {
      const result = await media.exportOriginal(node);
      setExportStatus(result.canceled ? undefined : result.success ? "done" : "failed");
      return result.success ? (result.path ?? null) : null;
    } catch {
      setExportStatus("failed");
      return null;
    } finally {
      exportPending.current = false;
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        data-testid="genimage-original-dialog"
        className="gi-original-dialog top-0 left-0 translate-x-0 translate-y-0"
        overlayClassName="bg-background"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }}
      >
        <header className="gi-original-header">
          <ImageIcon size={17} className="shrink-0 text-foreground-subtle" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-ui-base" title={title}>
              {title}
            </DialogTitle>
            <p className="text-ui-sm text-foreground-subtle tabular-nums">
              {node.width} × {node.height} · {source}
            </p>
          </div>
          <Button
            type="button"
            variant={details ? "secondary" : "ghost"}
            size="sm"
            ref={detailToggle}
            aria-expanded={details}
            aria-label={text.features}
            onClick={() => setDetails((value) => !value)}
            data-testid="genimage-feature-toggle"
          >
            <ScanEye />
            <span className="hidden sm:inline">{text.features}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={text.close}
            ref={closeButton}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="gi-original-body">
          <div className="gi-original-stage">
            {failed ? (
              <p className="gi-original-message text-destructive" role="alert">
                {text.assetFailed}
              </p>
            ) : url ? (
              <ImagePreviewSurface
                readOnly
                src={url}
                alt={title}
                filename={title}
                imageTestId="genimage-original"
                onImageError={() => setFailed(true)}
                onDownload={exportImage}
                downloading={exportStatus === "busy"}
                onClose={onClose}
                onSaved={onClose}
              />
            ) : (
              <p className="gi-original-message" role="status">
                {text.assetLoading}
              </p>
            )}
            <div className="gi-original-export">
              {exportStatus === "done" || exportStatus === "failed" ? (
                <span
                  className="text-ui-xs text-foreground-subtle"
                  role={exportStatus === "failed" ? "alert" : "status"}
                >
                  {exportStatus === "done" ? text.exported : text.exportFailed}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={text.export}
                disabled={!media.exportOriginal || !url || failed || exportStatus === "busy"}
                data-testid="genimage-export"
                onClick={() => void exportImage()}
              >
                <Download />
                <span className="hidden sm:inline">
                  {exportStatus === "busy" ? text.exporting : text.export}
                </span>
              </Button>
            </div>
          </div>
          {details ? (
            <aside
              className="gi-original-features"
              aria-label={text.features}
              data-testid="genimage-feature-details"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="font-semibold text-ui-base">{text.features}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={text.closeFeatures}
                  onClick={() => {
                    setDetails(false);
                    detailToggle.current?.focus();
                  }}
                >
                  <X />
                </Button>
              </div>
              {node.features ? (
                <div className="grid gap-3" data-testid="genimage-feature-result">
                  <p className="wrap-anywhere text-ui-base leading-relaxed">
                    {node.features.summary}
                  </p>
                  <ul className="gi-tags">
                    {node.features.tags.map((tag) => (
                      <li key={tag}>{tag}</li>
                    ))}
                  </ul>
                  <p className="wrap-anywhere text-ui-sm text-foreground-subtle">
                    {node.features.providerId} / {node.features.modelId}
                  </p>
                </div>
              ) : (
                <p className="text-ui-sm text-foreground-subtle">{text.noFeatures}</p>
              )}
              {!fresh || ownPending ? (
                <div className="mt-5 grid gap-2 border-t border-border pt-4">
                  {featureModel?.available && selection && routeKey && endpointHost ? (
                    <>
                      <p className="wrap-anywhere text-ui-sm text-foreground-subtle">
                        {text.featureDestination(
                          selection.providerId,
                          selection.modelId,
                          endpointHost,
                        )}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        disabled={Boolean(pending) || revisionConflict}
                        data-testid="genimage-extract"
                        onClick={() => onExtract(featureModel.revision, routeKey)}
                      >
                        {ownPending
                          ? text.extracting
                          : node.features
                            ? text.extractAgain
                            : text.extract}
                      </Button>
                    </>
                  ) : (
                    <>
                      <p className="text-ui-sm text-foreground-subtle">{text.featureUnavailable}</p>
                      {onOpenModelSettings ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            onClose();
                            onOpenModelSettings();
                          }}
                        >
                          {text.openModelSettings}
                        </Button>
                      ) : null}
                    </>
                  )}
                  {error ? (
                    <p role="alert" className="text-ui-sm text-destructive">
                      {revisionConflict
                        ? text.liveChanged
                        : error.endsWith("feature-busy")
                          ? text.featureBusy
                          : text.featureFailed}
                    </p>
                  ) : null}
                  {!ownPending && (!featureModel?.available || revisionConflict) ? (
                    <Button type="button" size="sm" variant="ghost" onClick={onRefreshModel}>
                      {text.refreshModel}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
