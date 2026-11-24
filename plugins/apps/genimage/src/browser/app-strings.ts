import type { Locale } from "./types.js";

const en = {
  loading: "Loading canvas…", unavailable: "Host connection unavailable. Reopen the canvas to connect.",
  empty: "No images yet", emptyHint: "Start a generation to add your first image.",
  readError: "Could not read the canvas. Refresh to check again.", refresh: "Refresh", configured: "Configured", unconfigured: "Not configured",
  setup: "Configure OpenAI Images in ZCode Settings → Model configuration → Image generation. This canvas never reads your key.",
  promptHelp: "One image per request. Your prompt is sent to OpenAI only after host confirmation.",
  cost: "Your prompt will be sent to OpenAI and may incur provider charges. ZCode will ask you to confirm the frozen model and prompt.",
  generate: "Generate one image", submitting: "Submitting · confirm in ZCode", busy: "An image is already generating. No new request can be started yet.",
  running: "Generating", succeeded: "Completed", failed: "Failed", outcome_unknown: "Result or billing not confirmed",
  accepted: "Request accepted. Check history for its status.", cancelled: "Cancelled. No request was sent.",
  unknown: "Submission outcome is unknown. Check history before starting a new request.",
  saved: "Image saved.", saveCancelled: "Save cancelled.", saveFailed: "Could not save the image. No automatic retry was made.",
  saving: "Saving…", noPreview: "Original image unavailable", historyHint: "Local generation records · select an available preview to locate it",
  memory: "Tasks and images are stored by ZCode on this device. Camera, image positions and unsent drafts belong to this page.",
  status: "Status", preview: "Local image preview", mode: "App workspace", noHistory: "No generation records yet.",
  inspectorNote: "Export saves the original image through ZCode’s system save dialog.",
  title: "Image generation", fit: (count: number) => `Fitted ${count} images`,
};
const zh: typeof en = {
  loading: "正在读取画布…", unavailable: "宿主连接不可用，请重新打开画布。",
  empty: "还没有成图", emptyHint: "新建一次生成，将第一张图片加入画布。",
  readError: "读取画布失败，请刷新重新查看。", refresh: "刷新", configured: "已配置", unconfigured: "尚未配置",
  setup: "请前往 ZCode 设置 → 模型配置 → 生图配置 OpenAI Images。本画布不会读取你的密钥。",
  promptHelp: "每次生成一张图片；宿主确认后才会向 OpenAI 发送提示词。",
  cost: "提示词将发送给 OpenAI，可能产生服务商费用。ZCode 会展示冻结后的模型与提示词，请你确认。",
  generate: "生成一张", submitting: "提交中 · 请在 ZCode 中确认", busy: "已有图片正在生成，暂时无法新建请求。",
  running: "生成中", succeeded: "已完成", failed: "生成失败", outcome_unknown: "结果或计费未确认",
  accepted: "请求已受理，可在历史中查看状态。", cancelled: "已取消，未发出请求。",
  unknown: "提交结果未知，请先查看历史，再决定是否发起新请求。",
  saved: "图片已保存。", saveCancelled: "已取消保存。", saveFailed: "图片保存失败，未自动重试。",
  saving: "保存中…", noPreview: "原图已不可用", historyHint: "本地生成记录 · 选择可用预览以定位",
  memory: "任务与图片由 ZCode 保存在此设备上；相机、图片位置与未提交草稿属于当前页面。",
  status: "状态", preview: "本地图片预览", mode: "应用画布", noHistory: "还没有生成记录。",
  inspectorNote: "导出通过 ZCode 的系统保存对话框保存原图。",
  title: "生图工作区", fit: (count: number) => `已聚焦 ${count} 张成图`,
};
export function appStringsFor(locale: Locale) { return locale === "en" ? en : zh; }
