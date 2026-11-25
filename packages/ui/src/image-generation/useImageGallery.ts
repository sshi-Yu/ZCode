import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IImageGenerationService,
  ImageGenerationConfiguration,
  ImageGenerationJob,
} from "./contract.js";

interface Gallery {
  jobs: ImageGenerationJob[];
  cursor: string | null;
}

export function useImageGallery(service: IImageGenerationService | undefined) {
  const [configuration, setConfiguration] = useState<ImageGenerationConfiguration>();
  const [configurationError, setConfigurationError] = useState(false);
  const [gallery, setGallery] = useState<Gallery>();
  const [historyError, setHistoryError] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [active, setActive] = useState<ImageGenerationJob | null>(null);
  const requestSequence = useRef({ history: 0, configuration: 0 });
  const activeId = useRef<string | undefined>(undefined);
  const refreshConfiguration = useCallback(async () => {
    if (!service) return;
    const sequence = ++requestSequence.current.configuration;
    try {
      const next = await service.getConfiguration();
      if (sequence !== requestSequence.current.configuration) return;
      setConfiguration(next);
      setConfigurationError(false);
    } catch {
      if (sequence === requestSequence.current.configuration) setConfigurationError(true);
    }
  }, [service]);
  const readHistory = useCallback(
    async (cursor?: string) => {
      if (!service) return;
      const sequence = ++requestSequence.current.history;
      setLoadingHistory(true);
      try {
        const page = await service.readHistory(cursor ? { cursor } : {});
        if (sequence !== requestSequence.current.history) return;
        setGallery((previous) => {
          if (!cursor || previous?.cursor !== cursor) {
            return { jobs: page.jobs, cursor: page.nextCursor };
          }
          const byId = new Map(previous.jobs.map((job) => [job.id, job]));
          for (const job of page.jobs) byId.set(job.id, job);
          return { jobs: [...byId.values()], cursor: page.nextCursor };
        });
        setHistoryError(false);
      } catch {
        if (requestSequence.current.history === sequence) setHistoryError(true);
      } finally {
        if (requestSequence.current.history === sequence) setLoadingHistory(false);
      }
    },
    [service],
  );
  const track = useCallback(
    (job: ImageGenerationJob) => {
      activeId.current = job.status === "running" ? job.id : undefined;
      setActive(job.status === "running" ? job : null);
      if (job.status !== "running") void readHistory();
    },
    [readHistory],
  );
  useEffect(() => {
    if (!service) return;
    const sequence = requestSequence.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const synchronize = async () => {
      try {
        const seen = activeId.current;
        const result = await service.readActive();
        if (!disposed && seen === activeId.current) {
          activeId.current = result.job?.id;
          setActive(result.job);
          if (seen && seen !== result.job?.id) void readHistory();
        }
      } catch {
        // 活动状态读取失败时保留上一回执，图库的独立读取提供可见的重试入口。
      } finally {
        if (!disposed) timer = setTimeout(() => void synchronize(), 1_500);
      }
    };
    const refresh = () => {
      void refreshConfiguration();
      void readHistory();
    };
    refresh();
    void synchronize();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      clearTimeout(timer);
      ++sequence.history;
      ++sequence.configuration;
      window.removeEventListener("focus", refresh);
    };
  }, [readHistory, refreshConfiguration, service]);
  return {
    configuration,
    configurationError,
    gallery,
    historyError,
    loadingHistory,
    active,
    readHistory,
    refreshConfiguration,
    track,
  };
}
