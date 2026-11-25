import { useId } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import type {
  ImageGenerationModelConfig,
  ImageGenerationParameters,
  ImageGenerationProtocol,
} from "./contract.js";
import type { ImageSettingsText } from "./settingsText.js";

export const imageSettingsSelectClass =
  "min-h-8 w-full min-w-0 rounded-lg border border-input-border bg-input px-2 py-1 text-ui-base text-foreground outline-none hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function ImageModelEditor({
  model,
  protocol,
  text,
  isDefault,
  disabled,
  canTest,
  onChange,
  onDelete,
  onTrial,
  onProbe,
}: {
  model: ImageGenerationModelConfig;
  protocol: ImageGenerationProtocol;
  text: ImageSettingsText;
  isDefault: boolean;
  disabled: boolean;
  canTest: boolean;
  onChange: (model: ImageGenerationModelConfig) => void;
  onDelete: () => void;
  onTrial: () => void;
  onProbe: () => void;
}) {
  const id = useId();
  function parameter<K extends keyof ImageGenerationParameters>(
    key: K,
    value: ImageGenerationParameters[K] | "",
  ) {
    const parameters = { ...model.parameters };
    if (value) parameters[key] = value;
    else delete parameters[key];
    onChange({ ...model, parameters });
  }
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3"
      data-model-key={model.modelKey}
    >
      <legend className="max-w-full px-1 text-ui-base font-medium [overflow-wrap:anywhere]">
        {model.name || text.modelName}
        {isDefault ? (
          <span className="ml-2 text-ui-sm text-foreground-subtle">{text.defaultBadge}</span>
        ) : null}
      </legend>
      <div className="grid min-w-0 grid-cols-1 gap-3 @lg:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <label htmlFor={`${id}-name`} className="text-ui-sm text-foreground-subtle">
            {text.modelName}
          </label>
          <Input
            id={`${id}-name`}
            maxLength={128}
            value={model.name}
            onChange={(event) => onChange({ ...model, name: event.currentTarget.value })}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <label htmlFor={`${id}-model`} className="text-ui-sm text-foreground-subtle">
            {text.modelId}
          </label>
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            id={`${id}-model`}
            maxLength={256}
            value={model.modelId}
            onChange={(event) => onChange({ ...model, modelId: event.currentTarget.value })}
          />
        </div>
      </div>
      <label className="flex w-fit items-center gap-2 text-ui-sm">
        <input
          type="checkbox"
          checked={model.enabled}
          onChange={(event) => onChange({ ...model, enabled: event.currentTarget.checked })}
        />
        {text.enabled}
      </label>
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-3" aria-label={text.parameters}>
        <div className="space-y-1">
          <label htmlFor={`${id}-size`} className="text-ui-sm text-foreground-subtle">
            {text.size}
          </label>
          <select
            id={`${id}-size`}
            className={imageSettingsSelectClass}
            value={model.parameters.size ?? ""}
            onChange={(event) =>
              parameter("size", event.currentTarget.value as ImageGenerationParameters["size"])
            }
          >
            <option value="">{text.providerDefault}</option>
            {(protocol === "openai-images-b64"
              ? ["1024x1024", "2048x2048"]
              : ["1024x1024", "1024x1536", "1536x1024"]
            ).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-quality`} className="text-ui-sm text-foreground-subtle">
            {text.quality}
          </label>
          <select
            id={`${id}-quality`}
            className={imageSettingsSelectClass}
            value={model.parameters.quality ?? ""}
            onChange={(event) =>
              parameter(
                "quality",
                event.currentTarget.value as ImageGenerationParameters["quality"],
              )
            }
          >
            <option value="">{text.providerDefault}</option>
            {(["low", "medium", "high"] as const).map((quality) => (
              <option key={quality} value={quality}>
                {text[quality]}
              </option>
            ))}
          </select>
        </div>
        {protocol === "openai-images" ? (
          <div className="space-y-1">
            <label htmlFor={`${id}-background`} className="text-ui-sm text-foreground-subtle">
              {text.background}
            </label>
            <select
              id={`${id}-background`}
              className={imageSettingsSelectClass}
              value={model.parameters.background ?? ""}
              onChange={(event) =>
                parameter(
                  "background",
                  event.currentTarget.value as ImageGenerationParameters["background"],
                )
              }
            >
              <option value="">{text.providerDefault}</option>
              {(["auto", "transparent", "opaque"] as const).map((background) => (
                <option key={background} value={background}>
                  {text[background]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <p className="text-ui-sm text-foreground-subtle">{text.unverifiedModel}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canTest || !model.enabled}
          onClick={onProbe}
        >
          {text.probe}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={`genimage-trial-${model.modelKey}`}
          disabled={!canTest || !model.enabled}
          onClick={onTrial}
        >
          {text.trial}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-destructive"
          aria-label={`${text.deleteModel}: ${model.name || model.modelId}`}
          onClick={onDelete}
        >
          {text.deleteModel}
        </Button>
      </div>
    </fieldset>
  );
}
