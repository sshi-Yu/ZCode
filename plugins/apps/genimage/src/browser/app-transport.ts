import type { App } from "@modelcontextprotocol/ext-apps";

export interface ImageJob {
  id: string;
  prompt: string;
  modelId: "gpt-image-1";
  status: "running" | "succeeded" | "failed" | "outcome_unknown";
  asset?: { id: string; preview: string };
  error?: string;
}
export interface WorkspaceSnapshot {
  settings: { modelId: "gpt-image-1"; configured: boolean };
  jobs: ImageJob[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Host 是唯一业务所有者；本页只读取有界投影，绝不把占位图或本地写入当作成功结果。 */
export function readSnapshot(value: unknown): WorkspaceSnapshot {
  if (!record(value) || !record(value.settings) || value.settings.modelId !== "gpt-image-1" ||
    typeof value.settings.configured !== "boolean" || !Array.isArray(value.jobs) || value.jobs.length > 24) {
    throw new Error("Invalid canvas projection");
  }
  const ids = new Set<string>();
  const jobs = value.jobs.map((job: unknown): ImageJob => {
    if (!record(job) || !text(job.id, 128) || !/^[A-Za-z0-9_-]+$/.test(job.id) || ids.has(job.id) || !text(job.prompt, 4000) || !job.prompt.trim() || job.modelId !== "gpt-image-1" ||
      !["running", "succeeded", "failed", "outcome_unknown"].includes(String(job.status)) ||
      (job.error !== undefined && !text(job.error, 4000))) throw new Error("Invalid job projection");
    ids.add(job.id);
    const result: ImageJob = { id: job.id, prompt: job.prompt, modelId: "gpt-image-1", status: job.status as ImageJob["status"] };
    if (typeof job.error === "string") result.error = job.error;
    if (job.asset !== undefined) {
      if (job.status !== "succeeded" || !record(job.asset) || !text(job.asset.id, 128) || !/^[A-Za-z0-9_-]+$/.test(job.asset.id) ||
        !text(job.asset.preview, 1_400_000) || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+=*$/i.test(job.asset.preview)) {
        throw new Error("Invalid local preview");
      }
      result.asset = { id: job.asset.id, preview: job.asset.preview };
    }
    return result;
  });
  return { settings: { modelId: "gpt-image-1", configured: value.settings.configured }, jobs };
}

export async function callHost(app: App, name: string, args: Record<string, unknown>): Promise<unknown> {
  // 系统保存对话框需要人工选择位置；仅导出延长至 30 分钟，避免 SDK 默认 60 秒提前报错，读取和生成仍用默认期限。
  const result = await app.callServerTool({ name, arguments: args }, name === "genimage_export" ? { timeout: 30 * 60_000 } : undefined);
  if (result.isError || !record(result.structuredContent)) throw new Error("Host operation failed");
  return result.structuredContent;
}

export function booleanResult(value: unknown, key: "accepted" | "saved"): boolean {
  if (!record(value) || typeof value[key] !== "boolean") throw new Error("Invalid operation result");
  return value[key];
}
