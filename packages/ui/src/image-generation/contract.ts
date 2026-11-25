import type { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export type IImageGenerationService = NonNullable<
  ReturnType<typeof useBaseWorkspaceServices>["imageGenerationService"]
>;
export type ImageGenerationConfiguration = Awaited<
  ReturnType<IImageGenerationService["getConfiguration"]>
>;
export type ImageGenerationJob = NonNullable<
  Awaited<ReturnType<IImageGenerationService["getRequest"]>>["job"]
>;
export type ImageGenerationPublicConnection = ImageGenerationConfiguration["connections"][number];
export type ImageGenerationModelConfig = ImageGenerationPublicConnection["models"][number];
export type ImageGenerationParameters = ImageGenerationModelConfig["parameters"];
export type ImageGenerationProtocol = ImageGenerationPublicConnection["protocol"];
export type ImageGenerationErrorCode = NonNullable<ImageGenerationJob["errorCode"]>;
export type ImageGenerationSelection = NonNullable<
  ImageGenerationConfiguration["defaultSelection"]["selection"]
>;
export type ImageGenerationTestResult = Awaited<
  ReturnType<IImageGenerationService["probeConnection"]>
>;
export type ImageGenerationSaveConnectionInput = Parameters<
  IImageGenerationService["saveConnection"]
>[0];
export type ImageGenerationCredentialIntent = ImageGenerationSaveConnectionInput["credential"];

export interface ImageGenerationSettingsProps {
  /** Parent navigation owns the leave guard; false is reported on discard/unmount. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface GenImageWorkspaceProps {
  /** Opens the image connection node in model settings. */
  onOpenSettings(): void;
  /** Window chrome belongs to the Workspace shell. */
  showWindowControls: boolean;
}
