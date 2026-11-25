import type {
  ImageGenerationModelConfig,
  ImageGenerationPublicConnection,
  ImageGenerationSelection,
} from "./contract.js";

export interface ImageConnectionDraft {
  name: string;
  enabled: boolean;
  protocol: ImageGenerationPublicConnection["protocol"];
  baseUrl: string;
  generationPath: string;
  probePath: string;
  models: ImageGenerationModelConfig[];
  credentialAction: "keep" | "replace" | "remove";
  apiKey: string;
}
export function connectionDraft(
  connection?: ImageGenerationPublicConnection,
): ImageConnectionDraft {
  return {
    name: connection?.name ?? "",
    enabled: connection?.enabled ?? true,
    protocol: connection?.protocol ?? "openai-images",
    baseUrl: connection?.baseUrl ?? "https://api.openai.com",
    generationPath: connection?.generationPath ?? "/v1/images/generations",
    probePath: connection?.probePath ?? "",
    models: connection
      ? connection.models.map((model) => ({ ...model, parameters: { ...model.parameters } }))
      : [],
    credentialAction: "keep",
    apiKey: "",
  };
}
export function selectionValue(selection: ImageGenerationSelection | null): string {
  return selection ? JSON.stringify([selection.connectionId, selection.modelKey]) : "";
}
export function parseSelection(value: string): ImageGenerationSelection | null {
  if (!value) return null;
  const [connectionId, modelKey] = JSON.parse(value) as [string, string];
  return { connectionId, modelKey };
}
export function destinationPreview(draft: ImageConnectionDraft) {
  const base = draft.baseUrl.trim();
  const validPath = (path: string) =>
    /^\/[A-Za-z0-9_./~-]+$/.test(path) &&
    !path.includes("//") &&
    !path.split("/").some((part) => part === "." || part === "..");
  try {
    const url = new URL(base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^https:\/\/[^/?#]+(?:\/[A-Za-z0-9_./~-]*)?$/.test(base) ||
      base.includes("\\") ||
      url.pathname.includes("//") ||
      base.split("/").some((part) => part === "." || part === "..") ||
      !validPath(draft.generationPath) ||
      (draft.probePath && !validPath(draft.probePath))
    )
      return null;
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return {
      generationUrl: baseUrl + draft.generationPath,
      probeUrl: draft.probePath ? baseUrl + draft.probePath : null,
      duplicateVersion: [draft.generationPath, draft.probePath].some((path) =>
        /\/v1\/v1(?:\/|$)/.test(baseUrl + path),
      ),
      baseUrl,
    };
  } catch {
    return null;
  }
}
export function destinationChanged(
  connection: ImageGenerationPublicConnection | undefined,
  draft: ImageConnectionDraft,
): boolean {
  if (!connection) return true;
  const preview = destinationPreview(draft);
  return (
    !preview ||
    connection.protocol !== draft.protocol ||
    connection.baseUrl !== preview.baseUrl ||
    connection.generationPath !== draft.generationPath ||
    connection.probePath !== (draft.probePath || null)
  );
}
export function protocolModel(
  model: ImageGenerationModelConfig,
  protocol: ImageGenerationPublicConnection["protocol"],
): ImageGenerationModelConfig {
  const parameters = { ...model.parameters };
  // 接收方协议不同：切换时显式移除不支持的草稿参数，避免保存后向严格接口发送多余字段。
  if (protocol === "openai-images-b64") {
    delete parameters.background;
    if (parameters.size !== "1024x1024" && parameters.size !== "2048x2048") delete parameters.size;
  } else if (parameters.size === "2048x2048") delete parameters.size;
  return { ...model, parameters };
}
export function validModels(models: ImageGenerationModelConfig[]) {
  const ids = models.map((model) => model.modelId.trim());
  return (
    models.length <= 64 &&
    new Set(ids).size === ids.length &&
    models.every(
      (model) => model.name.trim().length > 0 && /^[\x21-\x7e]{1,256}$/.test(model.modelId.trim()),
    )
  );
}
