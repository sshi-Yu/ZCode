import { useCallback, useId, useState, type ReactNode } from "react";
import { Image, Plus } from "lucide-react";
import {
  IMAGE_MODEL_QUALITIES,
  imageGenerationUrl,
  type ImageModelInput,
  type ImageModelView,
} from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { ApiKeyInput } from "@/settings/model-provider-section/ApiKeyInput.js";
import {
  useSpecializedModelSettingsService,
  useSpecializedSettings,
} from "./useSpecializedSettings.js";

const fieldLabelClass = "font-normal text-foreground-subtle";
const fieldGridClass = "grid min-w-0 gap-4 @md:grid-cols-2";
const defaultOption = "default";
const newModelOption = "new";
const initialModel: ImageModelInput = {
  name: "",
  modelId: "",
  protocol: "openai",
  baseUrl: "https://api.openai.com",
  size: "",
  quality: "",
};

function useSettingsText() {
  const { locale } = useZCodeIntl();
  return useCallback((zh: string, en: string) => (locale.startsWith("zh") ? zh : en), [locale]);
}

function SettingsHeading({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-ui-lg font-semibold">
        {icon}
        {title}
      </h3>
      <p className="mt-1 text-ui-sm leading-6 text-foreground-subtle">{description}</p>
    </div>
  );
}

function SettingsError({ error, refresh }: { error?: string; refresh(): void }) {
  const text = useSettingsText();
  if (!error) return null;
  const message = error.endsWith(".key-required")
    ? text("接收地址已更改，请重新填写密钥。", "Enter a new key for the changed destination.")
    : error.endsWith(".invalid-url")
      ? text(
          "请输入 HTTPS Base URL，省略查询参数和请求路径。",
          "Enter an HTTPS base URL without a query or the request path.",
        )
      : error.endsWith(".revision-conflict")
        ? text(
            "配置已被其他窗口更新，请刷新后再保存。",
            "Another window changed the settings. Refresh before saving again.",
          )
        : text(
            "未能读取或保存配置，请检查输入后重试。",
            "Could not load or save settings. Check the inputs and try again.",
          );
  return (
    <div className="flex flex-wrap items-center gap-2 text-ui-sm">
      <p role="alert" className="text-destructive">
        {message}
      </p>
      <Button variant="outline" size="sm" onClick={refresh}>
        {text("刷新", "Refresh")}
      </Button>
    </div>
  );
}

function ImageModelSelect({
  id,
  testId,
  value,
  disabled,
  onChange,
  children,
}: {
  id: string;
  testId?: string;
  value: string;
  disabled?: boolean;
  onChange(value: string): void;
  children: ReactNode;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id={id} data-testid={testId} size="lg" className="h-9 w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        sideOffset={4}
        className="w-(--radix-select-trigger-width)"
      >
        {children}
      </SelectContent>
    </Select>
  );
}

export function ImageModelSettings() {
  const service = useSpecializedModelSettingsService();
  const text = useSettingsText();
  const confirm = useConfirmDialog();
  const read = useCallback(async () => service?.getImageSettings(), [service]);
  const { view, error, pending, mutate, refresh } = useSpecializedSettings(read);
  const [selection, setSelection] = useState<string>();
  const savedModelsId = useId();
  const selectedId = selection ?? view?.defaultId ?? "";
  const saved = view?.models.find((item) => item.id === selectedId);

  return (
    <section className="@container space-y-5" data-testid="image-model-settings">
      <SettingsHeading
        icon={<Image className="size-5" />}
        title={text("图像模型", "Image models")}
        description={text(
          "配置通过提示词创建图像的模型。保存设置不会发送请求。",
          "Configure text-to-image models. Saving settings does not send a generation request.",
        )}
      />
      {view && service ? (
        <>
          {view.models.length > 0 ? (
            <div className="flex flex-wrap items-end gap-3 border-b border-border pb-5">
              <div className="grid min-w-0 grow gap-1.5 @md:max-w-sm">
                <Label htmlFor={savedModelsId} className={fieldLabelClass}>
                  {text("已保存的模型", "Saved models")}
                </Label>
                <ImageModelSelect
                  id={savedModelsId}
                  value={saved?.id ?? newModelOption}
                  disabled={pending}
                  onChange={(value) => setSelection(value === newModelOption ? "" : value)}
                >
                  <SelectItem value={newModelOption}>
                    {text("新增图像模型", "New image model")}
                  </SelectItem>
                  {view.models.map((model) => (
                    <SelectItem key={model.id} value={model.id} className="pr-8 wrap-anywhere">
                      {model.name}
                      {model.id === view.defaultId ? ` · ${text("默认", "Default")}` : ""}
                    </SelectItem>
                  ))}
                </ImageModelSelect>
              </div>
              <Button
                variant="outline"
                size="lg"
                className="h-9"
                disabled={!selectedId || pending}
                onClick={() => setSelection("")}
              >
                <Plus />
                {text("新增模型", "Add model")}
              </Button>
            </div>
          ) : null}
          <ImageModelForm
            key={`${saved?.id ?? "new"}:${view.revision}`}
            saved={saved}
            isDefault={saved?.id === view.defaultId}
            pending={pending}
            onSave={async (model, apiKey) => {
              const next = await mutate(() =>
                service.saveImageModel({
                  expectedRevision: view.revision,
                  id: saved?.id,
                  model,
                  apiKey,
                }),
              );
              if (next) setSelection(saved?.id ?? next.models.at(-1)?.id);
              return Boolean(next);
            }}
            onSetDefault={
              saved
                ? () =>
                    void mutate(() =>
                      service.setDefaultImageModel({
                        expectedRevision: view.revision,
                        id: saved.id,
                      }),
                    )
                : undefined
            }
            onDelete={
              saved
                ? async () => {
                    const confirmed = await confirm({
                      title: text("删除此图像模型？", "Delete this image model?"),
                      description: saved.name,
                      confirmVariant: "destructive",
                    });
                    if (
                      confirmed &&
                      (await mutate(() =>
                        service.deleteImageModel({ expectedRevision: view.revision, id: saved.id }),
                      ))
                    ) {
                      setSelection(undefined);
                    }
                  }
                : undefined
            }
          />
        </>
      ) : !error ? (
        <p className="text-ui-sm text-foreground-subtle">
          {text("正在读取配置…", "Loading settings…")}
        </p>
      ) : null}
      <SettingsError error={error} refresh={refresh} />
    </section>
  );
}

function ImageModelForm({
  saved,
  pending,
  isDefault,
  onSave,
  onDelete,
  onSetDefault,
}: {
  saved?: ImageModelView;
  pending: boolean;
  isDefault: boolean;
  onSave(model: ImageModelInput, apiKey?: string): Promise<boolean>;
  onDelete?(): Promise<void>;
  onSetDefault?(): void;
}) {
  const text = useSettingsText();
  const formId = useId();
  const [draft, setDraft] = useState<ImageModelInput>(() =>
    saved
      ? {
          name: saved.name,
          protocol: saved.protocol,
          modelId: saved.modelId,
          baseUrl: saved.baseUrl,
          size: saved.size,
          quality: saved.quality,
        }
      : initialModel,
  );
  const [key, setKey] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const update = <Field extends keyof ImageModelInput>(
    field: Field,
    value: ImageModelInput[Field],
  ) => setDraft((current) => ({ ...current, [field]: value }));
  const valid = draft.name.trim() && draft.modelId.trim() && draft.baseUrl.trim();

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !pending)
          void onSave(draft, key.trim() || undefined).then((saved) => {
            if (saved) setKey("");
          });
      }}
    >
      <fieldset disabled={pending} className="min-w-0">
        <legend className="mb-3 text-ui-base font-semibold">
          {text("模型信息", "Model details")}
        </legend>
        <div className={fieldGridClass}>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={`${formId}-name`} className={fieldLabelClass}>
              {text("显示名称", "Display name")}
            </Label>
            <Input
              id={`${formId}-name`}
              data-testid="image-model-name"
              size="lg"
              className="h-9"
              value={draft.name}
              onChange={(event) => update("name", event.currentTarget.value)}
              required
              maxLength={100}
            />
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={`${formId}-model`} className={fieldLabelClass}>
              {text("模型 ID", "Model ID")}
            </Label>
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={`${formId}-model`}
              data-testid="image-model-id"
              size="lg"
              className="h-9"
              value={draft.modelId}
              onChange={(event) => update("modelId", event.currentTarget.value)}
              required
              maxLength={256}
              placeholder="gpt-image-2"
            />
          </div>
        </div>
      </fieldset>
      <div className="border-t border-border pt-4">
        <fieldset disabled={pending} className="min-w-0 space-y-4">
          <legend className="mb-3 text-ui-base font-semibold">
            {text("接口连接", "Connection")}
          </legend>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={`${formId}-protocol`} className={fieldLabelClass}>
              {text("API 格式", "API format")}
            </Label>
            <ImageModelSelect
              id={`${formId}-protocol`}
              testId="image-model-protocol"
              disabled={pending}
              value={draft.protocol}
              onChange={(value) => update("protocol", value === "base64" ? "base64" : "openai")}
            >
              <SelectItem value="openai" className="pr-8">
                OpenAI GPT Image
              </SelectItem>
              <SelectItem value="base64" data-testid="image-model-protocol-base64" className="pr-8">
                {text("兼容接口 · 同步 Base64", "Compatible API · synchronous Base64")}
              </SelectItem>
            </ImageModelSelect>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={`${formId}-url`} className={fieldLabelClass}>
              Base URL
            </Label>
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={`${formId}-url`}
              data-testid="image-model-url"
              size="lg"
              className="h-9"
              type="url"
              aria-describedby={`${formId}-request`}
              value={draft.baseUrl}
              onChange={(event) => update("baseUrl", event.currentTarget.value)}
              required
              maxLength={2048}
            />
            <p
              id={`${formId}-request`}
              className="flex flex-wrap gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
            >
              <span>{text("请求地址", "Request URL")}</span>
              <code className="min-w-0 wrap-anywhere">
                {draft.baseUrl.trim() ? imageGenerationUrl(draft.baseUrl) : "—"}
              </code>
            </p>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={`${formId}-key`} className={fieldLabelClass}>
                API Key
              </Label>
              {saved?.configured ? (
                <span
                  className="text-ui-sm text-foreground-subtle"
                  data-testid="image-model-configured"
                >
                  {text("密钥已配置", "Key configured")}
                </span>
              ) : null}
            </div>
            <ApiKeyInput
              id={`${formId}-key`}
              testId="image-model-key"
              value={key}
              visible={keyVisible}
              readOnly={pending}
              onChange={setKey}
              onToggleVisibility={() => setKeyVisible((visible) => !visible)}
              maxLength={4096}
              placeholder={
                saved?.configured
                  ? text("留空保留现有密钥", "Leave blank to keep the saved key")
                  : undefined
              }
            />
          </div>
        </fieldset>
      </div>
      <div className="border-t border-border pt-4">
        <fieldset disabled={pending} className="min-w-0">
          <legend className="mb-3 text-ui-base font-semibold">
            {text("生成参数（可选）", "Generation options (optional)")}
          </legend>
          <div className={fieldGridClass}>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`${formId}-size`} className={fieldLabelClass}>
                {text("尺寸", "Size")}
              </Label>
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={`${formId}-size`}
                size="lg"
                className="h-9"
                value={draft.size}
                onChange={(event) => update("size", event.currentTarget.value)}
                maxLength={11}
                placeholder="1024x1024"
              />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`${formId}-quality`} className={fieldLabelClass}>
                {text("质量", "Quality")}
              </Label>
              <ImageModelSelect
                id={`${formId}-quality`}
                testId="image-model-quality"
                disabled={pending}
                value={draft.quality || defaultOption}
                onChange={(value) =>
                  update(
                    "quality",
                    IMAGE_MODEL_QUALITIES.find((quality) => quality === value) ?? "",
                  )
                }
              >
                <SelectItem value={defaultOption} className="pr-8">
                  {text("模型默认", "Model default")}
                </SelectItem>
                {IMAGE_MODEL_QUALITIES.map((quality) => (
                  <SelectItem
                    key={quality}
                    value={quality}
                    data-testid={`image-model-quality-${quality}`}
                    className="pr-8"
                  >
                    {quality}
                  </SelectItem>
                ))}
              </ImageModelSelect>
            </div>
          </div>
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive"
            disabled={pending}
            onClick={() => void onDelete()}
          >
            {text("删除模型", "Delete model")}
          </Button>
        ) : null}
        {onSetDefault && !isDefault ? (
          <Button type="button" variant="outline" disabled={pending} onClick={onSetDefault}>
            {text("设为默认", "Set as default")}
          </Button>
        ) : null}
        <Button type="submit" size="lg" data-testid="image-model-save" disabled={!valid || pending}>
          {text("保存", "Save")}
        </Button>
      </div>
    </form>
  );
}
