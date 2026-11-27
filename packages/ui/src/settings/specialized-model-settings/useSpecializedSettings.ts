import { useEffect, useState } from "react";
import { useServices } from "@/hooks/useServices.js";

export function useSpecializedModelSettingsService() {
  return useServices().specializedModelSettingsService;
}

export function useSpecializedSettings<View>(
  read: () => Promise<View | undefined>,
  sourceRevision?: number,
) {
  const [view, setView] = useState<View>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let current = true;
    void read().then(
      (result) => {
        if (current) {
          setView(result);
          setError(undefined);
        }
      },
      () => {
        if (current) setError("read");
      },
    );
    return () => {
      current = false;
    };
  }, [read, refreshCount, sourceRevision]);

  async function mutate(write: () => Promise<View>) {
    setPending(true);
    setError(undefined);
    try {
      const result = await write();
      setView(result);
      return result;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "write");
    } finally {
      setPending(false);
    }
  }

  return { view, error, pending, mutate, refresh: () => setRefreshCount((count) => count + 1) };
}
