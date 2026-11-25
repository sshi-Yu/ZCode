import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { HistoryIcon, ImageIcon, MinusIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  GenImageWorkspaceProps,
  IImageGenerationService,
  ImageGenerationJob,
  ImageGenerationSelection,
} from "./contract.js";
import {
  getImageText,
  imageConfirmation,
  imageServiceError,
  isImageAdmissionRejection,
} from "./imageText.js";
import { useImageGallery } from "./useImageGallery.js";

function selectionKey(selection: ImageGenerationSelection) {
  return JSON.stringify([selection.connectionId, selection.modelKey]);
}

function GalleryImage({
  service,
  assetId,
  unavailable,
}: {
  service: IImageGenerationService | undefined;
  assetId: string;
  unavailable: string;
}) {
  const [preview, setPreview] = useState<string>();
  const [failed, setFailed] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!service || !element.current) return;
    let disposed = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void service
          .readPreview({ assetId })
          .then(({ preview: next }) => {
            if (!disposed) setPreview(next);
          })
          .catch(() => {
            if (!disposed) setFailed(true);
          });
      },
      { rootMargin: "96px" },
    );
    observer.observe(element.current);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [assetId, service]);
  return (
    <div
      ref={element}
      className="flex aspect-square items-center justify-center overflow-hidden bg-surface"
      aria-label={failed ? unavailable : undefined}
    >
      {preview && !failed ? (
        <img
          src={preview}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : failed ? (
        unavailable
      ) : (
        <ImageIcon className="size-6 text-foreground-subtle" />
      )}
    </div>
  );
}

function OriginalImage({
  service,
  assetId,
  alt,
  text,
}: {
  service: IImageGenerationService;
  assetId: string;
  alt: string;
  text: ReturnType<typeof getImageText>;
}) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    void service
      .readImage({ assetId })
      .then((bytes) => {
        if (disposed) return;
        url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "image/png" }));
        setSrc(url);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [assetId, service]);

  if (failed) return <p role="alert">{text.previewUnavailable}</p>;
  if (!src) return <p role="status">{text.loadingOriginal}</p>;
  return (
    <img
      src={src}
      alt={alt}
      data-testid="genimage-original-image"
      className="m-auto max-h-[78dvh] max-w-full object-contain"
      onError={() => setFailed(true)}
    />
  );
}

export function GenImageWorkspace({ onOpenSettings, showWindowControls }: GenImageWorkspaceProps) {
  const { intl, locale } = useZCodeIntl();
  const text = getImageText(locale);
  const service = useBaseWorkspaceServices().imageGenerationService;
  const { saveFile } = usePlatform();
  const confirm = useConfirmDialog();
  const gallery = useImageGallery(service);
  const { configuration, active, track, refreshConfiguration } = gallery;
  const [panel, setPanel] = useState<"compose" | "history" | "detail" | null>(null);
  const [prompt, setPrompt] = useState("");
  const [override, setOverride] = useState<string>();
  const [selectedJob, setSelectedJob] = useState<string>();
  const [zoom, setZoom] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [unconfirmedRequestId, setUnconfirmedRequestId] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean }>();
  const pending = useRef<AbortController | null>(null);
  const exportFlight = useRef(false);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const pan = useRef<{ id: number; x: number; y: number; left: number; top: number }>(null);
  const promptId = useId();
  const modelId = useId();
  useLayoutEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [service],
  );

  const choices = (configuration?.connections ?? []).flatMap((connection) =>
    connection.enabled && connection.configured
      ? connection.models
          .filter((model) => model.enabled)
          .map((model) => ({
            key: selectionKey({ connectionId: connection.connectionId, modelKey: model.modelKey }),
            model,
            connection,
          }))
      : [],
  );
  const defaultSelection = configuration?.defaultSelection.selection;
  const selected = choices.find(
    (choice) =>
      choice.key === (override ?? (defaultSelection ? selectionKey(defaultSelection) : "")),
  );
  const jobs = gallery.gallery?.jobs ?? [];
  const visibleJobs = active ? [active, ...jobs.filter((job) => job.id !== active.id)] : jobs;
  const selectedResult = visibleJobs.find((job) => job.id === selectedJob);
  const title = intl.formatMessage({ id: "genimage.title" });

  useLayoutEffect(() => {
    if (panel) panelHeading.current?.focus();
  }, [panel]);

  function closePanel() {
    setPanel(null);
    panelTrigger.current?.focus();
  }

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      event.currentTarget.clientWidth < 660 ||
      !(event.target instanceof Element) ||
      event.target.closest("button, a, input, textarea, select")
    )
      return;
    const viewport = event.currentTarget;
    pan.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const start = pan.current;
    if (start?.id !== event.pointerId) return;
    event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
    event.currentTarget.scrollTop = start.top + start.y - event.clientY;
  }

  function showReceipt(job: ImageGenerationJob) {
    setUnconfirmedRequestId(undefined);
    track(job);
    setSelectedJob(job.id);
    setPanel("detail");
    setPrompt("");
  }

  async function readReceipt(requestId: string, signal: AbortSignal) {
    const receipt = await service?.getRequest({ requestId }).catch(() => null);
    if (signal.aborted) return;
    if (receipt?.job) showReceipt(receipt.job);
    else setFeedback({ error: true, message: text.receiptUnconfirmed });
  }

  async function generate() {
    if (!service || pending.current) return;
    if (!unconfirmedRequestId && (!selected || !prompt.trim() || active)) return;
    const controller = new AbortController();
    pending.current = controller;
    setSubmitting(true);
    setFeedback(undefined);
    if (unconfirmedRequestId) {
      try {
        await readReceipt(unconfirmedRequestId, controller.signal);
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setSubmitting(false);
        }
      }
      return;
    }
    const { connection, model } = selected!;
    const input = {
      requestId: crypto.randomUUID(),
      prompt: prompt.trim(),
      purpose: "generation" as const,
      connectionId: connection.connectionId,
      modelKey: model.modelKey,
      revision: connection.revision,
    };
    try {
      const approved = await confirm(
        {
          intent: "genimage-generate",
          explicitConfirm: true,
          title: intl.formatMessage({ id: "genimage.confirm.title" }),
          description: imageConfirmation(
            text,
            connection.generationUrl,
            model.modelId,
            model.parameters,
            input.prompt,
          ),
          scrollableDescription: true,
          confirmLabel: intl.formatMessage({ id: "genimage.confirm.submit" }),
        },
        controller.signal,
      );
      if (!approved || controller.signal.aborted) return;
      try {
        const { job } = await service.startGeneration(input);
        if (!controller.signal.aborted) showReceipt(job);
      } catch (error) {
        if (isImageAdmissionRejection(error)) throw error;
        if (controller.signal.aborted) return;
        // 回执丢失不等于拒绝；后续按钮只读取相同 ID，不能进入新的付费提交。
        setUnconfirmedRequestId(input.requestId);
        await readReceipt(input.requestId, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setFeedback({ error: true, message: imageServiceError(text, error) });
      void refreshConfiguration();
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setSubmitting(false);
      }
    }
  }

  async function exportOriginal(assetId: string) {
    if (!service || !saveFile || exportFlight.current) return;
    exportFlight.current = true;
    setExporting(true);
    setFeedback(undefined);
    try {
      const bytes = await service.readImage({ assetId });
      const result = await saveFile({
        suggestedName: `genimage-${assetId}.png`,
        data: Uint8Array.from(bytes).buffer,
      });
      if (result.success) setFeedback({ message: text.exported });
      else if (!result.canceled) throw new Error("Original image export failed");
    } catch {
      setFeedback({ error: true, message: intl.formatMessage({ id: "genimage.export.failed" }) });
    } finally {
      exportFlight.current = false;
      setExporting(false);
    }
  }

  function renderJob(job: ImageGenerationJob) {
    return (
      <article
        key={job.id}
        data-job-id={job.id}
        data-job-status={job.status}
        data-asset-id={job.asset?.id}
        className="overflow-hidden rounded-lg border border-border bg-card text-ui-sm"
      >
        <button
          type="button"
          className="block w-full text-left [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={(event) => {
            panelTrigger.current = event.currentTarget;
            setSelectedJob(job.id);
            setPanel("detail");
          }}
        >
          {job.asset ? (
            <GalleryImage
              key={job.asset.id}
              service={service}
              assetId={job.asset.id}
              unavailable={text.previewUnavailable}
            />
          ) : null}
          <span className="block p-3">
            <span className="line-clamp-2 text-foreground">{job.prompt}</span>
            <span
              data-testid={
                job.status === "outcome_unknown" ? "genimage-outcome-unknown-notice" : undefined
              }
              className="mt-1 block text-foreground-subtle"
            >
              {job.modelId} · {text[job.status]}
            </span>
          </span>
        </button>
      </article>
    );
  }

  return (
    <section
      data-testid="genimage-workspace"
      className="@container flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      aria-label={title}
    >
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-header px-2 py-1 [app-region:drag]">
        <h1 className="mr-auto px-2 text-ui-base font-medium">{title}</h1>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={text.history}
          title={text.history}
          data-testid="genimage-history"
          className="[app-region:no-drag]"
          onClick={(event) => {
            panelTrigger.current = event.currentTarget;
            setPanel("history");
          }}
        >
          <HistoryIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={intl.formatMessage({ id: "genimage.modelSettings" })}
          title={intl.formatMessage({ id: "genimage.modelSettings" })}
          data-testid="genimage-open-model-settings"
          className="[app-region:no-drag]"
          onClick={onOpenSettings}
        >
          <Settings2Icon />
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="genimage-new"
          className="[app-region:no-drag]"
          onClick={(event) => {
            panelTrigger.current = event.currentTarget;
            // 临时模型只属于当前草稿；新建时应重新采用全局默认模型。
            setOverride(undefined);
            setPanel("compose");
          }}
        >
          <PlusIcon />
          {text.create}
        </Button>
        {showWindowControls ? <DesktopWindowControls /> : null}
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={canvas}
          className="min-h-0 flex-1 overflow-auto bg-background @[660px]:select-none"
          aria-label={text.gallery}
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onLostPointerCapture={() => {
            pan.current = null;
          }}
        >
          <div className="flex flex-wrap items-center gap-2 p-3 text-ui-sm text-foreground-subtle">
            <span>{text.gallery}</span>
            {!selected && configuration ? (
              <Button type="button" variant="link" size="sm" onClick={onOpenSettings}>
                {text.configure}
              </Button>
            ) : null}
            {gallery.configurationError ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void refreshConfiguration()}
              >
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            ) : null}
          </div>
          {gallery.historyError ? (
            <div className="px-4">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={gallery.loadingHistory}
                onClick={() => void gallery.readHistory(gallery.gallery?.cursor ?? undefined)}
              >
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            </div>
          ) : null}
          {visibleJobs.length === 0 && gallery.gallery ? (
            <p className="px-5 py-12 text-center text-ui-base text-foreground-subtle">
              {text.empty}
            </p>
          ) : null}
          {visibleJobs.length ? (
            <div className="grid grid-cols-1 gap-3 p-3 @[660px]:flex @[660px]:flex-wrap @[660px]:items-start @[660px]:p-6">
              {visibleJobs.map((job) => (
                <div
                  key={job.id}
                  className="min-w-0 @[660px]:w-(--image-card-width)"
                  style={{ "--image-card-width": `${(288 * zoom) / 100}px` } as React.CSSProperties}
                >
                  {renderJob(job)}
                </div>
              ))}
            </div>
          ) : null}
          {gallery.gallery?.cursor ? (
            <div className="p-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={gallery.loadingHistory}
                onClick={() => void gallery.readHistory(gallery.gallery?.cursor ?? undefined)}
              >
                {text.more}
              </Button>
            </div>
          ) : null}
        </div>
        {visibleJobs.length ? (
          <div className="absolute bottom-3 left-3 hidden items-center rounded-md border border-border bg-popover @[660px]:flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={text.zoomOut}
              disabled={zoom <= 50}
              onClick={() => setZoom((value) => value - 10)}
            >
              <MinusIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={text.resetView}
              onClick={() => {
                setZoom(100);
                canvas.current?.scrollTo(0, 0);
              }}
            >
              {zoom}%
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={text.zoomIn}
              disabled={zoom >= 160}
              onClick={() => setZoom((value) => value + 10)}
            >
              <PlusIcon />
            </Button>
          </div>
        ) : null}
        {panel ? (
          <section
            aria-labelledby={`${promptId}-panel`}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault();
                event.stopPropagation();
                closePanel();
              }
            }}
            className="z-10 max-h-[60%] min-w-0 space-y-3 overflow-auto border-t border-border bg-popover p-3 text-ui-base shadow-lg @[660px]:absolute @[660px]:right-4 @[660px]:top-4 @[660px]:max-h-[calc(100%_-_2rem)] @[660px]:w-88 @[660px]:rounded-xl @[660px]:border"
          >
            <div className="flex items-center justify-between gap-2">
              <h2
                ref={panelHeading}
                tabIndex={-1}
                id={`${promptId}-panel`}
                className="font-medium [overflow-wrap:anywhere]"
              >
                {panel === "compose"
                  ? text.create
                  : panel === "history"
                    ? text.history
                    : (selectedResult?.modelId ?? text.gallery)}
              </h2>
              <Button type="button" variant="ghost" size="sm" onClick={closePanel}>
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            </div>
            {panel === "compose" ? (
              <>
                <label htmlFor={modelId} className="block text-ui-sm text-foreground-subtle">
                  {text.model}
                </label>
                <select
                  id={modelId}
                  className="w-full rounded-md border border-border bg-background p-2 text-ui-base"
                  value={selected?.key ?? ""}
                  onChange={(event) => setOverride(event.currentTarget.value)}
                >
                  <option value="" disabled>
                    {text.configure}
                  </option>
                  {choices.map(({ key, connection, model }) => (
                    <option key={key} value={key}>
                      {connection.name} · {model.name}
                    </option>
                  ))}
                </select>
                <label htmlFor={promptId} className="block text-ui-sm text-foreground-subtle">
                  {text.prompt}
                </label>
                <textarea
                  id={promptId}
                  data-testid="genimage-prompt"
                  className="min-h-28 w-full resize-y rounded-md border border-border bg-background p-2 text-ui-base"
                  maxLength={4000}
                  value={prompt}
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                />
                <Button
                  type="button"
                  data-testid="genimage-generate"
                  disabled={
                    submitting ||
                    (!unconfirmedRequestId && (Boolean(active) || !selected || !prompt.trim()))
                  }
                  onClick={() => void generate()}
                >
                  {unconfirmedRequestId ? text.retryReceipt : text.generate}
                </Button>
              </>
            ) : panel === "history" ? (
              <ul className="space-y-1">
                {visibleJobs.map((job) => (
                  <li key={job.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-8 w-full justify-start whitespace-normal text-left [overflow-wrap:anywhere]"
                      onClick={() => {
                        setSelectedJob(job.id);
                        setPanel("detail");
                      }}
                    >
                      {job.prompt}
                    </Button>
                  </li>
                ))}
                {gallery.gallery?.cursor ? (
                  <li>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={gallery.loadingHistory}
                      onClick={() => void gallery.readHistory(gallery.gallery?.cursor ?? undefined)}
                    >
                      {text.more}
                    </Button>
                  </li>
                ) : null}
              </ul>
            ) : selectedResult ? (
              <>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {selectedResult.prompt}
                </p>
                <p className="text-ui-sm text-foreground-subtle" role="status">
                  {text[selectedResult.status]}{" "}
                  {selectedResult.errorCode && selectedResult.errorCode !== "outcome_unknown"
                    ? imageServiceError(text, { code: selectedResult.errorCode })
                    : ""}
                </p>
                {selectedResult.asset && service ? (
                  <div className="flex flex-wrap gap-2">
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid="genimage-view-original"
                        >
                          {text.viewOriginal}
                        </Button>
                      </DialogTrigger>
                      <DialogContent
                        className="max-h-[calc(100dvh-2rem)] max-w-5xl overflow-auto motion-reduce:animate-none"
                        aria-describedby={undefined}
                      >
                        <DialogTitle className="pr-10">{text.viewOriginal}</DialogTitle>
                        <OriginalImage
                          key={selectedResult.asset.id}
                          service={service}
                          assetId={selectedResult.asset.id}
                          alt={selectedResult.prompt}
                          text={text}
                        />
                      </DialogContent>
                    </Dialog>
                    {saveFile ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid="genimage-export"
                        disabled={exporting}
                        onClick={() => void exportOriginal(selectedResult.asset!.id)}
                      >
                        {text.export}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </div>
      {feedback ? (
        <p
          role={feedback.error ? "alert" : "status"}
          className={`border-t border-border bg-card px-3 py-2 text-ui-sm ${feedback.error ? "text-destructive" : "text-foreground"}`}
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
