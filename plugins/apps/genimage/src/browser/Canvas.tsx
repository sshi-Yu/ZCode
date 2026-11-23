import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Button, Input, Label, Textarea } from "@zcode-plugins/uis";
import type { HostThemeStore } from "@zcode-plugins/uis";
import { Illustration, INITIAL_NODES, fixtureTimeLabel } from "./fixture.js";
import { localeFromHost, stringsFor } from "./strings.js";
import { useHostBridge } from "./use-host-bridge.js";
import { BRIEF_MAX_CODE_POINTS, MAX_NODES, MAX_SCALE, MIN_SCALE, NODE_HEIGHT, NODE_WIDTH } from "./types.js";
import type { Camera, CanvasNode, HostStatus, PanelId, PanelState, Ratio } from "./types.js";

interface CanvasProps { themeStore: HostThemeStore }
interface Drag { pointer: number; sx: number; sy: number; x: number; y: number; node: string | null; moved: boolean }

type CameraAction = (previous: Camera) => Camera;

function cameraForFit(nodes: readonly CanvasNode[]): Camera {
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT));
  const width = Math.max(160, innerWidth - 64);
  const height = Math.max(160, innerHeight - 240);
  const scale = Math.max(MIN_SCALE, Math.min(1, width / (maxX - minX), height / (maxY - minY)));
  return {
    scale,
    x: innerWidth / 2 - ((minX + maxX) / 2) * scale,
    y: 170 + (height - (maxY - minY) * scale) / 2 - minY * scale,
  };
}

function zoomCamera(camera: Camera, factor: number, x: number, y: number): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
  return { x: x - ((x - camera.x) * scale) / camera.scale, y: y - ((y - camera.y) * scale) / camera.scale, scale };
}

function Icon({ name }: { name: "plus" | "minus" | "close" | "history" | "settings" | "fit" | "branch" | "info" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    history: <path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2" />,
    settings: <path d="M4 7h16M4 17h16M8 4v6M16 14v6" />,
    fit: <><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" /><rect x="7" y="7" width="10" height="10" rx="1" /></>,
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 14c6 0 10-2 10-6" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.01" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

/**
 * 唯一画布状态所有者：Canvas 持有节点/相机/选中/草稿；uis 只持有宿主外观。
 * 明确事件序：host tool-result → 有界校验 → 仅空草稿回填 → 打开编辑浮窗（从不提交）。
 * 模拟提交 → 校验 → 追加一个新节点；source 来自明确选择，拖动与布局不改谱系。
 */
export function Canvas({ themeStore }: CanvasProps) {
  const [nodes, setNodes] = useState<CanvasNode[]>(() => INITIAL_NODES.map((node) => ({ ...node })));
  const [camera, setCamera] = useState<Camera>(() => cameraForFit(INITIAL_NODES));
  const [selected, setSelected] = useState<string | null>("B");
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<Ratio>("4:3");
  const [promptError, setPromptError] = useState(false);
  // locale 与颜色同属已校验宿主投影；不能从原始通知另建写路径，非法局部更新须保留先前语种。
  const hostTheme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot);
  const locale = localeFromHost(hostTheme.locale);
  const [hostStatus, setHostStatus] = useState<HostStatus>("standalone");
  const [toast, setToast] = useState("");
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<Drag | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(INITIAL_NODES.length);
  const active = useRef(true);
  const strings = stringsFor(locale);

  const notify = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => { setToast(""); toastTimer.current = null; }, 4500);
  }, [setToast]);
  const closePanel = useCallback((restore = true) => {
    const trigger = panel?.trigger;
    setPanel(null);
    if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }, [panel]);
  const openPanel = useCallback((id: PanelId, trigger: HTMLElement | null = null) => {
    setPanel((previous) => previous?.id === id ? null : { id, trigger: trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) });
  }, []);
  const openCreate = useCallback((source: string | null, trigger: HTMLElement | null) => {
    setSourceId(source);
    setPromptError(false);
    setPanel({ id: "create", trigger });
  }, []);
  const teardown = useCallback(() => {
    active.current = false;
    dragRef.current = null;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
  }, []);
  const receiveBrief = useCallback((brief: unknown, isError: unknown) => {
    if (!active.current || isError || typeof brief !== "string" || !brief.trim()) return;
    if (Array.from(brief).length > BRIEF_MAX_CODE_POINTS) { notify(strings.toastBriefOverLimit); return; }
    if (prompt.trim()) { notify(strings.toastBriefKept); return; }
    setPrompt(brief);
    openCreate(null, newButtonRef.current);
    notify(strings.toastBriefApplied);
  }, [notify, openCreate, prompt, strings]);
  useHostBridge({ themeStore, onBrief: receiveBrief, onStatus: setHostStatus, onTeardown: teardown });

  useEffect(() => () => { teardown(); }, [teardown]);
  useEffect(() => {
    if (!panel) return;
    const target = panel.id === "create" ? promptRef.current : closeRef.current;
    target?.focus({ preventScroll: true });
  }, [panel]);

  const updateCamera = useCallback((update: CameraAction) => { setCamera(update); }, []);
  const zoom = useCallback((factor: number, x = innerWidth / 2, y = innerHeight / 2) => {
    updateCamera((previous) => zoomCamera(previous, factor, x, y));
  }, [updateCamera]);
  const fit = useCallback(() => { setCamera(cameraForFit(nodes)); notify(strings.toastFit(nodes.length)); }, [nodes, notify, strings]);
  const focusNode = useCallback((id: string, keyboard = false) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return;
    setSelected(id);
    setCamera((previous) => ({ ...previous,
      x: (panel && innerWidth >= 640 ? (innerWidth - 352) / 2 : innerWidth / 2) - (node.x + NODE_WIDTH / 2) * previous.scale,
      y: (panel && innerWidth < 640 ? 180 : innerHeight / 2) - (node.y + 162) * previous.scale,
    }));
    if (keyboard) nodeRefs.current.get(id)?.focus({ preventScroll: true });
  }, [nodes, panel]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (!active.current) return;
      event.preventDefault();
      zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003), event.clientX, event.clientY);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [zoom]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!active.current) return;
    if (event.key === "Escape") { if (panel) { event.preventDefault(); closePanel(); } return; }
    const target = event.target;
    if (target instanceof Element && target.closest("input,textarea,select")) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const node = nodes.find((item) => item.id === selected);
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.2); }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.2); }
    else if (event.key === "0" || event.key === "Home") { event.preventDefault(); fit(); }
    else if (event.key.toLowerCase() === "n") { event.preventDefault(); openCreate(null, newButtonRef.current); }
    else if (event.key === "?") { event.preventDefault(); openPanel("help", helpButtonRef.current); }
    else if (node && event.key.startsWith("Arrow")) {
      event.preventDefault();
      if (event.shiftKey) {
        const dx = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
        const dy = event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0;
        setNodes((previous) => previous.map((item) => item.id === node.id ? { ...item, x: item.x + dx, y: item.y + dy } : item));
      } else {
        const index = nodes.indexOf(node);
        const next = event.key === "ArrowLeft" ? nodes.find((item) => item.id === node.source)
          : event.key === "ArrowRight" ? nodes.find((item) => item.source === node.id)
          : nodes[(index + (event.key === "ArrowDown" ? 1 : nodes.length - 1)) % nodes.length];
        if (next) focusNode(next.id, true);
      }
    }
  }, [closePanel, fit, focusNode, nodes, openCreate, openPanel, panel, selected, zoom]);
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!active.current || event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button")) return;
    const element = event.target.closest<HTMLElement>(".node");
    const node = nodes.find((item) => item.id === element?.dataset.id);
    dragRef.current = { pointer: event.pointerId, sx: event.clientX, sy: event.clientY, x: node?.x ?? camera.x, y: node?.y ?? camera.y, node: node?.id ?? null, moved: false };
    if (node) { setSelected(node.id); element?.focus({ preventScroll: true }); }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.node) {
      setNodes((previous) => previous.map((node) => node.id === drag.node ? { ...node, x: drag.x + dx / camera.scale, y: drag.y + dy / camera.scale } : node));
    } else setCamera((previous) => ({ ...previous, x: drag.x + dx, y: drag.y + dy }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.node && !drag.moved && event.type !== "pointercancel") setSelected(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) { setPromptError(true); promptRef.current?.focus(); return; }
    if (!active.current || nodes.length >= MAX_NODES) return;
    const source = nodes.find((node) => node.id === sourceId);
    const id = String.fromCharCode(65 + sequence.current++);
    const x = source ? source.x + 440 : Math.max(...nodes.map((node) => node.x)) + 440;
    let y = source?.y ?? 180;
    // 节点坐标只是布局；找空位不能改变用户明确选择的来源谱系。
    while (nodes.some((node) => Math.abs(node.x - x) < 320 && Math.abs(node.y - y) < 370)) y += 420;
    const node: CanvasNode = { id, title: source ? strings.newTitleDerive : strings.newTitleNew, prompt: cleanPrompt, source: source?.id ?? null, x, y,
      art: source ? (source.art + 1) % 3 : sequence.current % 3, ratio, time: fixtureTimeLabel(locale) };
    setNodes((previous) => [...previous, node]);
    setSelected(id);
    setPanel(null);
    // 新结果靠源图落位，不强制重置相机；避免抢走用户正在看的其他节点。
    notify(strings.toastAdded(id, source?.id ?? null));
  };

  const selectedNode = nodes.find((node) => node.id === selected);
  const sourceNode = nodes.find((node) => node.id === sourceId);
  const [viewportWidth, setViewportWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resize = () => { setViewportWidth(innerWidth); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const panelTitle = panel?.id === "create" ? sourceNode ? strings.createTitleDerive : strings.createTitleNew
    : panel?.id === "inspector" ? strings.inspectorTitle : panel?.id === "history" ? strings.historyTitle
    : panel?.id === "settings" ? strings.settingsTitle : strings.helpTitlePanel;
  const nodeKeyDown = (event: ReactKeyboardEvent<HTMLElement>, node: CanvasNode) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node.id); openPanel("inspector", event.currentTarget); }
  };
  const renderInspector = (): ReactNode => selectedNode ? <>
    <Illustration art={selectedNode.art} ratio={selectedNode.ratio} title={selectedNode.title} className="detail-art" />
    <div><h3>{selectedNode.id} · {selectedNode.title}</h3><p className="small muted detail-prompt">{selectedNode.prompt}</p></div>
    <dl><dt>{strings.inspectorKind}</dt><dd>{strings.inspectorKindValue}</dd><dt>{strings.inspectorRatio}</dt><dd>{selectedNode.ratio}</dd><dt>{strings.inspectorModel}</dt><dd>{strings.inspectorModelValue}</dd><dt>{strings.inspectorCreated}</dt><dd>{selectedNode.time}</dd></dl>
    <div><p className="small muted">{strings.relationsTitle}</p><div className="relations">
      {selectedNode.source ? <Button variant="outline" onClick={() => { focusNode(selectedNode.source!); }}>{strings.sourceChip(selectedNode.source)}</Button> : <span className="small">{strings.rootLabel}</span>}
      {nodes.filter((node) => node.source === selectedNode.id).map((child) => <Button key={child.id} variant="outline" onClick={() => { focusNode(child.id); }}>{strings.childChip(child.id)}</Button>)}
    </div></div>
    <Button className="full" onClick={(event) => { openCreate(selectedNode.id, event.currentTarget); }}><Icon name="branch" />{strings.deriveAction}</Button>
    <div className="form-grid"><Button variant="outline" disabled>{strings.exportPng}</Button><Button variant="outline" disabled>{strings.referenceSession}</Button></div>
    <p className="small muted">{strings.inspectorNote}</p>
  </> : <p className="small muted">{strings.inspectorEmpty}</p>;

  const worldStyle: CSSProperties = { transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` };
  return <div className="canvas-app text-ui-base" lang={locale}>
    <main id="viewport" ref={viewportRef} className={dragging ? "dragging" : ""} aria-label={strings.canvasAriaLabel} tabIndex={-1}
      style={{ backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
      onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div id="world" style={worldStyle}>
        <svg id="edges" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8Z" /></marker></defs>
          {nodes.filter((node) => node.source).map((node) => {
            const parent = nodes.find((item) => item.id === node.source);
            if (!parent) return null;
            const rightward = node.x >= parent.x;
            const x1 = parent.x + (rightward ? NODE_WIDTH : 0); const y1 = parent.y + 162;
            const x2 = node.x + (rightward ? 0 : NODE_WIDTH); const y2 = node.y + 162;
            const bend = Math.max(60, Math.abs(x2 - x1) * 0.5) * (rightward ? 1 : -1);
            return <path key={node.id} className={`edge${node.id === selected || parent.id === selected ? " related" : ""}`} data-source={parent.id} data-target={node.id} d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`} markerEnd="url(#arrow)" />;
          })}
        </svg>
        {nodes.map((node) => <article key={node.id} ref={(element) => { if (element) nodeRefs.current.set(node.id, element); else nodeRefs.current.delete(node.id); }}
          className={`node${node.id === selected ? " selected" : ""}`} data-id={node.id} data-source={node.source ?? ""}
          tabIndex={0} role="group" aria-label={strings.nodeAria(node.id, node.title, node.source)} style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
          onFocus={() => { setSelected(node.id); }} onKeyDown={(event) => { nodeKeyDown(event, node); }}>
          <div className="node-head"><span className="node-kind"><span className="mono">{node.id}</span><span className="muted">{node.source ? strings.nodeDerivedFrom(node.source) : strings.nodeRoot}</span></span><span className="badge">{strings.badgeFixture}</span></div>
          <Illustration art={node.art} ratio={node.ratio} title={node.title} className="node-art" />
          <div className="node-foot"><div><h3 className="node-title">{node.title}</h3><p className="node-meta">{strings.nodeFixtureMeta(node.ratio)}</p></div><Icon name="branch" /></div>
          {node.id === selected ? <div className={`node-actions${viewportWidth < 640 ? " narrow" : ""}`} style={{ transform: viewportWidth < 640 ? `scale(${1 / camera.scale})` : `translateX(-50%) scale(${1 / camera.scale})` }}>
            <Button variant="ghost" aria-label={strings.inspectorTitle} onClick={(event) => { openPanel("inspector", event.currentTarget); }}><Icon name="info" /></Button>
            <Button onClick={(event) => { openCreate(node.id, event.currentTarget); }}><Icon name="branch" />{strings.deriveAction}</Button>
          </div> : null}
        </article>)}
      </div>
    </main>
    <header className="floating topbar" aria-label="GenImage"><div className="wordmark"><strong>GenImage</strong></div><span className="divider" aria-hidden="true" />
      <Button ref={newButtonRef} onClick={(event) => { openCreate(null, event.currentTarget); }}><Icon name="plus" />{strings.newGeneration}</Button>
    </header>
    <nav className="floating top-actions" aria-label={strings.settingsTitle}>
      <Button variant="ghost" aria-label={strings.history} aria-expanded={panel?.id === "history"} onClick={(event) => { openPanel("history", event.currentTarget); }}><Icon name="history" /><span className="button-label">{strings.history}</span></Button>
      <Button variant="ghost" aria-label={strings.settings} aria-expanded={panel?.id === "settings"} onClick={(event) => { openPanel("settings", event.currentTarget); }}><Icon name="settings" /><span className="button-label">{strings.settings}</span></Button>
    </nav>
    <div className="dev-note"><p className="eyebrow muted">{strings.workspace}</p><p>{strings.wordmarkSub}</p><p className="small muted description">{strings.devNote}</p></div>
    <nav className="floating zoom" aria-label={strings.helpZoom[0]}>
      <Button variant="ghost" size="icon" aria-label={strings.zoomOut} onClick={() => { zoom(1 / 1.2); }}><Icon name="minus" /></Button><output aria-label={strings.helpZoom[0]}>{Math.round(camera.scale * 100)}%</output>
      <Button variant="ghost" size="icon" aria-label={strings.zoomIn} onClick={() => { zoom(1.2); }}><Icon name="plus" /></Button><span className="divider" aria-hidden="true" />
      <Button variant="ghost" aria-label={strings.fitAll} onClick={fit}><Icon name="fit" />{strings.fitAllShort}</Button>
    </nav>
    <p className="canvas-help">{strings.canvasHelp}</p>
    <div className="floating session-state"><span className="status-dot" aria-hidden="true" /><span className="host-label">{hostStatus === "connected" ? strings.hostConnected : hostStatus === "handshake-failed" ? strings.hostHandshakeFailed : hostStatus === "fullscreen-denied" ? strings.hostFullscreenDenied : strings.hostStandalone}</span><span className="badge">{strings.badgeFixture}</span><Button ref={helpButtonRef} variant="ghost" size="icon" aria-label={strings.helpTitle} onClick={(event) => { openPanel("help", event.currentTarget); }}><Icon name="info" /></Button></div>
    {panel ? <section className="floating panel" role="dialog" aria-labelledby="panel-title" tabIndex={-1}>
      <div className="panel-head"><h2 id="panel-title">{panelTitle}{panel.id === "history" ? <span className="badge">{nodes.length}</span> : null}</h2><Button ref={closeRef} variant="ghost" size="icon" aria-label={strings.closePanel(panelTitle)} onClick={() => { closePanel(); }}><Icon name="close" /></Button></div>
      {panel.id === "create" ? <form className="panel-body" onSubmit={submit}>
        {sourceNode ? <div className="source-card"><Illustration art={sourceNode.art} ratio={sourceNode.ratio} title={sourceNode.title} className="source-thumb" /><div><strong>{strings.sourceTitle(sourceNode.id, sourceNode.title)}</strong><p className="small muted">{strings.sourceNote}</p></div></div> : null}
        <div className="field"><Label htmlFor="prompt">{sourceNode ? strings.promptLabelDerive : strings.promptLabelNew}</Label><Textarea ref={promptRef} id="prompt" value={prompt} onChange={(event) => { setPrompt(event.target.value); setPromptError(false); }} placeholder={strings.promptPlaceholder} aria-describedby="prompt-help prompt-error" /><p id="prompt-help" className="panel-caption">{strings.promptHelp}</p>{promptError ? <p id="prompt-error" className="error" role="alert">{strings.promptEmptyError}</p> : null}</div>
        <div className="form-grid"><div className="field"><Label htmlFor="model">{strings.modelLabel}</Label><Input id="model" value={strings.modelFixture} readOnly /></div><div className="field"><Label>{strings.ratioLabel}</Label><div className="ratio-options" role="group" aria-label={strings.ratioLabel}>{(["4:3", "1:1", "3:4"] as const).map((value) => <Button key={value} type="button" variant="outline" aria-pressed={ratio === value} onClick={() => { setRatio(value); }}>{value}</Button>)}</div></div></div>
        <div className="notice">{strings.noticeText}</div><Button type="submit" className="full" disabled={!prompt.trim() || nodes.length >= MAX_NODES}><Icon name={sourceNode ? "branch" : "plus"} />{sourceNode ? strings.generateDerive : strings.generateNew}</Button><p className="small muted">{strings.capacity(nodes.length, MAX_NODES)}</p>
      </form> : panel.id === "inspector" ? <div className="panel-body">{renderInspector()}</div> : panel.id === "history" ? <><p className="history-caption small muted">{strings.historyHint}</p><ol className="history-list">{[...nodes].reverse().map((node) => <li key={node.id}><Button variant="ghost" className="history-row" onClick={() => { setPanel(null); focusNode(node.id, true); }}><Illustration art={node.art} ratio={node.ratio} title={node.title} /><span className="history-copy"><strong>{node.id} · {node.title}</strong><span>{node.source ? strings.historyFrom(node.source) : strings.historyRoot} · {node.time}</span></span><span className="badge">{strings.badgeFixture}</span></Button></li>)}</ol></> : panel.id === "settings" ? <div className="panel-body">
        <div className="setting-row"><span>{strings.settingsMode}</span><span className="badge">{strings.settingsModeValue}</span></div><div className="setting-row"><span>{strings.settingsProvider}</span><span className="muted">{strings.settingsProviderValue}</span></div><div className="setting-row"><span>{strings.settingsCredential}</span><span className="muted">{strings.settingsCredentialValue}</span></div><div className="setting-row"><span>{strings.settingsTheme}</span><span className="muted">{strings.settingsThemeValue}</span></div><div className="notice">{strings.settingsNotice}</div><p className="small muted">{strings.settingsMemory}</p>
      </div> : <div className="panel-body"><div className="shortcut-list">{[strings.helpPan, strings.helpMove, strings.helpZoom, strings.helpFit, strings.helpNew, strings.helpSelect, strings.helpLineage, strings.helpNudge, strings.helpClose].map(([label, shortcut]) => <div key={label}><span>{label}</span><kbd>{shortcut}</kbd></div>)}</div><p className="small muted">{strings.helpTouchNote}</p></div>}
    </section> : null}
    <div id="toast" role="status" aria-live="polite" aria-atomic="true">{toast}</div>
  </div>;
}
