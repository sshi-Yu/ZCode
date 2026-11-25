import { useId } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import type {
  ImageGenerationProtocol,
  ImageGenerationSettingsProps,
  ImageGenerationTestResult,
} from "./contract.js";
import { imageServiceError } from "./imageText.js";
import { ImageModelEditor, imageSettingsSelectClass } from "./ImageModelEditor.js";
import { protocolModel, selectionValue, validModels } from "./settingsDraft.js";
import { useImageSettings } from "./useImageSettings.js";

export function ImageGenerationSettings(props: ImageGenerationSettingsProps) {
  const state = useImageSettings(props);
  const { text, imageText, locale, draft, selected, configuration, busy, dirty } = state;
  const id = useId();
  const canTest = Boolean(
    selected?.enabled && selected.configured && !dirty && !busy && !state.trialRunning,
  );
  function result(result: ImageGenerationTestResult | undefined, title: string) {
    return (
      <article
        className="min-w-0 rounded-lg border border-border p-3 text-ui-sm"
        data-testid={title === text.probeResult ? "genimage-last-probe" : "genimage-last-trial"}
      >
        <h4 className="font-medium">{title}</h4>
        {result ? (
          <div className="mt-1 space-y-1 [overflow-wrap:anywhere]">
            <p
              className={
                result.status === "failed"
                  ? "text-destructive"
                  : result.status === "outcome_unknown"
                    ? "text-warning"
                    : "text-foreground"
              }
            >
              {text[result.status]}
            </p>
            <p className="text-foreground-subtle">
              {text.revision}: {result.revision} ·{" "}
              {selected?.revision !== result.revision || state.connectionDirty
                ? text.oldResult
                : text.currentResult}
            </p>
            {result.modelKey ? (
              <p>
                {text.resultModel}:{" "}
                {selected?.models.find((model) => model.modelKey === result.modelKey)?.modelId ??
                  result.modelKey}
              </p>
            ) : null}
            <p className="text-foreground-subtle">
              {text.duration}: {new Intl.NumberFormat(locale).format(result.durationMs)} ms ·{" "}
              {text.ranAt}:{" "}
              {new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(
                result.ranAt,
              )}
            </p>
            {result.code ? <p>{imageServiceError(imageText, { code: result.code })}</p> : null}
          </div>
        ) : (
          <p className="mt-1 text-foreground-subtle">{text.noResult}</p>
        )}
      </article>
    );
  }
  return (
    <section
      data-testid="genimage-settings"
      className="@container min-w-0 space-y-5 text-ui-base"
      aria-label={text.title}
      aria-busy={state.loading || busy}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-ui-lg font-medium">{text.title}</h2>
          <p className="text-ui-sm text-foreground-subtle">{text.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || state.loading}
            onClick={state.reload}
          >
            {text.refresh}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="genimage-add-connection"
            disabled={busy || !configuration}
            onClick={state.addConnection}
          >
            {text.addConnection}
          </Button>
        </div>
      </header>
      {state.loading ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {text.loading}
        </p>
      ) : null}
      {state.loadFailed ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {text.loadFailed}
        </p>
      ) : null}
      {configuration && !state.loading ? (
        <>
          {configuration.connections.length ? (
            <div className="space-y-1">
              <label htmlFor={`${id}-connection`} className="text-ui-sm text-foreground-subtle">
                {text.connection}
              </label>
              <select
                id={`${id}-connection`}
                data-testid="genimage-connection-select"
                className={imageSettingsSelectClass}
                disabled={busy}
                value={state.selectedId ?? ""}
                onChange={(event) => state.chooseConnection(event.currentTarget.value)}
              >
                {!selected ? <option value="">{text.newConnection}</option> : null}
                {configuration.connections.map((connection) => (
                  <option key={connection.connectionId} value={connection.connectionId}>
                    {connection.name} ·{" "}
                    {connection.configured ? text.configured : text.unconfigured}
                  </option>
                ))}
              </select>
            </div>
          ) : !draft ? (
            <p className="rounded-xl border border-border p-4 text-ui-sm text-foreground-subtle">
              {text.empty}
            </p>
          ) : null}
          {draft ? (
            <>
              <fieldset disabled={busy} className="min-w-0 space-y-4">
                <div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor={`${id}-name`} className="text-ui-sm text-foreground-subtle">
                      {text.name}
                    </label>
                    <Input
                      id={`${id}-name`}
                      maxLength={128}
                      value={draft.name}
                      onChange={(event) => state.update({ name: event.currentTarget.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`${id}-protocol`} className="text-ui-sm text-foreground-subtle">
                      {text.protocol}
                    </label>
                    <select
                      id={`${id}-protocol`}
                      data-testid="genimage-protocol"
                      className={imageSettingsSelectClass}
                      value={draft.protocol}
                      disabled={selected?.officialPreset}
                      onChange={(event) => {
                        const protocol = event.currentTarget.value as ImageGenerationProtocol;
                        state.update({
                          protocol,
                          models: draft.models.map((model) => protocolModel(model, protocol)),
                        });
                      }}
                    >
                      <option value="openai-images">{text.openaiProtocol}</option>
                      <option value="openai-images-b64">{text.base64Protocol}</option>
                    </select>
                  </div>
                </div>
                <label className="flex w-fit items-center gap-2 text-ui-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => state.update({ enabled: event.currentTarget.checked })}
                  />
                  {text.enabled}
                </label>
                {selected?.officialPreset ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    {text.official}
                    <br />
                    {text.officialHint}
                  </p>
                ) : null}
                <div className="space-y-1">
                  <label htmlFor={`${id}-base`} className="text-ui-sm text-foreground-subtle">
                    {text.baseUrl}
                  </label>
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={`${id}-base`}
                    readOnly={selected?.officialPreset}
                    maxLength={2048}
                    value={draft.baseUrl}
                    aria-invalid={!state.destination}
                    aria-describedby={`${id}-destination`}
                    onChange={(event) => state.update({ baseUrl: event.currentTarget.value })}
                  />
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
                  <div className="space-y-1">
                    <label
                      htmlFor={`${id}-generation`}
                      className="text-ui-sm text-foreground-subtle"
                    >
                      {text.generationPath}
                    </label>
                    <Input
                      {...TECHNICAL_INPUT_ATTRIBUTES}
                      id={`${id}-generation`}
                      maxLength={512}
                      readOnly={selected?.officialPreset}
                      value={draft.generationPath}
                      onChange={(event) =>
                        state.update({ generationPath: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`${id}-probe`} className="text-ui-sm text-foreground-subtle">
                      {text.probePath}
                    </label>
                    <Input
                      {...TECHNICAL_INPUT_ATTRIBUTES}
                      id={`${id}-probe`}
                      maxLength={512}
                      readOnly={selected?.officialPreset}
                      value={draft.probePath}
                      onChange={(event) => state.update({ probePath: event.currentTarget.value })}
                    />
                  </div>
                </div>
                <div
                  id={`${id}-destination`}
                  className="space-y-1 rounded-lg border border-border bg-surface p-3 text-ui-sm [overflow-wrap:anywhere]"
                  aria-live="polite"
                >
                  {state.destination ? (
                    <>
                      <p>
                        {text.destination}:{" "}
                        <span className="select-text">{state.destination.generationUrl}</span>
                      </p>
                      <p>
                        {text.probeDestination}:{" "}
                        <span className="select-text">{state.destination.probeUrl ?? "—"}</span>
                      </p>
                      {state.destination.duplicateVersion ? (
                        <p className="text-warning">{text.duplicateVersion}</p>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-destructive">{text.invalidDestination}</p>
                  )}
                </div>
                <p className="text-ui-sm text-foreground-subtle">
                  {text.auth}: Bearer · {selected?.configured ? text.configured : text.unconfigured}
                </p>
                <div className="space-y-1">
                  <label htmlFor={`${id}-credential`} className="text-ui-sm text-foreground-subtle">
                    {text.credentialAction}
                  </label>
                  <select
                    id={`${id}-credential`}
                    className={imageSettingsSelectClass}
                    value={draft.credentialAction}
                    onChange={(event) =>
                      state.update({
                        credentialAction: event.currentTarget
                          .value as typeof draft.credentialAction,
                        apiKey: "",
                      })
                    }
                  >
                    <option value="keep">{text.keep}</option>
                    <option value="replace">{text.replace}</option>
                    <option value="remove">{text.remove}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${id}-key`} className="text-ui-sm text-foreground-subtle">
                    {text.apiKey}
                  </label>
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    autoComplete="new-password"
                    id={`${id}-key`}
                    data-testid="genimage-api-key"
                    type="password"
                    maxLength={4096}
                    disabled={draft.credentialAction === "remove"}
                    value={draft.apiKey}
                    aria-describedby={`${id}-key-hint`}
                    onChange={(event) =>
                      state.update({
                        apiKey: event.currentTarget.value,
                        credentialAction: event.currentTarget.value ? "replace" : "keep",
                      })
                    }
                  />
                  <p id={`${id}-key-hint`} className="text-ui-sm text-foreground-subtle">
                    {text.keyHint}
                  </p>
                </div>
                {state.changedDestination && selected ? (
                  <p className="text-ui-sm text-warning">{text.destinationChanged}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="genimage-probe"
                    disabled={!canTest}
                    onClick={() => state.probe()}
                  >
                    {text.probe}
                  </Button>
                  <p className="min-w-0 flex-1 text-ui-sm text-foreground-subtle">
                    {text.probeHint}
                  </p>
                </div>
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{text.models}</h3>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="genimage-add-model"
                      disabled={draft.models.length >= 64}
                      onClick={() =>
                        state.update({
                          models: [
                            ...draft.models,
                            {
                              modelKey: crypto.randomUUID(),
                              modelId: "",
                              name: "",
                              enabled: true,
                              parameters: {},
                            },
                          ],
                        })
                      }
                    >
                      {text.addModel}
                    </Button>
                  </div>
                  {!draft.models.length ? (
                    <p className="text-ui-sm text-foreground-subtle">{text.noModels}</p>
                  ) : (
                    draft.models.map((model) => (
                      <ImageModelEditor
                        key={model.modelKey}
                        model={model}
                        protocol={draft.protocol}
                        text={text}
                        disabled={busy}
                        canTest={canTest}
                        isDefault={Boolean(
                          selected &&
                          state.defaultValue ===
                            selectionValue({
                              connectionId: selected.connectionId,
                              modelKey: model.modelKey,
                            }),
                        )}
                        onChange={(next) =>
                          state.update({
                            models: draft.models.map((current) =>
                              current.modelKey === next.modelKey ? next : current,
                            ),
                          })
                        }
                        onDelete={() =>
                          state.update({
                            models: draft.models.filter(
                              (current) => current.modelKey !== model.modelKey,
                            ),
                          })
                        }
                        onProbe={() => state.probe(model.modelKey)}
                        onTrial={() => state.startTrial(model)}
                      />
                    ))
                  )}
                  {!validModels(draft.models) ? (
                    <p className="text-ui-sm text-destructive">{text.invalidModels}</p>
                  ) : null}
                  <p className="text-ui-sm text-foreground-subtle">{text.format}</p>
                </div>
              </fieldset>
            </>
          ) : null}
          <div className="space-y-1 border-t border-border pt-4">
            <label htmlFor={`${id}-default`} className="text-ui-sm text-foreground-subtle">
              {text.defaultModel}
            </label>
            <select
              id={`${id}-default`}
              data-testid="genimage-default-model"
              className={imageSettingsSelectClass}
              disabled={busy}
              value={state.defaultValue}
              aria-invalid={!state.defaultValid}
              onChange={(event) => state.setDefaultValue(event.currentTarget.value)}
            >
              <option value="">{text.noDefault}</option>
              {!state.defaultValid ? (
                <option value={state.defaultValue} disabled>
                  {text.defaultInvalid}
                </option>
              ) : null}
              {state.choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            <p
              className={`text-ui-sm ${state.defaultValid ? "text-foreground-subtle" : "text-destructive"}`}
            >
              {state.defaultValid ? text.defaultHint : text.defaultInvalid}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid="genimage-save-settings"
              size="sm"
              disabled={!state.canSave || busy}
              onClick={state.save}
            >
              {busy ? text.pending : text.save}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!dirty || busy}
              onClick={state.discard}
            >
              {text.discard}
            </Button>
            {selected ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={busy || state.connectionDirty}
                onClick={state.deleteConnection}
              >
                {text.deleteConnection}
              </Button>
            ) : null}
          </div>
          {dirty ? (
            <p className="text-ui-sm text-foreground-subtle" role="status">
              {text.saveFirst}
            </p>
          ) : selected && (!selected.enabled || !selected.configured) ? (
            <p className="text-ui-sm text-foreground-subtle">{text.unavailable}</p>
          ) : null}
          {selected ? (
            <section className="space-y-2" aria-label={text.results}>
              <h3 className="font-medium">{text.results}</h3>
              <div className="grid min-w-0 grid-cols-1 gap-3 @xl:grid-cols-2">
                {result(selected.lastProbe, text.probeResult)}
                {result(selected.lastTrial, text.trialResult)}
              </div>
            </section>
          ) : null}
          {state.trial ? (
            <section className="space-y-2 text-ui-sm" aria-label={text.trialResult}>
              <p role="status">
                {!state.trial.job
                  ? imageText.receiptUnconfirmed
                  : state.trialRunning
                    ? text.generating
                    : text[
                        state.trial.job.status === "outcome_unknown"
                          ? "outcome_unknown"
                          : state.trial.job.status === "succeeded"
                            ? "succeeded"
                            : "failed"
                      ]}
              </p>
              {state.trial.job?.errorCode ? (
                <p className="text-destructive">
                  {imageServiceError(imageText, { code: state.trial.job.errorCode })}
                </p>
              ) : null}
              {state.resultReadFailed ? (
                <>
                  <p role="alert">{text.readResultFailed}</p>
                  <Button type="button" size="sm" variant="outline" onClick={state.retryResult}>
                    {text.retryResult}
                  </Button>
                </>
              ) : null}
              {state.preview && !state.previewFailed ? (
                <img
                  src={state.preview}
                  alt={text.preview}
                  className="max-h-64 max-w-full rounded-lg border border-border object-contain"
                  onError={() => state.setPreviewFailed(true)}
                />
              ) : state.previewFailed ? (
                <p>{text.previewFailed}</p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
