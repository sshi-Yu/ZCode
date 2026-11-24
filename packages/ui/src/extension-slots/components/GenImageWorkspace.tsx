import { useMemo, useRef } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useExtensionSlotsState,
  useExtensionsService,
  useReloadExtensions,
} from "@/extension-slots/adapters/useExtensionSlots.js";
import { ExtensionViewPane } from "@/extension-slots/components/ExtensionViewPane.js";
import type { ExtensionAppViewBridge } from "@/extension-slots/contract.js";

const pluginIds = ["genimage@genimage-local", "genimage@inline"];
const appTarget = { workspacePath: "", sessionId: null };
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const readArgs = z.strictObject({});
const generateArgs = z.strictObject({
  requestId: id,
  prompt: z.string().trim().min(1).max(4000),
  modelId: z.literal("gpt-image-1"),
});
const exportArgs = z.strictObject({ assetId: id });

interface GenImageWorkspaceProps {
  onOpenSettings(): void;
  onOpenPluginStore(): void;
}

export function GenImageWorkspace({ onOpenSettings, onOpenPluginStore }: GenImageWorkspaceProps) {
  const { intl } = useZCodeIntl();
  const intlRef = useRef(intl);
  intlRef.current = intl;
  const extensions = useExtensionsService();
  const reload = useReloadExtensions();
  const imageGeneration = useBaseWorkspaceServices().imageGenerationService;
  const requestConfirmation = useConfirmDialog();
  const saveFile = usePlatform().saveFile;
  const { waiting, stopped, view, activation } = useExtensionSlotsState(extensions, (state) => {
    const candidates = pluginIds.map((pluginId) =>
      state.table?.plugins.find((entry) => entry.pluginId === pluginId),
    );
    // 只信任明确选定的安装身份；旧清单不能遮住另一个已就绪的候选。
    const plugin =
      candidates.find(
        (entry) =>
          entry?.extension?.state === "ok" &&
          !entry.activation &&
          entry.extension.views.some(
            (candidate) =>
              candidate.id === `${entry.pluginId}/workspace` && candidate.scope === "app",
          ),
      ) ?? candidates.find((entry) => entry !== undefined);
    const view =
      plugin?.extension?.state === "ok" && !plugin.activation
        ? plugin.extension.views.find(
            (entry) => entry.id === `${plugin.pluginId}/workspace` && entry.scope === "app",
          )
        : undefined;
    return {
      waiting: state.table === null,
      view,
      activation: plugin?.activation,
      stopped: state.status?.state === "stopped",
    };
  });
  const appBridge = useMemo<ExtensionAppViewBridge | undefined>(() => {
    if (!imageGeneration) return undefined;
    let exporting = false;
    return {
      hostContext: { zcodeGenImage: true },
      async callTool(name, args, signal) {
        const intl = intlRef.current;
        switch (name) {
          case "genimage_read": {
            readArgs.parse(args);
            const [settings, { jobs }] = await Promise.all([
              imageGeneration.getSettings(),
              imageGeneration.read(),
            ]);
            return { settings, jobs };
          }
          case "genimage_generate": {
            const command = generateArgs.parse(args);
            const settings = await imageGeneration.getSettings();
            if (signal.aborted || !settings.configured || settings.modelId !== command.modelId) {
              return { accepted: false };
            }
            // 只有绑定到本主区沙箱的意图可到达这里。确认与提交共用解析后的参数。
            const confirmed = await requestConfirmation(
              {
                intent: "genimage-generate",
                explicitConfirm: true,
                title: intl.formatMessage({ id: "genimage.confirm.title" }),
                description: intl.formatMessage(
                  { id: "genimage.confirm.description" },
                  { model: command.modelId, prompt: command.prompt },
                ),
                scrollableDescription: true,
                confirmLabel: intl.formatMessage({ id: "genimage.confirm.submit" }),
              },
              signal,
            );
            if (!confirmed || signal.aborted) return { accepted: false };
            await imageGeneration.start(command);
            return { accepted: true };
          }
          case "genimage_export": {
            const { assetId } = exportArgs.parse(args);
            if (!saveFile || exporting) return { saved: false };
            exporting = true;
            try {
              const png = await imageGeneration.readImage({ assetId });
              if (signal.aborted) return { saved: false };
              const result = await saveFile({
                suggestedName: `genimage-${assetId}.png`,
                data: Uint8Array.from(png).buffer,
              });
              if (!result.success && !result.canceled) {
                throw new Error(intl.formatMessage({ id: "genimage.export.failed" }));
              }
              return { saved: result.success };
            } finally {
              exporting = false;
            }
          }
          default:
            throw new Error("Unknown GenImage workspace tool");
        }
      },
    };
  }, [imageGeneration, requestConfirmation, saveFile]);

  return (
    <div data-testid="genimage-workspace" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 justify-end px-3 py-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="genimage-open-model-settings"
          onClick={onOpenSettings}
        >
          {intl.formatMessage({ id: "genimage.modelSettings" })}
        </Button>
      </div>
      {view && appBridge && !stopped ? (
        <ExtensionViewPane
          tab={{
            id: `extension-view:${view.id}`,
            type: "extension-view",
            viewId: view.id,
            title: view.title,
            appScoped: true,
          }}
          target={appTarget}
          visible
          appBridge={appBridge}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-ui-base text-foreground-subtle">
          <p>
            {intl.formatMessage({
              id: waiting
                ? "common.loading"
                : stopped
                  ? "extensions.view.hostNotRunning"
                  : activation
                    ? "genimage.plugin.activate"
                    : "genimage.plugin.unavailable",
            })}
          </p>
          {!waiting &&
            (stopped && reload ? (
              <Button type="button" variant="outline" onClick={reload}>
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={onOpenPluginStore}>
                {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
