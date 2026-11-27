import { GitFork, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HTMLAttributes, Ref } from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { GENIMAGE_BOARD_NODE_LIMIT } from "./contract.js";
import { MAX_NODES, ratios, type Ratio } from "./fixture.js";
import { GenImageArtwork, nodeLabel, type CanvasNode } from "./GenImageArtwork.js";
import type { GenImageText } from "./text.js";
import type { GenImageMedia } from "./useGenImageLocal.js";

export type PanelKind = "create" | "details" | "history" | "settings" | "help";

interface GenImagePanelProps {
  kind: PanelKind;
  text: GenImageText;
  nodes: readonly CanvasNode[];
  source?: CanvasNode;
  selected?: CanvasNode;
  media?: GenImageMedia;
  generating: boolean;
  generateError: boolean;
  prompt: string;
  ratio: Ratio;
  panelId: string;
  promptRef: Ref<HTMLTextAreaElement>;
  closeRef: Ref<HTMLButtonElement>;
  onChangePrompt(value: string): void;
  onChangeRatio(value: Ratio): void;
  onClose(): void;
  onSubmit(): void;
  onDerive(id: string, trigger: HTMLButtonElement): void;
  onLocate(id: string, close: boolean): void;
}

export function FixtureBadge({ children }: Pick<HTMLAttributes<HTMLSpanElement>, "children">) {
  return <span className="gi-badge">{children}</span>;
}

function OriginalImage({
  node,
  load,
  text,
}: {
  node: CanvasNode;
  load: GenImageMedia["original"];
  text: GenImageText;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void load(node.id).then(
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
  }, [load, node.id]);

  if (failed) return <p role="alert">{text.assetFailed}</p>;
  if (!url) return <p role="status">{text.assetLoading}</p>;
  return (
    <img
      className="mx-auto max-h-[75vh] max-w-full rounded-xl object-contain"
      src={url}
      alt={node.title}
      data-testid="genimage-original"
      onError={() => setFailed(true)}
    />
  );
}

function LocalImageActions({
  node,
  media,
  text,
}: {
  node: CanvasNode;
  media: GenImageMedia;
  text: GenImageText;
}) {
  const exporting = useRef(false);
  const [exportStatus, setExportStatus] = useState<"busy" | "done" | "failed">();

  async function exportImage() {
    if (!media.exportPng || exporting.current) return;
    exporting.current = true;
    setExportStatus("busy");
    try {
      const result = await media.exportPng(node.id);
      setExportStatus(result.canceled ? undefined : result.success ? "done" : "failed");
    } catch {
      setExportStatus("failed");
    } finally {
      exporting.current = false;
    }
  }

  return (
    <>
      <div className="gi-form-grid">
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" data-testid="genimage-preview">
              {text.preview}
            </Button>
          </DialogTrigger>
          <DialogContent
            className="sm:max-w-3xl"
            data-testid="genimage-original-dialog"
            aria-describedby={undefined}
          >
            <DialogTitle className="pr-8 wrap-anywhere">{node.title}</DialogTitle>
            <OriginalImage node={node} load={media.original} text={text} />
          </DialogContent>
        </Dialog>
        <Button
          type="button"
          variant="outline"
          disabled={!media.exportPng || exportStatus === "busy"}
          data-testid="genimage-export"
          onClick={() => void exportImage()}
        >
          {exportStatus === "busy" ? text.exporting : text.export}
        </Button>
      </div>
      {exportStatus === "done" || exportStatus === "failed" ? (
        <p role={exportStatus === "failed" ? "alert" : "status"} className="gi-caption">
          {exportStatus === "done" ? text.exported : text.exportFailed}
        </p>
      ) : null}
    </>
  );
}

export function GenImagePanel({
  kind,
  text,
  nodes,
  source,
  selected,
  media,
  generating,
  generateError,
  prompt,
  ratio,
  panelId,
  promptRef,
  closeRef,
  onChangePrompt,
  onChangeRatio,
  onClose,
  onSubmit,
  onDerive,
  onLocate,
}: GenImagePanelProps) {
  const title = kind === "create" ? (source ? text.deriveTitle : text.newTitle) : text[kind];
  const dataNote = media ? text.localDataNote : text.dataNote;
  const modelName = media ? text.localProvider : text.fixtureModel;
  const badge = media ? text.localMode : text.fixture;
  const atNodeLimit = nodes.length >= (media ? GENIMAGE_BOARD_NODE_LIMIT : MAX_NODES);
  const selectedSource = selected?.source && nodes.find((node) => node.id === selected.source);
  return (
    <section
      className="gi-float gi-panel"
      role="dialog"
      aria-labelledby={panelId}
      data-testid="genimage-panel"
    >
      <header className="gi-panel-header">
        <h2 id={panelId}>
          {title}
          {kind === "history" ? <FixtureBadge>{nodes.length}</FixtureBadge> : null}
        </h2>
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={text.close}
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {kind === "create" ? (
        <form
          className="gi-panel-body"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {source ? (
            <div className="gi-source" data-testid="genimage-source" data-source={source.id}>
              <GenImageArtwork
                node={source}
                className="gi-source-art"
                loadThumbnail={media?.thumbnail}
              />
              <div>
                <strong>
                  {text.source} {nodeLabel(source)} · {source.title}
                </strong>
                <p>{text.sourceNote}</p>
              </div>
            </div>
          ) : null}
          <label className="gi-field">
            {source ? text.editPrompt : text.prompt}
            <Textarea
              ref={promptRef}
              className="gi-prompt"
              value={prompt}
              placeholder={text.placeholder}
              maxLength={media ? 4000 : undefined}
              readOnly={generating}
              onChange={(event) => onChangePrompt(event.currentTarget.value)}
              data-testid="genimage-prompt"
            />
            <span className="gi-caption">{text.formNote}</span>
          </label>
          <div className="gi-form-grid">
            <label className="gi-field">
              {text.model}
              <Input value={modelName} readOnly />
            </label>
            <div className="gi-field">
              <span>{text.ratio}</span>
              <div className="gi-ratios" role="group" aria-label={text.ratio}>
                {ratios.map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-pressed={ratio === value}
                    disabled={generating}
                    onClick={() => onChangeRatio(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <p className="gi-notice">{dataNote}</p>
          {generateError ? (
            <p role="alert" className="text-destructive">
              {text.localGenerateFailed}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={generating || !prompt.trim() || atNodeLimit}
            data-testid="genimage-submit"
          >
            {source ? <GitFork /> : <Plus />}
            {generating ? text.localGenerating : source ? text.submitDerive : text.submit}
          </Button>
          {!media ? (
            <p className="gi-caption">{text.limit(MAX_NODES)}</p>
          ) : atNodeLimit ? (
            <p className="gi-caption">{text.localLimit(GENIMAGE_BOARD_NODE_LIMIT)}</p>
          ) : null}
        </form>
      ) : null}
      {kind === "details" && selected ? (
        <div className="gi-panel-body">
          <GenImageArtwork
            node={selected}
            className="gi-detail-art"
            loadThumbnail={media?.thumbnail}
          />
          <div>
            <h3>
              {nodeLabel(selected)} · {selected.title}
            </h3>
            <p className="gi-caption wrap-anywhere">{selected.prompt}</p>
          </div>
          <dl className="gi-settings">
            <dt>{text.ratio}</dt>
            <dd>{selected.ratio}</dd>
            <dt>{text.model}</dt>
            <dd>{modelName}</dd>
          </dl>
          <div>
            <p className="gi-caption">{text.lineage}</p>
            <div className="gi-relations">
              {selectedSource ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onLocate(selectedSource.id, false)}
                >
                  {text.source} {nodeLabel(selectedSource)}
                </Button>
              ) : (
                <span>{text.root}</span>
              )}
              {nodes
                .filter((node) => node.source === selected.id)
                .map((node) => (
                  <Button
                    key={node.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onLocate(node.id, false)}
                  >
                    {nodeLabel(node)} · {node.title}
                  </Button>
                ))}
            </div>
          </div>
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={generating}
            onClick={(event) => onDerive(selected.id, event.currentTarget)}
          >
            <GitFork />
            {text.derive}
          </Button>
          {media ? (
            <LocalImageActions key={selected.id} node={selected} media={media} text={text} />
          ) : (
            <div className="gi-form-grid">
              <Button variant="outline" disabled>
                {text.export}
              </Button>
              <Button variant="outline" disabled>
                {text.reference}
              </Button>
            </div>
          )}
          <p className="gi-caption">{dataNote}</p>
        </div>
      ) : null}
      {kind === "history" ? (
        <div className="gi-panel-body gi-history">
          <p className="gi-caption">{media ? text.localHistory : text.historyNote}</p>
          {media && !nodes.length ? <p className="gi-caption">{text.localEmpty}</p> : null}
          <ol>
            {nodes.toReversed().map((node) => (
              <li key={node.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="gi-history-row"
                  data-genimage-history={node.id}
                  onClick={() => onLocate(node.id, true)}
                >
                  <GenImageArtwork
                    node={node}
                    className="gi-history-art"
                    loadThumbnail={media?.thumbnail}
                  />
                  <span>
                    <strong>
                      {nodeLabel(node)} · {node.title}
                    </strong>
                    <span className="gi-caption">
                      {node.source ? `${text.derived} ${node.source.slice(0, 8)}` : text.root} ·{" "}
                      {node.ratio}
                    </span>
                  </span>
                  <FixtureBadge>{badge}</FixtureBadge>
                </Button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {kind === "settings" ? (
        <div className="gi-panel-body">
          <dl className="gi-settings">
            <dt>{text.mode}</dt>
            <dd>{badge}</dd>
            <dt>{text.provider}</dt>
            <dd>{media ? text.localProvider : text.notConnected}</dd>
            <dt>{text.appearance}</dt>
            <dd>{text.followsApp}</dd>
          </dl>
          <p className="gi-notice">{dataNote}</p>
          {!media ? <p className="gi-caption">{text.reset}</p> : null}
        </div>
      ) : null}
      {kind === "help" ? (
        <dl className="gi-panel-body gi-settings gi-shortcuts">
          {[
            [text.pan, text.dragBlank],
            [text.drag, text.dragNode],
            [`${text.zoomIn} / ${text.zoomOut}`, "+ / −"],
            [text.fit, "0"],
            [text.create, "N"],
            [text.select, "Tab / Enter"],
            [text.navigate, "← / →"],
            [text.nudge, "Shift + ↑↓←→"],
            [text.close, "Esc"],
          ].map(([label, shortcut]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <kbd>{shortcut}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
