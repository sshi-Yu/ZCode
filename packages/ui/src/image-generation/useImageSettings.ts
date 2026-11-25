import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderDetailFeedback } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import type {
  ImageGenerationConfiguration,
  ImageGenerationJob,
  ImageGenerationModelConfig,
  ImageGenerationPublicConnection,
  ImageGenerationSettingsProps,
} from "./contract.js";
import {
  getImageText,
  imageConfirmation,
  imageServiceError,
  isImageAdmissionRejection,
} from "./imageText.js";
import {
  connectionDraft,
  destinationChanged,
  destinationPreview,
  parseSelection,
  selectionValue,
  validModels,
  type ImageConnectionDraft,
} from "./settingsDraft.js";
import { getImageSettingsText } from "./settingsText.js";

export function useImageSettings({ onDirtyChange }: ImageGenerationSettingsProps) {
  const service = useBaseWorkspaceServices().imageGenerationService;
  const { locale } = useZCodeIntl();
  const text = getImageSettingsText(locale);
  const imageText = getImageText(locale);
  const confirm = useConfirmDialog();
  const { showFeedback } = useProviderDetailFeedback();
  const [configuration, setConfiguration] = useState<ImageGenerationConfiguration>();
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<ImageConnectionDraft>();
  const [defaultValue, setDefaultValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState<{ requestId: string; job: ImageGenerationJob | null }>();
  const [resultReadFailed, setResultReadFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [preview, setPreview] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const pendingConfirmation = useRef<AbortController | null>(null);
  const selected = configuration?.connections.find(
    (connection) => connection.connectionId === selectedId,
  );
  const connectionDirty = Boolean(
    draft && (!selected || JSON.stringify(draft) !== JSON.stringify(connectionDraft(selected))),
  );
  const defaultDirty = Boolean(
    configuration && defaultValue !== selectionValue(configuration.defaultSelection.selection),
  );
  const dirty = connectionDirty || defaultDirty;
  const destination = draft ? destinationPreview(draft) : null;
  const changedDestination = Boolean(draft && destinationChanged(selected, draft));
  const choices = (configuration?.connections ?? []).flatMap((connection) => {
    const current = connection.connectionId === selectedId && draft ? draft : connection;
    return current.enabled
      ? current.models
          .filter((model) => model.enabled)
          .map((model) => ({
            value: selectionValue({
              connectionId: connection.connectionId,
              modelKey: model.modelKey,
            }),
            label: `${current.name} · ${model.name}`,
          }))
      : [];
  });
  const defaultValid = !defaultValue || choices.some((choice) => choice.value === defaultValue);
  const canSave = Boolean(
    configuration &&
    dirty &&
    defaultValid &&
    (!connectionDirty ||
      (draft &&
        draft.name.trim() &&
        destination &&
        validModels(draft.models) &&
        (draft.credentialAction !== "replace" || draft.apiKey.trim()) &&
        (!selected ||
          !changedDestination ||
          (draft.credentialAction === "replace" && draft.apiKey.trim())))),
  );

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    operation.current = false;
    return () => {
      controller.abort();
      pendingConfirmation.current?.abort();
      pendingConfirmation.current = null;
    };
  }, [service]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  const applyConfiguration = useCallback(
    (next: ImageGenerationConfiguration, preferredId?: string) => {
      const connection =
        next.connections.find((entry) => entry.connectionId === preferredId) ?? next.connections[0];
      setConfiguration(next);
      setSelectedId(connection?.connectionId);
      setDraft(connection ? connectionDraft(connection) : undefined);
      setDefaultValue(selectionValue(next.defaultSelection.selection));
      setLoadFailed(false);
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setConfiguration(undefined);
    setDraft(undefined);
    setTrial(undefined);
    setBusy(false);
    if (!service) {
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    void service
      .getConfiguration()
      .then((next) => {
        if (!disposed) applyConfiguration(next);
      })
      .catch(() => {
        if (!disposed) setLoadFailed(true);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [applyConfiguration, service]);

  const refreshResults = useCallback(async () => {
    if (!service) return;
    const scope = lifetime.current;
    const next = await service.getConfiguration();
    if (!scope?.signal.aborted) {
      // 只更新测试投影，不能把其他窗口的新修订当作本窗草稿的 CAS 基线。
      setConfiguration((current) =>
        current
          ? {
              ...current,
              connections: current.connections.map((connection) => {
                const latest = next.connections.find(
                  (entry) => entry.connectionId === connection.connectionId,
                );
                return latest
                  ? { ...connection, lastProbe: latest.lastProbe, lastTrial: latest.lastTrial }
                  : connection;
              }),
            }
          : current,
      );
    }
  }, [service]);

  const trialRunning = Boolean(trial && (!trial.job || trial.job.status === "running"));
  const trialRequestId = trial?.requestId;
  useEffect(() => {
    if (!service || !trialRequestId || !trialRunning) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setResultReadFailed(false);
    async function read() {
      try {
        const receipt = await service!.getRequest({ requestId: trialRequestId! });
        if (disposed) return;
        if (!receipt.job) {
          setResultReadFailed(true);
          return;
        }
        setTrial({ requestId: trialRequestId!, job: receipt.job });
        if (receipt.job.status === "running") timer = setTimeout(() => void read(), 1000);
        else void refreshResults().catch(() => undefined);
      } catch {
        if (!disposed) setResultReadFailed(true);
      }
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [readAttempt, refreshResults, service, trialRequestId, trialRunning]);

  const trialAssetId = trial?.job?.asset?.id;
  useEffect(() => {
    let disposed = false;
    setPreview(undefined);
    setPreviewFailed(false);
    if (service && trialAssetId)
      void service
        .readPreview({ assetId: trialAssetId })
        .then((result) => {
          if (!disposed) setPreview(result.preview);
        })
        .catch(() => {
          if (!disposed) setPreviewFailed(true);
        });
    return () => {
      disposed = true;
    };
  }, [service, trialAssetId]);

  function feedback(message: string, failure = false, successEmphasis = false) {
    showFeedback({
      key: "image-settings",
      message,
      state: failure ? "failure" : "success",
      successEmphasis,
    });
  }
  async function ask(input: Parameters<typeof confirm>[0]) {
    const controller = new AbortController();
    pendingConfirmation.current = controller;
    try {
      return (await confirm(input, controller.signal)) && !controller.signal.aborted;
    } finally {
      if (pendingConfirmation.current === controller) pendingConfirmation.current = null;
    }
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current || !lifetime.current) return;
    const scope = lifetime.current;
    operation.current = true;
    setBusy(true);
    try {
      await action(scope.signal);
    } catch (error) {
      if (!scope.signal.aborted) feedback(imageServiceError(imageText, error), true);
    } finally {
      if (!scope.signal.aborted) {
        operation.current = false;
        setBusy(false);
      }
    }
  }
  async function mayDiscard() {
    return (
      !dirty ||
      ask({
        intent: "genimage-settings-discard",
        title: text.discardTitle,
        description: text.discardDescription,
        confirmLabel: text.discard,
        cancelLabel: text.cancel,
        confirmVariant: "destructive",
      })
    );
  }
  function update(patch: Partial<ImageConnectionDraft>) {
    if (!operation.current) setDraft((current) => (current ? { ...current, ...patch } : current));
  }
  function chooseConnection(id: string) {
    void run(async (signal) => {
      if (!configuration || !(await mayDiscard()) || signal.aborted) return;
      const connection = configuration.connections.find((entry) => entry.connectionId === id);
      setSelectedId(connection?.connectionId);
      setDraft(connection ? connectionDraft(connection) : undefined);
      setDefaultValue(selectionValue(configuration.defaultSelection.selection));
      setTrial((current) => (current?.job === null ? current : undefined));
    });
  }
  function addConnection() {
    void run(async (signal) => {
      if (!configuration || !(await mayDiscard()) || signal.aborted) return;
      setSelectedId(undefined);
      setDraft({ ...connectionDraft(), name: text.newConnection });
      setDefaultValue(selectionValue(configuration.defaultSelection.selection));
      setTrial((current) => (current?.job === null ? current : undefined));
    });
  }
  function reload() {
    void run(async (signal) => {
      if (!service || !(await mayDiscard()) || signal.aborted) return;
      // 用户已明确放弃时立即销毁密钥草稿，刷新读取失败也不能恢复被放弃的输入。
      if (configuration) applyConfiguration(configuration, selectedId);
      setLoading(true);
      try {
        const next = await service.getConfiguration();
        if (!signal.aborted) {
          applyConfiguration(next, selectedId);
          setTrial((current) => (current?.job === null ? current : undefined));
        }
      } catch (error) {
        if (!signal.aborted) setLoadFailed(true);
        throw error;
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
  }
  function discard() {
    void run(async (signal) => {
      if (!configuration || !(await mayDiscard()) || signal.aborted) return;
      applyConfiguration(configuration, selectedId);
    });
  }
  function save() {
    void run(async (signal) => {
      if (!service || !configuration || !canSave) return;
      let saved: ImageGenerationPublicConnection | undefined;
      const defaultSelection = defaultDirty
        ? {
            expectedRevision: configuration.defaultSelection.revision,
            selection: parseSelection(defaultValue),
          }
        : undefined;
      if (connectionDirty && draft && destination) {
        if (
          changedDestination &&
          !(await ask({
            intent: "genimage-destination",
            title: text.confirmDestination,
            description: `${text.confirmDestinationDescription}\n${text.destination}: ${destination.generationUrl}\n${text.probeDestination}: ${destination.probeUrl ?? "—"}`,
            scrollableDescription: true,
            explicitConfirm: true,
            confirmLabel: text.save,
            cancelLabel: text.cancel,
          }))
        )
          return;
        if (signal.aborted) return;
        saved = await service.saveConnection({
          connectionId: selected?.connectionId,
          expectedRevision: selected?.revision ?? null,
          name: draft.name.trim(),
          enabled: draft.enabled,
          protocol: draft.protocol,
          auth: "bearer",
          baseUrl: destination.baseUrl,
          generationPath: draft.generationPath,
          probePath: draft.probePath || null,
          credential:
            draft.credentialAction === "replace"
              ? { action: "replace", apiKey: draft.apiKey.trim() }
              : { action: draft.credentialAction },
          models: draft.models.map((model) => ({
            ...model,
            name: model.name.trim(),
            modelId: model.modelId.trim(),
          })),
          ...(defaultSelection ? { defaultSelection } : {}),
        });
      } else if (defaultSelection) {
        const updatedDefault = await service.setDefaultSelection(defaultSelection);
        if (signal.aborted) return;
        applyConfiguration({ ...configuration, defaultSelection: updatedDefault }, selectedId);
        feedback(text.saved);
        return;
      }
      if (signal.aborted) return;
      // 保存已提交后立即清空临时密钥；后续只读刷新失败不能把已保存草稿留成可重发状态。
      const next = {
        ...configuration,
        connections: saved
          ? [
              ...configuration.connections.filter(
                (entry) => entry.connectionId !== saved.connectionId,
              ),
              saved,
            ]
          : configuration.connections,
        defaultSelection: defaultSelection
          ? {
              revision: defaultSelection.expectedRevision + 1,
              selection: defaultSelection.selection,
            }
          : configuration.defaultSelection,
      };
      applyConfiguration(next, saved?.connectionId ?? selectedId);
      feedback(text.saved);
      void refreshResults().catch(() => undefined);
    });
  }
  function deleteConnection() {
    void run(async (signal) => {
      if (!service || !configuration || !selected) return;
      if (parseSelection(defaultValue)?.connectionId === selected.connectionId || !defaultValid) {
        feedback(text.defaultInvalid, true);
        return;
      }
      if (
        !(await ask({
          intent: "genimage-delete-connection",
          title: text.deleteTitle,
          description: `${selected.name}\n${text.deleteDescription}`,
          confirmLabel: text.deleteConnection,
          cancelLabel: text.cancel,
          confirmVariant: "destructive",
        })) ||
        signal.aborted
      )
        return;
      const defaultSelection = defaultDirty
        ? {
            expectedRevision: configuration.defaultSelection.revision,
            selection: parseSelection(defaultValue),
          }
        : undefined;
      await service.deleteConnection({
        connectionId: selected.connectionId,
        expectedRevision: selected.revision,
        ...(defaultSelection ? { defaultSelection } : {}),
      });
      if (signal.aborted) return;
      applyConfiguration({
        ...configuration,
        connections: configuration.connections.filter(
          (entry) => entry.connectionId !== selected.connectionId,
        ),
        defaultSelection: defaultSelection
          ? {
              revision: defaultSelection.expectedRevision + 1,
              selection: defaultSelection.selection,
            }
          : configuration.defaultSelection,
      });
      setTrial((current) => (current?.job === null ? current : undefined));
      feedback(text.deleted);
    });
  }
  function probe(modelKey?: string) {
    void run(async (signal) => {
      if (!service || !selected || dirty) return;
      const result = await service.probeConnection({
        connectionId: selected.connectionId,
        revision: selected.revision,
        ...(modelKey ? { modelKey } : {}),
      });
      if (signal.aborted) return;
      setConfiguration((current) =>
        current
          ? {
              ...current,
              connections: current.connections.map((entry) =>
                entry.connectionId === selected.connectionId
                  ? { ...entry, lastProbe: result }
                  : entry,
              ),
            }
          : current,
      );
      feedback(
        result.code ? imageServiceError(imageText, { code: result.code }) : text[result.status],
        result.status === "failed",
        result.status === "succeeded",
      );
    });
  }
  function startTrial(model: ImageGenerationModelConfig) {
    void run(async (signal) => {
      if (!service || !selected || !configuration || dirty || trialRunning) return;
      const sample = configuration.testSample;
      const parameters = { ...model.parameters, ...sample.parameters };
      const frozen = {
        connectionId: selected.connectionId,
        modelKey: model.modelKey,
        revision: selected.revision,
        purpose: "test" as const,
        sampleVersion: sample.version,
        parameters,
      };
      if (
        !(await ask({
          intent: "genimage-trial",
          title: text.trialTitle,
          explicitConfirm: true,
          scrollableDescription: true,
          description: `${imageConfirmation(imageText, selected.generationUrl, model.modelId, parameters, sample.prompt)}\n${text.revision}: ${frozen.revision}\n${text.sampleVersion}: ${sample.version}\n${text.format}\n${text.trialLimits}`,
          confirmLabel: text.trialConfirm,
          cancelLabel: text.cancel,
        })) ||
        signal.aborted
      )
        return;
      const requestId = crypto.randomUUID();
      try {
        const { job } = await service.startGeneration({ ...frozen, requestId });
        if (signal.aborted) return;
        setTrial({ requestId, job });
        if (job.status !== "running") void refreshResults().catch(() => undefined);
      } catch (error) {
        if (isImageAdmissionRejection(error)) throw error;
        // 原请求的受理状态无法从 RPC 错误推断；效果及重试按钮只读同一请求 ID。
        if (!signal.aborted) setTrial({ requestId, job: null });
      }
    });
  }
  return {
    text,
    imageText,
    locale,
    configuration,
    selected,
    selectedId,
    draft,
    update,
    defaultValue,
    setDefaultValue,
    choices,
    defaultValid,
    dirty,
    connectionDirty,
    destination,
    changedDestination,
    canSave,
    loading,
    loadFailed,
    busy,
    chooseConnection,
    addConnection,
    reload,
    discard,
    save,
    deleteConnection,
    probe,
    startTrial,
    trial,
    trialRunning,
    resultReadFailed,
    retryResult: () => setReadAttempt((value) => value + 1),
    preview,
    previewFailed,
    setPreviewFailed,
  };
}
