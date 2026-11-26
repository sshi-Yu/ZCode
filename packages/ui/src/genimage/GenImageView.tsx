import { GitFork, History, Info, Maximize, Minus, Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GenImageViewProps } from "./contract.js";
import { FixtureArtwork, initialNodes, MAX_NODES, NODE_HEIGHT, NODE_WIDTH } from "./fixture.js";
import type { ImageNode, Ratio } from "./fixture.js";
import { FixtureBadge, GenImagePanel, type PanelKind } from "./GenImagePanel.js";
import { genImageText } from "./text.js";
import "./genimage.css";

interface Camera {
  x: number;
  y: number;
  scale: number;
}
interface Panel {
  kind: PanelKind;
  trigger: HTMLElement | null;
  source?: string;
}
interface Drag {
  pointer: number;
  clientX: number;
  clientY: number;
  x: number;
  y: number;
  id?: string;
  moved: boolean;
}

function fitCamera(
  nodes: readonly ImageNode[],
  width: number,
  height: number,
  initial: boolean,
): Camera {
  const left = Math.min(...nodes.map((node) => node.x));
  const right = Math.max(...nodes.map((node) => node.x + NODE_WIDTH));
  const top = Math.min(...nodes.map((node) => node.y));
  const bottom = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT));
  const scale = Math.max(
    0.02,
    Math.min(1, (width - 40) / (right - left), (height - 160) / (bottom - top)),
  );
  const freeWidth = width - (right - left) * scale;
  const freeHeight = height - (bottom - top) * scale;
  return {
    x: (initial ? Math.min(116, freeWidth / 2) : freeWidth / 2) - left * scale,
    y: (initial ? Math.min(84, freeHeight / 2) : freeHeight / 2) - top * scale,
    scale,
  };
}

function zoomCamera(camera: Camera, factor: number, x: number, y: number): Camera {
  const scale = Math.min(2, Math.max(0.02, camera.scale * factor));
  const multiplier = scale / camera.scale;
  return { scale, x: x - (x - camera.x) * multiplier, y: y - (y - camera.y) * multiplier };
}

function edgePath(parent: ImageNode, child: ImageNode) {
  const rightward = child.x >= parent.x;
  const startX = parent.x + (rightward ? NODE_WIDTH : 0);
  const endX = child.x + (rightward ? -4 : NODE_WIDTH + 4);
  const startY = parent.y + NODE_HEIGHT / 2;
  const endY = child.y + NODE_HEIGHT / 2;
  const bend = Math.max(46, Math.abs(endX - startX) / 2) * (rightward ? 1 : -1);
  return `M${startX} ${startY} C${startX + bend} ${startY} ${endX - bend} ${endY} ${endX} ${endY}`;
}

export function GenImageView({ windowControls, sidebarCollapsed }: GenImageViewProps) {
  const { locale } = useZCodeIntl();
  const text = genImageText(locale);
  const [nodes, setNodes] = useState<readonly ImageNode[]>(initialNodes);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [selectedId, setSelectedId] = useState<string | null>("B");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<Ratio>("4:3");
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const helpButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<Drag | null>(null);
  const panelId = useId();
  const arrowId = useId();
  const selected = nodes.find((node) => node.id === selectedId);
  const source = nodes.find((node) => node.id === panel?.source);
  const nodeIndex = new Map(nodes.map((node) => [node.id, node]));

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    setCamera(fitCamera(initialNodes, element.clientWidth, element.clientHeight, true));
    element.focus({ preventScroll: true });
  }, []);

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
    return viewport.current?.querySelector<HTMLElement>(`[data-genimage-node="${id}"]`);
  }

  function locate(id: string, close = false, focus = false) {
    const node = nodeIndex.get(id);
    const element = viewport.current;
    if (!node || !element) return;
    const { clientWidth, clientHeight } = element;
    const panelOpen = panel && !close;
    const wide = clientWidth >= 640;
    const visibleWidth = panelOpen && wide ? clientWidth - 370 : clientWidth;
    const visibleHeight = panelOpen && !wide ? clientHeight * 0.55 : clientHeight;
    setSelectedId(id);
    if (close) setPanel(null);
    setCamera((previous) => ({
      ...previous,
      x: visibleWidth / 2 - (node.x + NODE_WIDTH / 2) * previous.scale,
      y: visibleHeight / 2 - (node.y + NODE_HEIGHT / 2) * previous.scale,
    }));
    if (close || focus) findNodeElement(id)?.focus({ preventScroll: true });
  }

  function closePanel() {
    setPanel(null);
    if (panel?.trigger?.isConnected) panel.trigger.focus({ preventScroll: true });
    else if (selectedId) findNodeElement(selectedId)?.focus({ preventScroll: true });
  }

  function togglePanel(kind: PanelKind, trigger: HTMLElement | null) {
    if (panel?.kind === kind) closePanel();
    else setPanel({ kind, trigger });
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
      id: node?.id,
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
    if (current.id) {
      setNodes((previous) =>
        previous.map((node) =>
          node.id === current.id
            ? { ...node, x: current.x + dx / camera.scale, y: current.y + dy / camera.scale }
            : node,
        ),
      );
    } else setCamera((previous) => ({ ...previous, x: current.x + dx, y: current.y + dy }));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!current.id && !current.moved && event.type === "pointerup" && panel?.kind !== "details")
      setSelectedId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function submit() {
    const description = prompt.trim();
    if (!description || nodes.length >= MAX_NODES) return;
    const id = String.fromCharCode(65 + nodes.length);
    const x = source ? source.x + 360 : Math.max(...nodes.map((node) => node.x)) + 360;
    let y = source?.y ?? 184;
    while (
      nodes.some(
        (node) => Math.abs(node.x - x) < NODE_WIDTH + 16 && Math.abs(node.y - y) < NODE_HEIGHT + 16,
      )
    )
      y += NODE_HEIGHT + 48;
    setNodes([
      ...nodes,
      {
        id,
        x,
        y,
        ratio,
        source: source?.id ?? null,
        prompt: description,
        title: source ? text.deriveTitle : text.newTitle,
        artwork: (source ? source.artwork + 1 : nodes.length) % 3,
      },
    ]);
    if (panel?.trigger?.isConnected && !source) panel.trigger.focus({ preventScroll: true });
    else viewport.current?.focus({ preventScroll: true });
    setSelectedId(id);
    setPanel(null);
    setAnnouncement(text.added(id));
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const { key, target } = event;
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
    else if (key.toLowerCase() === "n") setPanel({ kind: "create", trigger: newButton.current });
    else if (key === "?") togglePanel("help", helpButton.current);
    else if (
      selected &&
      key.startsWith("Arrow") &&
      target instanceof Node &&
      viewport.current?.contains(target)
    ) {
      if (event.shiftKey) {
        const dx = key === "ArrowRight" ? 16 : key === "ArrowLeft" ? -16 : 0;
        const dy = key === "ArrowDown" ? 16 : key === "ArrowUp" ? -16 : 0;
        setNodes((previous) =>
          previous.map((node) =>
            node.id === selected.id ? { ...node, x: node.x + dx, y: node.y + dy } : node,
          ),
        );
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

  const openDerive = (id: string, trigger: HTMLButtonElement) =>
    setPanel({ kind: "create", trigger, source: id });

  return (
    <main
      className="genimage-view"
      data-testid="genimage-workspace"
      data-sidebar-collapsed={sidebarCollapsed}
      aria-label="GenImage"
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
            <defs>
              <marker
                id={arrowId}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path d="M0 0 8 4 0 8Z" />
              </marker>
            </defs>
            {nodes.map((node) => {
              const parent = node.source && nodeIndex.get(node.source);
              return parent ? (
                <path
                  key={node.id}
                  data-genimage-edge={node.id}
                  data-source={parent.id}
                  data-related={node.id === selectedId || parent.id === selectedId}
                  d={edgePath(parent, node)}
                  markerEnd={`url(#${arrowId})`}
                />
              ) : null;
            })}
          </svg>
          {nodes.map((node) => (
            <article
              key={node.id}
              className="gi-node"
              data-genimage-node={node.id}
              data-source={node.source ?? ""}
              data-selected={node.id === selectedId}
              tabIndex={0}
              aria-label={`${node.id} · ${node.title}`}
              style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
              onFocus={() => setSelectedId(node.id)}
              onKeyDown={(event) => {
                if (
                  event.currentTarget === event.target &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  togglePanel("details", event.currentTarget);
                }
              }}
            >
              <header>
                <span>
                  <code>{node.id}</code>{" "}
                  {node.source ? `${text.derived} ${node.source}` : text.root}
                </span>
                <FixtureBadge>{text.fixture}</FixtureBadge>
              </header>
              <FixtureArtwork node={node} className="gi-node-art" />
              <footer>
                <div>
                  <h3>{node.title}</h3>
                  <p>
                    {text.localArt} · {node.ratio} · {text.noExport}
                  </p>
                </div>
                <GitFork size={16} aria-hidden="true" />
              </footer>
              {node.id === selectedId ? (
                <div className="gi-float gi-node-actions" style={{ scale: 1 / camera.scale }}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={text.details}
                    onClick={(event) => togglePanel("details", event.currentTarget)}
                  >
                    <Info />
                  </Button>
                  <Button
                    type="button"
                    data-testid="genimage-derive"
                    onClick={(event) => openDerive(node.id, event.currentTarget)}
                  >
                    <GitFork />
                    {text.derive}
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>
      <header className="gi-top">
        <div className="gi-float gi-toolbar gi-brand">
          <h1>GenImage</h1>
          <i aria-hidden="true" />
          <Button
            ref={newButton}
            type="button"
            size="lg"
            aria-label={text.create}
            data-testid="genimage-new"
            onClick={(event) => setPanel({ kind: "create", trigger: event.currentTarget })}
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
        <p>{text.workspace}</p>
        <p>{text.tagline}</p>
        <p>{text.notice}</p>
      </div>
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
        <span>{text.mode}</span>
        <FixtureBadge>{text.fixture}</FixtureBadge>
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
          source={source}
          selected={selected}
          prompt={prompt}
          ratio={ratio}
          panelId={panelId}
          promptRef={promptInput}
          closeRef={closeButton}
          onChangePrompt={setPrompt}
          onChangeRatio={setRatio}
          onClose={closePanel}
          onSubmit={submit}
          onDerive={openDerive}
          onLocate={locate}
        />
      ) : null}
      <div role="status" className={announcement ? "gi-float gi-announcement" : "sr-only"}>
        {announcement}
      </div>
    </main>
  );
}
