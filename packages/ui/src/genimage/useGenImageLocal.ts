import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import type {
  GenImageBoard,
  GenImageNode,
  IGenImageService,
  FeatureModelSettingsView,
  ImageModelSettingsView,
} from "./contract.js";
import { GENIMAGE_ASSET_MAX_BYTES } from "./contract.js";

export type LoadThumbnail = (id: string, signal: AbortSignal) => Promise<string | undefined>;
type GenerateInput = Omit<Parameters<IGenImageService["generate"]>[0], "scope" | "requestId">;
type Position = Pick<GenImageNode, "x" | "y">;

function createThumbnailLoader(load: (id: string) => Promise<string>): LoadThumbnail {
  const cache = new Map<string, string>();
  const inFlight = new Map<string, Promise<string | undefined>>();
  const queue: Array<() => void> = [];
  let running = 0;

  function runQueue() {
    while (running < 4 && queue.length > 0) queue.shift()?.();
  }

  return (id, signal) =>
    new Promise((resolve) => {
      queue.push(() => {
        if (signal.aborted) {
          resolve(undefined);
          return;
        }
        const cached = cache.get(id);
        if (cached) {
          resolve(cached);
          return;
        }
        const existing = inFlight.get(id);
        if (existing) {
          resolve(existing);
          return;
        }
        running += 1;
        const request = load(id).then(
          (url) => {
            cache.set(id, url);
            if (cache.size > 64) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            return url;
          },
          () => undefined,
        );
        inFlight.set(id, request);
        resolve(request);
        void request.then(() => {
          inFlight.delete(id);
          running -= 1;
          runQueue();
        });
      });
      runQueue();
    });
}

export function useGenImageService() {
  return useOptionalServices()?.genImageService;
}

export function useGenImageModel(active: boolean) {
  const service = useOptionalServices()?.specializedModelSettingsService;
  const [settings, setSettings] = useState<ImageModelSettingsView>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || !service) return;
    let current = true;
    void service.getImageSettings().then(
      (settings) => {
        if (current) setSettings(settings);
      },
      () => {
        if (current) setSettings(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [active, attempt, service]);
  const model = settings?.models.find((model) => model.id === settings.defaultId);
  return { model, revision: settings?.revision, refresh: () => setAttempt((value) => value + 1) };
}

export function useGenImageLocal(service: IGenImageService | undefined, scope: string) {
  const saveFile = useOptionalPlatform()?.saveFile;
  const [board, setBoard] = useState<GenImageBoard>();
  const [loadError, setLoadError] = useState(false);
  const [loadingAttempt, setLoadingAttempt] = useState(0);
  const [moveError, setMoveError] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [importing, setImporting] = useState(false);
  const [featurePending, setFeaturePending] = useState<string>();
  const [featureError, setFeatureError] = useState<{ id: string; code: string }>();
  const importPending = useRef(false);
  const activeFeature = useRef<string | undefined>(undefined);
  const [positions, setPositions] = useState<ReadonlyMap<string, Position>>(() => new Map());
  const activeRequest = useRef<string | null>(null);
  const retryRequest = useRef<{ id: string; input: GenerateInput } | null>(null);
  const pendingMoves = useRef(new Map<string, Promise<number | undefined>>());

  const applyBoard = useCallback((snapshot: GenImageBoard) => {
    setBoard((previous) =>
      previous && previous.revision > snapshot.revision ? previous : snapshot,
    );
  }, []);

  useEffect(() => {
    if (!service) return;
    let active = true;
    void service.getBoard({ scope }).then(
      (snapshot) => {
        if (active) applyBoard(snapshot);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [applyBoard, loadingAttempt, scope, service]);

  const nodes = useMemo(
    () =>
      board?.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, ...position } : node;
      }) ?? [],
    [board, positions],
  );

  function reload() {
    setLoadError(false);
    setLoadingAttempt((attempt) => attempt + 1);
  }

  async function generate(input: GenerateInput) {
    if (!service || !board || activeRequest.current) return;
    const retry = retryRequest.current;
    const sameDraft =
      retry &&
      retry.input.prompt === input.prompt &&
      retry.input.modelRevision === input.modelRevision;
    const request = sameDraft ? retry : { id: crypto.randomUUID(), input };
    activeRequest.current = request.id;
    retryRequest.current = request;
    setGenerating(true);
    setGenerateError("");
    try {
      const snapshot = await service.generate({
        scope,
        requestId: request.id,
        ...request.input,
      });
      applyBoard(snapshot);
      const node = snapshot.nodes.find((candidate) => candidate.id === request.id);
      if (!node) {
        setGenerateError("genimage.result-unknown");
        return;
      }
      retryRequest.current = null;
      return node;
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "genimage.result-unknown");
      reload();
      return undefined;
    } finally {
      if (activeRequest.current === request.id) {
        activeRequest.current = null;
        setGenerating(false);
      }
    }
  }

  function moveNode(node: GenImageNode, position: Position) {
    if (!service) return;
    setPositions((previous) => new Map(previous).set(node.id, position));
    setMoveError(false);
    const moves = pendingMoves.current;
    const earlier = moves.get(node.id) ?? Promise.resolve(node.version);
    const move = earlier.then(async (expectedVersion) => {
      if (expectedVersion === undefined) return;
      try {
        const snapshot = await service.moveNode({
          scope,
          nodeId: node.id,
          expectedVersion,
          ...position,
        });
        applyBoard(snapshot);
        return snapshot.nodes.find((candidate) => candidate.id === node.id)?.version;
      } catch {
        setMoveError(true);
        reload();
        return undefined;
      }
    });
    moves.set(node.id, move);
    void move.then(() => {
      if (moves.get(node.id) !== move) return;
      moves.delete(node.id);
      setPositions((previous) => {
        const next = new Map(previous);
        next.delete(node.id);
        return next;
      });
    });
  }

  async function importFiles(files: File[], place: () => Position) {
    if (!service || !board || importPending.current) return;
    importPending.current = true;
    setImporting(true);
    const imported: GenImageNode[] = [];
    let failed = 0;
    try {
      for (const file of files) {
        try {
          if (!file.size || file.size > GENIMAGE_ASSET_MAX_BYTES)
            throw new Error("Invalid file size");
          const requestId = crypto.randomUUID();
          const snapshot = await service.importAsset({
            scope,
            requestId,
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            ...place(),
          });
          applyBoard(snapshot);
          const node = snapshot.nodes.find(({ id }) => id === requestId);
          if (node) imported.push(node);
        } catch {
          failed++;
        }
      }
      return { imported, failed };
    } finally {
      importPending.current = false;
      setImporting(false);
    }
  }

  async function extractFeatures(nodeId: string, modelRevision: number, routeKey: string) {
    if (!service || activeFeature.current) return;
    activeFeature.current = nodeId;
    setFeaturePending(nodeId);
    setFeatureError(undefined);
    try {
      applyBoard(
        await service.extractFeatures({
          scope,
          nodeId,
          modelRevision,
          routeKey,
          requestId: crypto.randomUUID(),
        }),
      );
    } catch (error) {
      setFeatureError({
        id: nodeId,
        code: error instanceof Error ? error.message : "genimage.feature-failed",
      });
    } finally {
      activeFeature.current = undefined;
      setFeaturePending(undefined);
    }
  }

  function clearFeatureError() {
    setFeatureError(undefined);
  }

  const media = useMemo(() => {
    if (!service) return undefined;
    return {
      thumbnail: createThumbnailLoader(async (nodeId) => {
        const asset = await service.getAsset({ scope, nodeId, variant: "thumbnail" });
        return asset.url;
      }),
      original: (nodeId: string) => service.getAsset({ scope, nodeId, variant: "original" }),
      exportOriginal: saveFile
        ? async (node: GenImageNode) => {
            const bytes = await service.readOriginal({ scope, nodeId: node.id });
            return saveFile({
              data: Uint8Array.from(bytes).buffer,
              suggestedName: node.fileName ?? `image-${node.id.slice(0, 8)}.png`,
            });
          }
        : undefined,
    };
  }, [saveFile, scope, service]);

  return {
    nodes,
    media,
    ready: board !== undefined,
    loadError,
    reload,
    moveError,
    moveNode,
    generating,
    generateError,
    resetRequest: () => {
      if (activeRequest.current) return;
      retryRequest.current = null;
      setGenerateError("");
    },
    generate,
    importing,
    importFiles,
    extractFeatures,
    featurePending,
    featureError,
    clearFeatureError,
    unconfirmed: board?.unconfirmed ?? 0,
  };
}

export type GenImageMedia = NonNullable<ReturnType<typeof useGenImageLocal>["media"]>;

export function useGenImageFeatureModel(active: boolean) {
  const service = useOptionalServices()?.specializedModelSettingsService;
  const [settings, setSettings] = useState<FeatureModelSettingsView>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!service || !active) return;
    let current = true;
    void service.getFeatureModelSettings().then(
      (view) => {
        if (current) setSettings(view);
      },
      () => {
        if (current) setSettings(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [active, attempt, service]);
  return {
    settings,
    refresh: () => {
      setSettings(undefined);
      setAttempt((value) => value + 1);
    },
  };
}
