import type { ImageGenerationErrorCode, ImageGenerationParameters } from "./contract.js";

const en = {
  gallery: "Local gallery",
  history: "History",
  create: "New image",
  prompt: "Describe the image you want to create",
  generate: "Generate",
  export: "Save original",
  exported: "Original saved",
  empty: "Your generated images will appear here.",
  previewUnavailable: "Preview unavailable",
  viewOriginal: "View original",
  loadingOriginal: "Loading original image…",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  running: "Generating",
  succeeded: "Completed",
  failed: "Failed",
  outcome_unknown: "Result unknown. You may have been charged.",
  receiptUnconfirmed:
    "Could not confirm the request. It may have been accepted. Read its status again; no new request will be sent.",
  retryReceipt: "Read request status again",
  more: "Load more",
  resetView: "Reset canvas view",
  model: "Model",
  configure: "Configure an image model to start generating.",
  confirm:
    "Destination: {destination}\nModel: {model}\nParameters: {parameters}\nPrompt: {prompt}\nThis request may incur a charge.",
  defaults: "Provider defaults",
  revision_conflict: "Settings changed. Reload the configuration and confirm again.",
  busy: "An image is already being generated.",
  credential_required: "Add an API key for this connection.",
  model_unavailable: "The selected image model is unavailable.",
  invalid_input: "Check the connection, model and generation parameters.",
  destination_blocked: "The connection destination is not allowed.",
  proxy_unsupported: "The current proxy cannot route this custom image connection.",
  authentication_failed: "Authentication failed. Check the credentials.",
  endpoint_unsupported: "Check the configured request path and protocol.",
  rate_limited: "The provider has rate-limited the request.",
  quota_exceeded: "The provider reports insufficient quota.",
  content_rejected: "The provider rejected the prompt.",
  invalid_output: "The provider did not return a supported inline PNG.",
  probe_unavailable: "This connection has no supported validation endpoint.",
  model_unverified: "The response did not verify the selected model.",
  network_error: "The request did not complete. Check the connection.",
  storage_error: "Could not save the result to local storage.",
  request_conflict: "This request ID already belongs to a different input.",
  provider_rejected: "The provider rejected the request.",
  service_unavailable: "Could not load or update the local image service.",
};

const zh: typeof en = {
  gallery: "本机图库",
  history: "历史",
  create: "新建生成",
  prompt: "描述要生成的图片",
  generate: "生成",
  export: "保存原图",
  exported: "已保存原图",
  empty: "生成的图片将显示在这里。",
  previewUnavailable: "预览不可用",
  viewOriginal: "查看原图",
  loadingOriginal: "正在读取原图…",
  zoomIn: "放大",
  zoomOut: "缩小",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  outcome_unknown: "结果未知，可能已计费。",
  receiptUnconfirmed: "无法确认请求回执。请求可能已受理；请重新读取状态，不会发送新请求。",
  retryReceipt: "重新读取请求状态",
  more: "加载更多",
  resetView: "重置画布视图",
  model: "模型",
  configure: "配置生图模型后即可生成。",
  confirm:
    "目标：{destination}\n模型：{model}\n参数：{parameters}\n提示词：{prompt}\n此请求可能产生费用。",
  defaults: "服务商默认",
  revision_conflict: "配置已变更，请刷新后重新确认。",
  busy: "已有图片正在生成。",
  credential_required: "请为此连接配置 API Key。",
  model_unavailable: "所选生图模型不可用。",
  invalid_input: "请检查连接、模型和生成参数。",
  destination_blocked: "此连接的目标地址不受支持。",
  proxy_unsupported: "当前代理不支持此自定义生图连接。",
  authentication_failed: "鉴权失败，请检查密钥。",
  endpoint_unsupported: "请检查配置的请求路径和协议。",
  rate_limited: "服务商限制了请求频率。",
  quota_exceeded: "服务商报告可用额度不足。",
  content_rejected: "服务商拒绝了提示词。",
  invalid_output: "服务商未返回受支持的内联 PNG。",
  probe_unavailable: "此连接没有受支持的验证端点。",
  model_unverified: "返回结果无法验证所选模型。",
  network_error: "请求未完成，请检查连接。",
  storage_error: "无法将结果保存到本机。",
  request_conflict: "此请求 ID 已用于另一份输入。",
  provider_rejected: "服务商拒绝了请求。",
  service_unavailable: "无法读取或更新本机生图服务。",
};

export function getImageText(locale: string) {
  return locale === "zh-CN" ? zh : en;
}

export function imageServiceError(text: typeof en, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && Object.hasOwn(text, code)
    ? (text[code as ImageGenerationErrorCode] ?? text.service_unavailable)
    : text.service_unavailable;
}

// Only explicit Host pre-admission rejects prove this call was not accepted. A transport or
// service error can obscure a committed receipt, so recover it by reading the original ID.
export function isImageAdmissionRejection(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return (
    code === "invalid_input" ||
    code === "revision_conflict" ||
    code === "request_conflict" ||
    code === "model_unavailable" ||
    code === "credential_required" ||
    code === "busy"
  );
}

export function imageConfirmation(
  text: typeof en,
  destination: string,
  model: string,
  parameters: ImageGenerationParameters,
  prompt: string,
): string {
  const options = [parameters.size, parameters.quality, parameters.background]
    .filter(Boolean)
    .join(" · ");
  return text.confirm.replace(/\{(destination|model|parameters|prompt)\}/g, (_, key: string) => {
    switch (key) {
      case "destination":
        return destination;
      case "model":
        return model;
      case "parameters":
        return `PNG × 1 · ${options || text.defaults}`;
      default:
        return prompt;
    }
  });
}
