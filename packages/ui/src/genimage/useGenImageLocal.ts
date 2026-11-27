import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import type { GenImageBoard, GenImageNode, IGenImageService } from "./contract.js";

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

export function useGenImageLocal(service: IGenImageService | undefined, scope: string) {
  const saveFile = useOptionalPlatform()?.saveFile;
  const [board, setBoard] = useState<GenImageBoard>();
  const [loadError, setLoadError] = useState(false);
  const [loadingAttempt, setLoadingAttempt] = useState(0);
  const [moveError, setMoveError] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(false);
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
      retry.input.sourceId === input.sourceId &&
      retry.input.prompt === input.prompt &&
      retry.input.ratio === input.ratio;
    const request = sameDraft ? retry : { id: crypto.randomUUID(), input };
    activeRequest.current = request.id;
    retryRequest.current = request;
    setGenerating(true);
    setGenerateError(false);
    try {
      const snapshot = await service.generate({ scope, requestId: request.id, ...request.input });
      applyBoard(snapshot);
      const node = snapshot.nodes.find((candidate) => candidate.id === request.id);
      if (!node) {
        setGenerateError(true);
        return;
      }
      retryRequest.current = null;
      return node;
    } catch {
      setGenerateError(true);
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

  const media = useMemo(() => {
    if (!service) return undefined;
    return {
      thumbnail: createThumbnailLoader(async (nodeId) => {
        const asset = await service.getAsset({ scope, nodeId, variant: "thumbnail" });
        return asset.url;
      }),
      original: (nodeId: string) => service.getAsset({ scope, nodeId, variant: "original" }),
      exportPng: saveFile
        ? async (nodeId: string) => {
            const bytes = await service.readOriginal({ scope, nodeId });
            return saveFile({
              data: Uint8Array.from(bytes).buffer,
              suggestedName: `genimage-${nodeId}.png`,
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
    generate,
  };
}

export type GenImageMedia = NonNullable<ReturnType<typeof useGenImageLocal>["media"]>;
