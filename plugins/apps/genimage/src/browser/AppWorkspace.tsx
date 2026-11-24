import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, PointerEvent as ReactPointerEvent } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";
import { Button, Input, Label, Textarea } from "@zcode-plugins/uis";
import type { HostThemeStore } from "@zcode-plugins/uis";
import { appStringsFor } from "./app-strings.js";
import type { ImageJob } from "./app-transport.js";
import { localeFromHost, stringsFor } from "./strings.js";
import { MAX_SCALE, MIN_SCALE, NODE_HEIGHT, NODE_WIDTH } from "./types.js";
import type { Camera, PanelState } from "./types.js";
import { useAppWorkspace } from "./use-app-workspace.js";

interface Point { x: number; y: number }
interface Drag { pointer: number; start: Point; origin: Point; id: string | null; moved: boolean }
const EMPTY_JOBS: ImageJob[] = [];

/** 任务及资产只来自 Host；节点位置、选择、浮窗、视口和未提交草稿是本页局部状态。 */
export function AppWorkspace({ app, themeStore }: { app: App; themeStore: HostThemeStore }) {
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot);
  const locale = localeFromHost(theme.locale);
  const s = stringsFor(locale);
  const a = appStringsFor(locale);
  const { snapshot, reading, readError, submitting, exporting, notice, refresh, generate, exportImage } = useAppWorkspace(app);
  const jobs = snapshot?.jobs ?? EMPTY_JOBS;
  const [camera, setCamera] = useState<Camera>({ x: 32, y: 190, scale: 1 });
  const [positions, setPositions] = useState(() => new Map<string, Point>());
  const images = jobs.filter(job => job.asset && positions.has(job.id));
  useEffect(() => {
    setPositions(previous => {
      let next = previous;
      for (const job of jobs) {
        if (!job.asset || next.has(job.id)) continue;
        if (next === previous) next = new Map(previous);
        // 宿主会前插/重排任务；首见时按 ID 分配本页坐标，不能用当前索引让旧图跟着移动。
        const slot = next.size;
        next.set(job.id, { x: (slot % 3) * 336, y: Math.floor(slot / 3) * 400 });
      }
      return next;
    });
  }, [jobs]);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const viewportRef = useRef<HTMLElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const busy = jobs.some(job => job.status === "running");
  const selectedJob = images.find(job => job.id === selected);
  const position = useCallback((id: string) => positions.get(id)!, [positions]);
  const open = useCallback((id: PanelState["id"], trigger: HTMLElement | null) => {
    setPanel(previous => previous?.id === id ? null : { id, trigger });
  }, []);
  const close = useCallback(() => {
    setPanel(null);
    if (panel?.trigger?.isConnected) panel.trigger.focus({ preventScroll: true });
  }, [panel]);
  useEffect(() => {
    if (panel) (panel.id === "create" ? promptRef.current : closeRef.current)?.focus({ preventScroll: true });
  }, [panel]);
  const zoom = useCallback((factor: number, x = innerWidth / 2, y = innerHeight / 2) => {
    setCamera(previous => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, previous.scale * factor));
      return { scale, x: x - (x - previous.x) * scale / previous.scale, y: y - (y - previous.y) * scale / previous.scale };
    });
  }, []);
  const fit = useCallback(() => {
    if (!images.length) { setCamera({ x: 32, y: 190, scale: 1 }); return; }
    const points = images.map(job => position(job.id));
    const left = Math.min(...points.map(p => p.x));
    const top = Math.min(...points.map(p => p.y));
    const width = Math.max(...points.map(p => p.x)) + NODE_WIDTH - left;
    const height = Math.max(...points.map(p => p.y)) + NODE_HEIGHT - top;
    const scale = Math.max(MIN_SCALE, Math.min(1, (innerWidth - 64) / width, Math.max(160, innerHeight - 260) / height));
    setCamera({ scale, x: (innerWidth - width * scale) / 2 - left * scale, y: 180 - top * scale });
  }, [images, position]);
  const focus = useCallback((id: string) => {
    const index = images.findIndex(job => job.id === id);
    if (index < 0) return;
    setSelected(id);
    const point = position(id);
    setCamera(previous => ({ ...previous, x: innerWidth / 2 - (point.x + NODE_WIDTH / 2) * previous.scale, y: innerHeight / 2 - (point.y + 140) * previous.scale }));
    nodeRefs.current.get(id)?.focus({ preventScroll: true });
  }, [images, position]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003), event.clientX, event.clientY);
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [zoom]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (panel) { event.preventDefault(); close(); } return; }
      // 沿用既有修复：浮窗按钮冒泡按键不应改变画布或抢走焦点。
      if (event.target instanceof Element && (panelRef.current?.contains(event.target) || event.target.closest("input,textarea,select"))) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (["+", "=", "-"].includes(event.key)) { event.preventDefault(); zoom(event.key === "-" ? 1 / 1.2 : 1.2); }
      else if (event.key === "0" || event.key === "Home") { event.preventDefault(); fit(); }
      else if (event.key.toLowerCase() === "n") { event.preventDefault(); open("create", newRef.current); }
      else if (event.key === "?") { event.preventDefault(); open("help", helpRef.current); }
      else if (selected && event.key.startsWith("Arrow")) {
        const index = images.findIndex(job => job.id === selected);
        if (index < 0) return;
        event.preventDefault();
        if (event.shiftKey) {
          const point = position(selected);
          setPositions(previous => new Map(previous).set(selected, { x: point.x + (event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0), y: point.y + (event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0) }));
        } else {
          const next = images[(index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? images.length - 1 : 1)) % images.length];
          if (next) focus(next.id);
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [close, fit, focus, images, open, panel, position, selected, zoom]);
  const down = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button")) return;
    const element = event.target.closest<HTMLElement>(".node");
    const index = images.findIndex(job => job.id === element?.dataset.jobId);
    const id = images[index]?.id ?? null;
    drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: id ? position(id) : camera, id, moved: false };
    if (id) { setSelected(id); element?.focus({ preventScroll: true }); }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) current.moved = true;
    if (!current.moved) return;
    if (current.id) setPositions(previous => new Map(previous).set(current.id!, { x: current.origin.x + dx / camera.scale, y: current.origin.y + dy / camera.scale }));
    else setCamera(previous => ({ ...previous, x: current.origin.x + dx, y: current.origin.y + dy }));
  };
  const up = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    if (!drag.current.id && !drag.current.moved && event.type !== "pointercancel") setSelected(null);
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (prompt.trim()) void generate(prompt.trim()); };
  const title = panel?.id === "create" ? s.createTitleNew : panel?.id === "history" ? s.historyTitle : panel?.id === "settings" ? s.settingsTitle : panel?.id === "inspector" ? s.inspectorTitle : s.helpTitlePanel;
  const preview = (job: ImageJob, className = "") => job.asset ? <img className={className} src={job.asset.preview} alt={job.prompt} draggable={false} /> : null;
  const statusText = readError ? a.readError : !snapshot ? a.loading : !jobs.length ? a.empty : busy ? a.running : a.mode;
  return <div className="canvas-app text-ui-base" data-genimage-mode="app" lang={locale}>
    <main id="viewport" ref={viewportRef} className={dragging ? "dragging" : ""} tabIndex={-1} aria-label={s.canvasAriaLabel}
      style={{ backgroundSize: `${24 * camera.scale}px ${24 * camera.scale}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div id="world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
        {images.map(job => {
          const point = position(job.id);
          return <article key={job.id} ref={element => { if (element) nodeRefs.current.set(job.id, element); else nodeRefs.current.delete(job.id); }}
            className={`node${selected === job.id ? " selected" : ""}`} data-job-id={job.id} data-job-status={job.status} data-asset-id={job.asset!.id}
            style={{ transform: `translate(${point.x}px, ${point.y}px)` }} role="group" tabIndex={0} aria-label={`${job.prompt} · ${a[job.status]}`}
            onFocus={() => setSelected(job.id)} onKeyDown={event => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); open("inspector", event.currentTarget); } }}>
            <div className="node-head"><span className="node-kind">{a.preview}</span><span className="badge">{a[job.status]}</span></div>
            {preview(job, "node-art")}
            <div className="node-foot"><div className="history-copy"><h3 className="node-title">{job.prompt}</h3><p className="node-meta">{job.modelId}</p></div><Button variant="ghost" aria-label={s.inspectorTitle} onClick={event => open("inspector", event.currentTarget)}>…</Button></div>
          </article>;
        })}
      </div>
    </main>
    <header className="floating topbar" aria-label="GenImage"><div className="wordmark"><strong>GenImage</strong></div><span className="divider" aria-hidden="true" /><Button ref={newRef} data-testid="genimage-new" onClick={event => open("create", event.currentTarget)}>+ {s.newGeneration}</Button></header>
    <nav className="floating top-actions" aria-label={s.settingsTitle}>
      <Button variant="ghost" data-testid="genimage-history" aria-label={s.history} aria-expanded={panel?.id === "history"} onClick={event => open("history", event.currentTarget)}>{s.history}</Button>
      <Button variant="ghost" data-testid="genimage-settings" aria-label={s.settings} aria-expanded={panel?.id === "settings"} onClick={event => open("settings", event.currentTarget)}>{s.settings}</Button>
    </nav>
    <div className="dev-note"><p className="eyebrow muted">GenImage</p><p>{s.wordmarkSub}</p><p className="small muted description">{a.title}</p></div>
    <section className="floating app-state" data-testid="genimage-state" aria-live="polite" aria-busy={reading}>
      <p className={readError ? "error" : "small"}>{statusText}</p>
      {snapshot && !snapshot.settings.configured ? <p className="small muted">{a.setup}</p> : snapshot && !jobs.length ? <p className="small muted">{a.emptyHint}</p> : null}
      {jobs.filter(job => job.status === "running").map(job => <p className="small muted detail-prompt" key={job.id} data-job-id={job.id} data-job-status={job.status}>{job.prompt} · {job.modelId} · {a.running}</p>)}
      <Button data-testid="genimage-refresh" variant="outline" disabled={reading || submitting} onClick={() => void refresh()}>{a.refresh}</Button>
    </section>
    <nav className="floating zoom" aria-label={s.helpZoom[0]}><Button variant="ghost" aria-label={s.zoomOut} onClick={() => zoom(1 / 1.2)}>−</Button><output>{Math.round(camera.scale * 100)}%</output><Button variant="ghost" aria-label={s.zoomIn} onClick={() => zoom(1.2)}>+</Button><span className="divider" /><Button variant="ghost" aria-label={s.fitAll} onClick={fit}>{s.fitAllShort}</Button></nav>
    <p className="canvas-help">{s.canvasHelp}</p>
    <div className="floating session-state"><span className="status-dot" aria-hidden="true" /><span className="host-label">{s.hostConnected}</span><Button ref={helpRef} variant="ghost" size="icon" aria-label={s.helpTitle} onClick={event => open("help", event.currentTarget)}>?</Button></div>
    {panel ? <section ref={panelRef} className="floating panel" role="dialog" aria-labelledby="panel-title" tabIndex={-1}>
      <div className="panel-head"><h2 id="panel-title">{title}{panel.id === "history" ? <span className="badge">{jobs.length}</span> : null}</h2><Button ref={closeRef} variant="ghost" size="icon" aria-label={s.closePanel(title)} onClick={close}>×</Button></div>
      {panel.id === "create" ? <form className="panel-body" onSubmit={submit}>
        <div className="field"><Label htmlFor="prompt">{s.promptLabelNew}</Label><Textarea ref={promptRef} id="prompt" data-testid="genimage-prompt" value={prompt} maxLength={4000} disabled={submitting} onChange={event => setPrompt(event.target.value)} placeholder={s.promptPlaceholder} aria-describedby="prompt-help" /><p id="prompt-help" className="panel-caption">{a.promptHelp}</p></div>
        <div className="field"><Label htmlFor="model">{s.modelLabel}</Label><Input id="model" value="gpt-image-1" readOnly /></div>
        <div className="notice">{snapshot?.settings.configured ? a.cost : a.setup}</div>
        {busy ? <p className="small muted">{a.busy}</p> : null}
        <Button data-testid="genimage-generate" type="submit" className="full" disabled={!prompt.trim() || !snapshot?.settings.configured || busy || submitting || reading || readError}>{submitting ? a.submitting : a.generate}</Button>
      </form> : panel.id === "history" ? <><p className="history-caption small muted">{a.historyHint}</p>{!jobs.length ? <p className="panel-body small muted">{a.noHistory}</p> : <ol className="history-list">{jobs.map(job => <li key={job.id} data-job-id={job.id} data-job-status={job.status}>
        <Button variant="ghost" className="history-row" disabled={!job.asset} onClick={() => { setPanel(null); focus(job.id); }}>{preview(job)}<span className="history-copy"><strong>{job.prompt}</strong><span>{job.modelId}</span><span>{a[job.status]}</span>{job.status === "succeeded" && !job.asset ? <span>{a.noPreview}</span> : null}</span></Button>
        {job.error ? <p className="history-caption error">{job.error}</p> : null}
      </li>)}</ol>}</> : panel.id === "inspector" ? <div className="panel-body">{selectedJob ? <>
        {preview(selectedJob, "detail-art")}<p className="small detail-prompt">{selectedJob.prompt}</p><dl><dt>{s.modelLabel}</dt><dd>{selectedJob.modelId}</dd><dt>{a.status}</dt><dd>{a[selectedJob.status]}</dd></dl>
        <Button data-testid="genimage-export" className="full" disabled={exporting || !selectedJob.asset} onClick={() => void exportImage(selectedJob.asset!.id)}>{exporting ? a.saving : s.exportPng}</Button><p className="small muted">{a.inspectorNote}</p>
      </> : <p className="small muted">{a.noPreview}</p>}</div> : panel.id === "settings" ? <div className="panel-body">
        <div className="setting-row"><span>{s.settingsMode}</span><span className="badge">{a.mode}</span></div><div className="setting-row"><span>{s.settingsProvider}</span><span>OpenAI Images</span></div><div className="setting-row"><span>{s.modelLabel}</span><span>gpt-image-1</span></div><div className="setting-row"><span>{s.settingsCredential}</span><span>{snapshot?.settings.configured ? a.configured : a.unconfigured}</span></div><div className="setting-row"><span>{s.settingsTheme}</span><span>{s.settingsThemeValue}</span></div><div className="notice">{a.setup}</div><p className="small muted">{a.memory}</p>
      </div> : <div className="panel-body"><div className="shortcut-list">{[s.helpPan, s.helpMove, s.helpZoom, s.helpFit, s.helpNew, s.helpSelect, s.helpNudge, s.helpClose].map(([label, shortcut]) => <div key={label}><span>{label}</span><kbd>{shortcut}</kbd></div>)}</div></div>}
    </section> : null}
    <div id="toast" role="status" aria-live="polite" aria-atomic="true">{notice ? a[notice] : ""}</div>
  </div>;
}
