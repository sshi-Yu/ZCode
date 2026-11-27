import { Plus, X } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  GENIMAGE_BOARD_NODE_LIMIT,
  type FeatureModelSettingsView,
  type ImageModelView,
} from "./contract.js";
import { GenImageArtwork, nodeLabel, type CanvasNode } from "./GenImageArtwork.js";
import type { GenImageText } from "./text.js";
import type { GenImageMedia } from "./useGenImageLocal.js";

export type PanelKind = "create" | "details" | "history" | "settings" | "help";

interface GenImagePanelProps {
  kind: PanelKind;
  text: GenImageText;
  nodes: readonly CanvasNode[];
  selected?: CanvasNode;
  media?: GenImageMedia;
  generating: boolean;
  generateError: string;
  imageModel?: ImageModelView;
  featureModel?: FeatureModelSettingsView;
  prompt: string;
  panelId: string;
  promptRef: Ref<HTMLTextAreaElement>;
  closeRef: Ref<HTMLButtonElement>;
  onRefreshModel(): void;
  onNewRequest(): void;
  onChangePrompt(value: string): void;
  onClose(): void;
  onSubmit(): void;
  onPreview(id: string, trigger: HTMLElement, showFeatures?: boolean): void;
  onLocate(id: string, close: boolean): void;
  onOpenSettings?: () => void;
}

export function CanvasBadge({ children }: { children: ReactNode }) {
  return <span className="gi-badge">{children}</span>;
}

function generationError(code: string, text: GenImageText) {
  if (code.endsWith("revision-conflict")) return text.liveChanged;
  if (code.endsWith("authentication") || code.endsWith("key-required"))
    return text.liveAuthentication;
  if (code.endsWith("quota")) return text.liveQuota;
  if (code.endsWith("response-invalid")) return text.liveInvalid;
  if (code.endsWith("rejected")) return text.liveRejected;
  if (code.endsWith("destination-unavailable")) return text.liveDestination;
  return text.liveUnknown;
}

export function GenImagePanel(props: GenImagePanelProps) {
  const {
    kind,
    text,
    nodes,
    selected,
    media,
    generating,
    generateError,
    imageModel,
    featureModel,
    onOpenSettings,
  } = props;
  const confirm = useConfirmDialog();
  const atNodeLimit = nodes.length >= GENIMAGE_BOARD_NODE_LIMIT;
  return (
    <section
      className="gi-float gi-panel"
      role="dialog"
      aria-labelledby={props.panelId}
      data-testid="genimage-panel"
    >
      <header className="gi-panel-header">
        <h2 id={props.panelId}>
          {kind === "create" ? text.create : text[kind]}
          {kind === "history" ? <CanvasBadge>{nodes.length}</CanvasBadge> : null}
        </h2>
        <Button
          ref={props.closeRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={text.close}
          onClick={props.onClose}
        >
          <X />
        </Button>
      </header>
      {kind === "create" ? (
        <form
          className="gi-panel-body"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSubmit();
          }}
        >
          <label className="gi-field">
            {text.prompt}
            <Textarea
              ref={props.promptRef}
              className="gi-prompt"
              value={props.prompt}
              placeholder={text.placeholder}
              maxLength={4000}
              readOnly={generating}
              onChange={(event) => props.onChangePrompt(event.currentTarget.value)}
              data-testid="genimage-prompt"
            />
          </label>
          <dl className="gi-settings">
            <dt>{text.model}</dt>
            <dd className="wrap-anywhere">{imageModel?.name ?? text.notConnected}</dd>
            {imageModel ? (
              <>
                <dt>{text.liveSize}</dt>
                <dd>
                  {imageModel.size || "auto"} · {imageModel.quality || "auto"}
                </dd>
              </>
            ) : null}
          </dl>
          {imageModel ? (
            <p className="gi-caption wrap-anywhere">
              {new URL(imageModel.baseUrl).host} · {imageModel.modelId}
            </p>
          ) : null}
          {!imageModel?.configured ? (
            <p role="status" data-testid="genimage-model-unavailable">
              {text.liveUnavailable}
            </p>
          ) : null}
          <div className="gi-form-grid">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={generating}
              onClick={props.onRefreshModel}
            >
              {text.refreshModel}
            </Button>
            {onOpenSettings ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
                {text.openModelSettings}
              </Button>
            ) : null}
          </div>
          <p className="gi-notice">{text.liveNote}</p>
          {generateError ? (
            <>
              <p role="alert" className="text-destructive">
                {generationError(generateError, text)}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={generating}
                data-testid="genimage-new-request"
                onClick={() =>
                  void confirm({
                    title: text.liveNewRequest,
                    description: text.liveNewRequestConfirm,
                  }).then((confirmed) => {
                    if (confirmed) props.onNewRequest();
                  })
                }
              >
                {text.liveNewRequest}
              </Button>
            </>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={generating || !props.prompt.trim() || atNodeLimit || !imageModel?.configured}
            data-testid="genimage-submit"
          >
            <Plus />
            {generating ? text.localGenerating : text.create}
          </Button>
          {atNodeLimit ? (
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
          <h3 className="wrap-anywhere">{selected.fileName ?? selected.title}</h3>
          <p className="gi-caption wrap-anywhere">{selected.prompt}</p>
          <dl className="gi-settings">
            <dt>{text.dimensions}</dt>
            <dd>
              {selected.width} × {selected.height}
            </dd>
            <dt>{text.origin}</dt>
            <dd>{selected.fileName ? text.imported : (selected.modelName ?? text.generated)}</dd>
          </dl>
          <Button
            type="button"
            variant="outline"
            onClick={(event) => props.onPreview(selected.id, event.currentTarget)}
          >
            {text.preview}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={(event) => props.onPreview(selected.id, event.currentTarget, true)}
          >
            {text.features}
          </Button>
        </div>
      ) : null}
      {kind === "history" ? (
        <div className="gi-panel-body gi-history">
          <p className="gi-caption">{nodes.length ? text.localHistory : text.localEmpty}</p>
          <ol>
            {nodes.toReversed().map((node) => (
              <li key={node.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="gi-history-row"
                  data-genimage-history={node.id}
                  onClick={() => props.onLocate(node.id, true)}
                >
                  <GenImageArtwork
                    node={node}
                    className="gi-history-art"
                    loadThumbnail={media?.thumbnail}
                  />
                  <span className="min-w-0">
                    <strong className="truncate">
                      {nodeLabel(node)} · {node.fileName ?? node.title}
                    </strong>
                    <span className="gi-caption">
                      {node.width} × {node.height}
                    </span>
                  </span>
                  <CanvasBadge>{node.fileName ? text.imported : text.generated}</CanvasBadge>
                </Button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {kind === "settings" ? (
        <div className="gi-panel-body">
          <dl className="gi-settings">
            <dt>{text.model}</dt>
            <dd>{imageModel?.name ?? text.notConnected}</dd>
            <dt>{text.featureModel}</dt>
            <dd className="wrap-anywhere">
              {featureModel?.selection
                ? `${featureModel.selection.providerId} / ${featureModel.selection.modelId}`
                : text.notConnected}
            </dd>
            <dt>{text.appearance}</dt>
            <dd>{text.followsApp}</dd>
          </dl>
          {onOpenSettings ? (
            <Button type="button" variant="outline" onClick={onOpenSettings}>
              {text.openModelSettings}
            </Button>
          ) : null}
          <p className="gi-notice">{text.localSaved}</p>
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
            [text.preview, "Tab / Enter"],
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
