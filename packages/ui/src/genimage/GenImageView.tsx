import {
  ImagePlus,
  History,
  Info,
  Maximize,
  Minus,
  Plus,
  ScanEye,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GenImageViewProps, IGenImageService } from "./contract.js";
import { GenImageArtwork, nodeLabel, type CanvasNode } from "./GenImageArtwork.js";
import { CanvasBadge, GenImagePanel, type PanelKind } from "./GenImagePanel.js";
import { genImageText } from "./text.js";
import {
  useGenImageLocal,
  useGenImageService,
  useGenImageModel,
  useGenImageFeatureModel,
} from "./useGenImageLocal.js";
import { GenImagePreview } from "./GenImagePreview.js";
import { fitCamera, NODE_HEIGHT, NODE_WIDTH, zoomCamera, type Camera } from "./canvasGeometry.js";
import "./genimage.css";

interface Panel {
  kind: PanelKind;
  trigger: HTMLElement | null;
}
interface Drag {
  pointer: number;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
  node?: CanvasNode;
  scale: number;
  moved: boolean;
}

function edgePaths(parent: CanvasNode, child: CanvasNode, scale: number) {
  const deltaX = child.x - parent.x;
  const deltaY = child.y - parent.y;
  const horizontal = Math.abs(deltaX) > NODE_WIDTH;
  const span = horizontal ? NODE_WIDTH : NODE_HEIGHT;
  const delta = horizontal ? deltaX : deltaY;
  const gap = Math.abs(delta) - span;
  if (gap <= 0) return;

  const direction = Math.sign(delta);
  const start = (horizontal ? parent.x : parent.y) + (direction > 0 ? span : 0);
  const end = start + direction * (gap - Math.min(8, gap / 4));
  const crossSpan = (horizontal ? NODE_HEIGHT : NODE_WIDTH) / 2;
  const from = (horizontal ? parent.y : parent.x) + crossSpan;
  const to = (horizontal ? child.y : child.x) + crossSpan;
  const point = (axis: number, cross: number) =>
    horizontal ? `${axis} ${cross}` : `${cross} ${axis}`;
  // 短间距时固定控制柄会越过端点，导致连线在箭头前倒弯。
  const bend = direction * Math.min(120, Math.abs(end - start) / 2);
  const arrowLength = Math.min(8 / scale, Math.abs(end - start) / 2);
  const arrowWidth = arrowLength * 0.55;
  const base = end - direction * arrowLength;
  return {
    line: `M${point(start, from)} C${point(start + bend, from)} ${point(end - bend, to)} ${point(end, to)}`,
    arrow: `M${point(base, to - arrowWidth)} L${point(end, to)} ${point(base, to + arrowWidth)}`,
  };
}

function nextPosition(nodes: readonly CanvasNode[]) {
  const x = nodes.length ? Math.max(...nodes.map((node) => node.x)) + 360 : 0;
  let y = 184;
  while (
    nodes.some(
      (node) => Math.abs(node.x - x) < NODE_WIDTH + 16 && Math.abs(node.y - y) < NODE_HEIGHT + 16,
    )
  )
    y += NODE_HEIGHT + 48;
  return { x, y };
}

export function GenImageView(props: GenImageViewProps) {
  const service = useGenImageService();
  return (
    <GenImageCanvas
      key={props.localScope}
      {...props}
      localService={props.localScope === undefined ? undefined : service}
    />
  );
}

function GenImageCanvas({
  windowControls,
  sidebarCollapsed,
  localService,
  localScope = "",
  localScopeName,
  onOpenModelSettings,
}: GenImageViewProps & {
  localService?: IGenImageService;
}) {
  const { locale } = useZCodeIntl();
  const text = genImageText(locale);
  const local = useGenImageLocal(localService, localScope);
  const imageModel = useGenImageModel(!!localService);
  const featureModel = useGenImageFeatureModel(!!localService);
  const ready = local.ready;
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    trigger: HTMLElement;
    showFeatures?: boolean;
  }>();
  const [dragging, setDragging] = useState(false);
  const [dragPosition, setDragPosition] = useState<{ id: string; x: number; y: number }>();
  const [announcement, setAnnouncement] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const currentPanel = useRef<Panel | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const framed = useRef(false);
  const panelId = useId();
  const nodes: readonly CanvasNode[] = local.nodes.map((node) =>
    node.id === dragPosition?.id ? { ...node, x: dragPosition.x, y: dragPosition.y } : node,
  );
  const selected = nodes.find((node) => node.id === selectedId);
  const previewNode = nodes.find((node) => node.id === preview?.id);
  const nodeIndex = new Map(nodes.map((node) => [node.id, node]));

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || framed.current || !ready) return;
    framed.current = true;
    setCamera(fitCamera(nodes, element.clientWidth, element.clientHeight, false));
  }, [nodes, ready]);

  useEffect(() => {
    if (panel)
      (panel.kind === "create" ? promptInput : closeButton).current?.focus({ preventScroll: true });
  }, [panel]);

  useEffect(() => {
    if (!announcement) return;
    const timeout = window.setTimeout(() => setAnnouncement(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [announcement]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003);
      setCamera((previous) =>
        zoomCamera(previous, factor, event.clientX - bounds.left, event.clientY - bounds.top),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  function fit() {
    const element = viewport.current;
    if (element) setCamera(fitCamera(nodes, element.clientWidth, element.clientHeight, false));
  }

  function zoom(factor: number) {
    const element = viewport.current;
    if (!element) return;
    const { clientWidth, clientHeight } = element;
    setCamera((previous) => zoomCamera(previous, factor, clientWidth / 2, clientHeight / 2));
  }

  function findNodeElement(id: string) {
    return viewport.current?.querySelector<HTMLElement>(`[data-genimage-node="${CSS.escape(id)}"]`);
  }

  function centerNode(node: CanvasNode, panelOpen: boolean) {
    const element = viewport.current;
    if (!element) return;
    const { clientWidth, clientHeight } = element;
    const wide = clientWidth >= 640;
    const visibleWidth = panelOpen && wide ? clientWidth - 370 : clientWidth;
    const visibleHeight = panelOpen && !wide ? clientHeight * 0.55 : clientHeight;
    setCamera((previous) => ({
      ...previous,
      x: visibleWidth / 2 - (node.x + NODE_WIDTH / 2) * previous.scale,
      y: visibleHeight / 2 - (node.y + NODE_HEIGHT / 2) * previous.scale,
    }));
  }

  function locate(id: string, close = false, focus = false) {
    const node = nodeIndex.get(id);
    if (!node) return;
    setSelectedId(id);
    if (close) changePanel(null);
    centerNode(node, !!panel && !close);
    if (close || focus) findNodeElement(id)?.focus({ preventScroll: true });
  }

  function changePanel(next: Panel | null) {
    currentPanel.current = next;
    setPanel(next);
  }

  function closePanel() {
    changePanel(null);
    if (panel?.trigger?.isConnected) panel.trigger.focus({ preventScroll: true });
    else if (selectedId) findNodeElement(selectedId)?.focus({ preventScroll: true });
  }

  function togglePanel(kind: PanelKind, trigger: HTMLElement | null) {
    if (panel?.kind === kind) closePanel();
    else changePanel({ kind, trigger });
  }

  function commitPosition(node: CanvasNode, x: number, y: number) {
    if (node.x === x && node.y === y) return;
    local.moveNode(node, { x, y });
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    const { target, currentTarget } = event;
    if (
      drag.current ||
      event.button !== 0 ||
      !(target instanceof Element) ||
      target.closest("button")
    )
      return;
    const nodeElement = target.closest<HTMLElement>("[data-genimage-node]");
    const node = nodeIndex.get(nodeElement?.dataset.genimageNode ?? "");
    drag.current = {
      pointer: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: node?.x ?? camera.x,
      y: node?.y ?? camera.y,
      node,
      scale: camera.scale,
      moved: false,
    };
    if (nodeElement) nodeElement.focus({ preventScroll: true });
    else currentTarget.focus({ preventScroll: true });
    currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.clientX;
    const dy = event.clientY - current.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
    if (!current.moved) return;
    if (current.node) {
      const x = current.x + dx / current.scale;
      const y = current.y + dy / current.scale;
      setDragPosition({ id: current.node.id, x, y });
    } else setCamera((previous) => ({ ...previous, x: current.x + dx, y: current.y + dy }));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setDragPosition(undefined);
    if (current.node && current.moved && event.type === "pointerup") {
      commitPosition(
        current.node,
        current.x + (event.clientX - current.clientX) / current.scale,
        current.y + (event.clientY - current.clientY) / current.scale,
      );
    }
    if (!current.node && !current.moved && event.type === "pointerup" && panel?.kind !== "details")
      setSelectedId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function submit() {
    const description = prompt.trim();
    if (
      !description ||
      !ready ||
      panel?.kind !== "create" ||
      imageModel.revision === undefined ||
      !imageModel.model?.configured
    )
      return;
    const first = nodes.length === 0;
    const element = viewport.current;
    if (!element) return;
    const position = first
      ? {
          x: (element.clientWidth / 2 - camera.x) / camera.scale - NODE_WIDTH / 2,
          y: (element.clientHeight / 2 - camera.y) / camera.scale - NODE_HEIGHT / 2,
        }
      : nextPosition(nodes);
    const node = await local.generate({
      ...position,
      prompt: description,
      modelRevision: imageModel.revision,
    });
    if (!node || !viewport.current) return;
    setAnnouncement(text.liveAdded(nodeLabel(node)));
    if (currentPanel.current !== panel) return;
    const formHadFocus = promptInput.current?.form?.contains(document.activeElement);
    setPrompt("");
    changePanel(null);
    if (first) {
      const { clientWidth, clientHeight } = element;
      setCamera((previous) => {
        const left = previous.x + node.x * previous.scale;
        const top = previous.y + node.y * previous.scale;
        const right = left + NODE_WIDTH * previous.scale;
        const bottom = top + NODE_HEIGHT * previous.scale;
        if (left >= 0 && top >= 0 && right <= clientWidth && bottom <= clientHeight) {
          return previous;
        }
        return fitCamera([node], clientWidth, clientHeight, false);
      });
    }
    if (formHadFocus) {
      if (panel.trigger?.isConnected) panel.trigger.focus({ preventScroll: true });
      else viewport.current.focus({ preventScroll: true });
    }
  }

  async function importFiles(files: File[]) {
    const element = viewport.current;
    if (!element || !files.length) return;
    const stepX = NODE_WIDTH + 48;
    const stepY = NODE_HEIGHT + 48;
    const columns = Math.max(
      1,
      Math.min(files.length, 4, Math.floor(element.clientWidth / camera.scale / stepX)),
    );
    const left = (element.clientWidth / 2 - camera.x) / camera.scale - (columns * stepX - 48) / 2;
    const top = (element.clientHeight / 2 - camera.y) / camera.scale - NODE_HEIGHT / 2;
    let slot = 0;
    const result = await local.importFiles(files, () => {
      let position: Pick<Camera, "x" | "y">;
      do {
        position = {
          x: left + (slot % columns) * stepX,
          y: top + Math.floor(slot / columns) * stepY,
        };
        slot += 1;
      } while (
        nodes.some(
          (node) =>
            Math.abs(node.x - position.x) < NODE_WIDTH + 16 &&
            Math.abs(node.y - position.y) < NODE_HEIGHT + 16,
        )
      );
      return position;
    });
    if (!result) return;
    setAnnouncement(text.importResult(result.imported.length, result.failed));
    const { clientWidth, clientHeight } = element;
    if (
      result.imported.some((node) => {
        const left = camera.x + node.x * camera.scale;
        const top = camera.y + node.y * camera.scale;
        return (
          left < 0 ||
          top < 0 ||
          left + NODE_WIDTH * camera.scale > clientWidth ||
          top + NODE_HEIGHT * camera.scale > clientHeight
        );
      })
    ) {
      setCamera((current) =>
        current === camera ? fitCamera(result.imported, clientWidth, clientHeight, false) : current,
      );
    }
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const { key, target } = event;
    if (preview || !(target instanceof Node) || !event.currentTarget.contains(target)) return;
    if (key === "Escape" && panel) {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      return;
    }
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (target instanceof Element && target.closest("input,textarea,select"))
    )
      return;
    if (key === "+" || key === "=") zoom(1.2);
    else if (key === "-") zoom(1 / 1.2);
    else if (key === "0" || key === "Home") fit();
    else if (key.toLowerCase() === "n" && ready && !local.generating)
      changePanel({ kind: "create", trigger: newButton.current });
    else if (key === "?") togglePanel("help", helpButton.current);
    else if (selected && key.startsWith("Arrow") && viewport.current?.contains(target)) {
      if (event.shiftKey) {
        const dx = key === "ArrowRight" ? 16 : key === "ArrowLeft" ? -16 : 0;
        const dy = key === "ArrowDown" ? 16 : key === "ArrowUp" ? -16 : 0;
        if (!drag.current) commitPosition(selected, selected.x + dx, selected.y + dy);
      } else {
        const index = nodes.indexOf(selected);
        const next =
          key === "ArrowLeft"
            ? selected.source
            : key === "ArrowRight"
              ? nodes.find((node) => node.source === selected.id)?.id
              : nodes[(index + (key === "ArrowDown" ? 1 : nodes.length - 1)) % nodes.length]?.id;
        if (next) locate(next, false, true);
      }
    } else return;
    event.preventDefault();
  }

  function openPreview(id: string, trigger: HTMLElement, showFeatures = false) {
    setPreview({ id, trigger, showFeatures });
    featureModel.refresh();
  }
  const localScopeLabel =
    localScopeName?.trim() || (localScope ? text.workspace : text.localPersonal);

  return (
    <main
      className="genimage-view"
      data-testid="genimage-workspace"
      data-sidebar-collapsed={sidebarCollapsed}
      aria-label={text.moduleName}
      onKeyDown={keyDown}
    >
      <div
        ref={viewport}
        className="gi-viewport"
        data-testid="genimage-viewport"
        data-dragging={dragging}
        tabIndex={-1}
        aria-label={text.canvas}
        style={{
          backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px`,
          backgroundPosition: `${camera.x}px ${camera.y}px`,
        }}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div
          className="gi-world"
          style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}
        >
          <svg className="gi-edges" aria-hidden="true">
            {nodes.map((node) => {
              const parent = node.source && nodeIndex.get(node.source);
              if (!parent) return null;
              const paths = edgePaths(parent, node, camera.scale);
              if (!paths) return null;
              return (
                <g key={node.id} data-related={node.id === selectedId || parent.id === selectedId}>
                  <path data-genimage-edge={node.id} data-source={parent.id} d={paths.line} />
                  <path data-genimage-arrow={node.id} d={paths.arrow} />
                </g>
              );
            })}
          </svg>
          {nodes.map((node) => (
            <article
              key={node.id}
              className="gi-node"
              data-genimage-node={node.id}
              data-source={node.source ?? ""}
              data-genimage-x={node.x}
              data-genimage-y={node.y}
              data-genimage-version={node.version}
              data-selected={node.id === selectedId}
              tabIndex={0}
              aria-label={`${nodeLabel(node)} · ${node.title}`}
              style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
              onFocus={() => setSelectedId(node.id)}
              onKeyDown={(event) => {
                if (
                  event.currentTarget === event.target &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  openPreview(node.id, event.currentTarget);
                }
              }}
            >
              <header>
                <span>
                  <code>{nodeLabel(node)}</code>{" "}
                  {node.source ? `${text.derived} ${node.source.slice(0, 8)}` : text.root}
                </span>
                <CanvasBadge>{node.fileName ? text.imported : text.generated}</CanvasBadge>
              </header>
              <GenImageArtwork
                node={node}
                className="gi-node-art"
                loadThumbnail={local.media?.thumbnail}
              />
              <footer>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate">{node.fileName ?? node.title}</h3>
                  <p>
                    {node.width} × {node.height}
                  </p>
                  {node.features ? (
                    <ul className="gi-tags" aria-label={text.features}>
                      {node.features.tags.slice(0, 3).map((tag) => (
                        <li key={tag} title={tag}>
                          {tag}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  type="button"
                  aria-label={text.preview}
                  data-testid="genimage-preview"
                  onClick={(event) => openPreview(node.id, event.currentTarget)}
                >
                  <Maximize />
                </Button>
              </footer>
              {node.id === selectedId ? (
                <div className="gi-float gi-node-actions" style={{ scale: 1 / camera.scale }}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={text.details}
                    data-testid="genimage-details"
                    onClick={(event) => togglePanel("details", event.currentTarget)}
                  >
                    <Info />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={text.features}
                    data-testid="genimage-card-features"
                    onClick={(event) => openPreview(node.id, event.currentTarget, true)}
                  >
                    <ScanEye />
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>
      <header className="gi-top">
        <div className="gi-float gi-toolbar gi-brand">
          <h1>{text.moduleName}</h1>
          <i aria-hidden="true" />
          <Button
            type="button"
            variant="outline"
            aria-label={text.importAsset}
            data-testid="genimage-import"
            disabled={!ready || local.importing}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus />
            <span>{text.importAsset}</span>
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/png,image/jpeg"
            className="sr-only"
            tabIndex={-1}
            aria-label={text.importAsset}
            data-testid="genimage-file-input"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void importFiles(files);
            }}
          />
          <Button
            ref={newButton}
            type="button"
            size="lg"
            aria-label={text.create}
            data-testid="genimage-new"
            disabled={!ready || local.generating}
            onClick={(event) => changePanel({ kind: "create", trigger: event.currentTarget })}
          >
            <Plus />
            <span>{text.create}</span>
          </Button>
        </div>
        <div className="gi-float gi-toolbar gi-top-actions">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            aria-label={text.history}
            aria-expanded={panel?.kind === "history"}
            data-testid="genimage-history"
            disabled={!ready}
            onClick={(event) => togglePanel("history", event.currentTarget)}
          >
            <History />
            <span>{text.history}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            aria-label={text.settings}
            aria-expanded={panel?.kind === "settings"}
            data-testid="genimage-settings"
            onClick={(event) => togglePanel("settings", event.currentTarget)}
          >
            <SlidersHorizontal />
            <span>{text.settings}</span>
          </Button>
        </div>
        {windowControls}
      </header>
      <div className="gi-note">
        <p>{localScopeLabel}</p>
        <p>{text.localSaved}</p>
        {local.unconfirmed > 0 ? <p role="status">{text.livePending}</p> : null}
      </div>
      {!ready || !nodes.length ? (
        <div className="gi-empty">
          <p
            role={local.loadError ? "alert" : "status"}
            data-testid={ready ? "genimage-empty" : "genimage-loading"}
          >
            {ready
              ? text.localEmpty
              : !localService || local.loadError
                ? text.localLoadFailed
                : text.localLoading}
          </p>
          {!ready && local.loadError ? (
            <Button type="button" variant="outline" onClick={local.reload}>
              {text.localRetry}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="gi-float gi-toolbar gi-zoom">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={text.zoomOut}
          onClick={() => zoom(1 / 1.2)}
        >
          <Minus />
        </Button>
        <output data-testid="genimage-zoom">{Math.round(camera.scale * 100)}%</output>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={text.zoomIn}
          onClick={() => zoom(1.2)}
        >
          <Plus />
        </Button>
        <i aria-hidden="true" />
        <Button
          type="button"
          variant="ghost"
          aria-label={text.fit}
          data-testid="genimage-fit"
          onClick={fit}
        >
          <Maximize />
          <span>{text.fit}</span>
        </Button>
      </div>
      <p className="gi-gesture">{text.gesture}</p>
      <div className="gi-float gi-toolbar gi-status">
        <i aria-hidden="true" />
        <span>{text.localSaved}</span>
        <Button
          ref={helpButton}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={text.help}
          onClick={(event) => togglePanel("help", event.currentTarget)}
        >
          <Info />
        </Button>
      </div>
      {panel ? (
        <GenImagePanel
          kind={panel.kind}
          text={text}
          nodes={nodes}
          selected={selected}
          media={local.media}
          generating={local.generating}
          generateError={local.generateError}
          imageModel={imageModel.model}
          onRefreshModel={imageModel.refresh}
          onNewRequest={local.resetRequest}
          prompt={prompt}
          panelId={panelId}
          promptRef={promptInput}
          closeRef={closeButton}
          onChangePrompt={setPrompt}
          onClose={closePanel}
          onSubmit={() => void submit()}
          onPreview={openPreview}
          featureModel={featureModel.settings}
          onOpenSettings={onOpenModelSettings}
          onLocate={locate}
        />
      ) : null}
      {preview && previewNode && local.media ? (
        <GenImagePreview
          key={preview.id}
          node={previewNode}
          initialDetails={preview.showFeatures}
          media={local.media}
          text={text}
          trigger={preview.trigger}
          onClose={() => setPreview(undefined)}
          featureModel={featureModel.settings}
          pending={local.featurePending}
          error={local.featureError?.id === preview.id ? local.featureError.code : undefined}
          onExtract={(revision, routeKey) =>
            void local.extractFeatures(preview.id, revision, routeKey)
          }
          onRefreshModel={() => {
            featureModel.refresh();
            local.clearFeatureError();
          }}
          onOpenModelSettings={onOpenModelSettings}
        />
      ) : null}
      {local.moveError ? (
        <p className="gi-float gi-announcement" role="alert">
          {text.localMoveFailed}
        </p>
      ) : null}
      <div role="status" className={announcement ? "gi-float gi-announcement" : "sr-only"}>
        {announcement}
      </div>
    </main>
  );
}
