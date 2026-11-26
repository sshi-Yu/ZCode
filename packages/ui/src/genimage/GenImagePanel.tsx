import { GitFork, Plus, X } from "lucide-react";
import type { HTMLAttributes, Ref } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { FixtureArtwork, MAX_NODES, ratios, type ImageNode, type Ratio } from "./fixture.js";
import type { GenImageText } from "./text.js";

export type PanelKind = "create" | "details" | "history" | "settings" | "help";

interface GenImagePanelProps {
  kind: PanelKind;
  text: GenImageText;
  nodes: readonly ImageNode[];
  source?: ImageNode;
  selected?: ImageNode;
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

export function GenImagePanel({
  kind,
  text,
  nodes,
  source,
  selected,
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
              <FixtureArtwork node={source} className="gi-source-art" />
              <div>
                <strong>
                  {text.source} {source.id} · {source.title}
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
              onChange={(event) => onChangePrompt(event.currentTarget.value)}
              data-testid="genimage-prompt"
            />
            <span className="gi-caption">{text.formNote}</span>
          </label>
          <div className="gi-form-grid">
            <label className="gi-field">
              {text.model}
              <Input value={text.fixtureModel} readOnly />
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
                    onClick={() => onChangeRatio(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <p className="gi-notice">{text.dataNote}</p>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={!prompt.trim() || nodes.length >= MAX_NODES}
            data-testid="genimage-submit"
          >
            {source ? <GitFork /> : <Plus />}
            {source ? text.submitDerive : text.submit}
          </Button>
          <p className="gi-caption">{text.limit(MAX_NODES)}</p>
        </form>
      ) : null}
      {kind === "details" && selected ? (
        <div className="gi-panel-body">
          <FixtureArtwork node={selected} className="gi-detail-art" />
          <div>
            <h3>
              {selected.id} · {selected.title}
            </h3>
            <p className="gi-caption wrap-anywhere">{selected.prompt}</p>
          </div>
          <dl className="gi-settings">
            <dt>{text.ratio}</dt>
            <dd>{selected.ratio}</dd>
            <dt>{text.model}</dt>
            <dd>{text.fixtureModel}</dd>
          </dl>
          <div>
            <p className="gi-caption">{text.lineage}</p>
            <div className="gi-relations">
              {selected.source ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onLocate(selected.source!, false)}
                >
                  {text.source} {selected.source}
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
                    {node.id} · {node.title}
                  </Button>
                ))}
            </div>
          </div>
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={(event) => onDerive(selected.id, event.currentTarget)}
          >
            <GitFork />
            {text.derive}
          </Button>
          <div className="gi-form-grid">
            <Button variant="outline" disabled>
              {text.export}
            </Button>
            <Button variant="outline" disabled>
              {text.reference}
            </Button>
          </div>
          <p className="gi-caption">{text.dataNote}</p>
        </div>
      ) : null}
      {kind === "history" ? (
        <div className="gi-panel-body gi-history">
          <p className="gi-caption">{text.historyNote}</p>
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
                  <FixtureArtwork node={node} className="gi-history-art" />
                  <span>
                    <strong>
                      {node.id} · {node.title}
                    </strong>
                    <span className="gi-caption">
                      {node.source ? `${text.derived} ${node.source}` : text.root} · {node.ratio}
                    </span>
                  </span>
                  <FixtureBadge>{text.fixture}</FixtureBadge>
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
            <dd>{text.fixture}</dd>
            <dt>{text.provider}</dt>
            <dd>{text.notConnected}</dd>
            <dt>{text.appearance}</dt>
            <dd>{text.followsApp}</dd>
          </dl>
          <p className="gi-notice">{text.dataNote}</p>
          <p className="gi-caption">{text.reset}</p>
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
