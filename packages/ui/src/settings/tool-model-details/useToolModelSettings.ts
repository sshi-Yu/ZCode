import { useCallback, useEffect, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatToolModelError } from "@/hooks/useGitActions.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { ToolModelReference, ToolModelSettingsView } from "./contract.js";

export function useToolModelSettings() {
  const service = useBaseWorkspaceServices().toolModelSettingsService;
  const [view, setView] = useState<ToolModelSettingsView | null>(null);
  const { locale } = useZCodeIntl();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    setView(null);
    setError(null);
    if (service)
      void service.getView().then(
        (next) => {
          if (active) setView(next);
        },
        () => {
          if (active) setError("");
        },
      );
    return () => {
      active = false;
    };
  }, [service]);
  const refresh = useCallback(async () => {
    if (!service) return;
    setError(null);
    try {
      setView(await service.getView());
    } catch {
      setError("");
    }
  }, [service]);
  const save = useCallback(
    async (selection: ToolModelReference | null) => {
      if (!service || !view || pending) return false;
      setPending(true);
      setError(null);
      try {
        setView(
          await service.saveBinding({
            toolId: "git-commit-message",
            expectedRevision: view.revision,
            selection,
          }),
        );
        return true;
      } catch (error) {
        setError(formatToolModelError(error, locale) ?? "");
        return false;
      } finally {
        setPending(false);
      }
    },
    [locale, pending, service, view],
  );
  return { available: Boolean(service), view, error, pending, save, refresh };
}
