import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useToolModelSettings } from "./useToolModelSettings.js";
import type { ToolModelDetailsProps } from "./contract.js";

export function ToolModelDetails({ className, onDirtyChange }: ToolModelDetailsProps) {
  const { locale } = useZCodeIntl();
  const zh = locale.startsWith("zh");
  const { available, view, error, pending, save, refresh } = useToolModelSettings();
  const [draftValue, setDraft] = useState<string | null>(null);
  const binding = view?.bindings[0];
  const saved = binding?.selection
    ? `${binding.selection.providerId}/${binding.selection.modelId}`
    : "";
  const draft = draftValue ?? saved;
  useEffect(() => {
    onDirtyChange?.(draft !== saved);
  }, [draft, onDirtyChange, saved]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );
  if (!available) return null;
  const submit = async (reset: boolean) => {
    const candidate = reset
      ? null
      : view?.candidates.find((entry) => `${entry.providerId}/${entry.modelId}` === draft);
    if (!reset && draft && !candidate) return;
    if (
      await save(
        candidate ? { providerId: candidate.providerId, modelId: candidate.modelId } : null,
      )
    ) {
      setDraft(null);
    }
  };
  return (
    <div className={className} data-tool-model-details="true">
      <h3 className="text-ui-lg font-medium">{zh ? "工具模型" : "Tool models"}</h3>
      <p className="mt-2 text-ui-caption text-foreground-subtle">
        {zh
          ? "仅用于本机桌面、本机工作区。不会更改聊天默认模型。"
          : "Applies to local Desktop workspaces. Chat model defaults stay unchanged."}
      </p>
      <div className="mt-5 space-y-3" data-tool-model-row="git-commit-message">
        <label className="block text-ui-base font-medium" htmlFor="git-tool-model">
          {zh ? "Git 提交说明" : "Git commit message"}
        </label>
        <p className="text-ui-caption text-foreground-subtle">
          {zh
            ? "发送前确认目标模型及提交 diff、现有会话上下文的范围。生成只填草稿，可能产生费用。"
            : "Confirm the model and sharing of commit diffs and current conversation context before each request. Generation fills an editable draft and may incur charges."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="git-tool-model"
            data-tool-model-select="git-commit-message"
            className="min-w-0 max-w-full flex-1 rounded-md border border-input-border bg-input px-3 py-2 text-ui-base"
            value={draft}
            disabled={!view || pending}
            onChange={(event) => setDraft(event.target.value)}
          >
            <option value="">{zh ? "沿用当前行为" : "Keep current behavior"}</option>
            {saved && !binding?.available ? (
              <option value={saved}>
                {saved} · {zh ? "待修复" : "Unavailable"}
              </option>
            ) : null}
            {view?.candidates.map((entry) => (
              <option
                key={`${entry.providerId}/${entry.modelId}`}
                value={`${entry.providerId}/${entry.modelId}`}
              >
                {entry.providerName} · {entry.modelName}
              </option>
            ))}
          </select>
          <Button
            data-tool-model-save="git-commit-message"
            size="sm"
            disabled={!view || pending || draft === saved}
            onClick={() => void submit(false)}
          >
            {zh ? "保存" : "Save"}
          </Button>
          <Button
            data-tool-model-reset="git-commit-message"
            variant="outline"
            size="sm"
            disabled={!saved || pending}
            onClick={() => void submit(true)}
          >
            {zh ? "恢复默认" : "Restore default"}
          </Button>
        </div>
        <p
          data-tool-model-status="git-commit-message"
          className="break-words text-ui-caption text-foreground-subtle"
          role="status"
        >
          {saved || (zh ? "沿用当前行为" : "Keep current behavior")}
          {binding && !binding.available
            ? zh
              ? " · 模型不可用，请重新选择"
              : " · Model unavailable; select a replacement"
            : ""}
        </p>
      </div>
      {error !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui-caption text-destructive">
            {error ||
              (zh
                ? "读取或保存失败。草稿已保留，请刷新配置后比较重试。"
                : "Could not read or save. Your draft is preserved; refresh the configuration and compare before retrying.")}
          </p>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void refresh()}>
            {zh ? "刷新配置" : "Refresh configuration"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
