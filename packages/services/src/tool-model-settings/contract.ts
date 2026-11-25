import { z } from "zod";
import type {
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const toolModelReferenceSchema = z
  .object({
    providerId: z.string().trim().min(1).max(256),
    modelId: z.string().trim().min(1).max(256),
  })
  .strict();
export type ToolModelReference = z.infer<typeof toolModelReferenceSchema>;
export const saveToolModelBindingSchema = z
  .object({
    toolId: z.literal("git-commit-message"),
    expectedRevision: z.number().int().nonnegative(),
    selection: toolModelReferenceSchema.nullable(),
  })
  .strict();
export interface ToolModelCandidate extends ToolModelReference {
  providerName: string;
  modelName: string;
}
export interface ToolModelSettingsView {
  revision: number;
  candidates: ToolModelCandidate[];
  bindings: {
    toolId: "git-commit-message";
    selection: ToolModelReference | null;
    available: boolean;
  }[];
}
export interface ToolGitGenerationRequest extends GitGenerateCommitMessageRequest {
  sessionId: string;
  /** 会话归属工作区；workspacePath 是 Git 操作 cwd，worktree 时二者不同。 */
  sessionWorkspacePath: string;
  remoteSessionId?: string;
}
export type GitToolModelPreparation =
  | { kind: "default" }
  | {
      kind: "confirmation";
      confirmationId: string;
      revision: number;
      providerName: string;
      modelName: string;
      hasConversationContext: boolean;
    };
/** 仅本机 Desktop base attachment 发布；不能加入通用 ServiceCollection。 */
export interface IToolModelSettingsService {
  getView(): Promise<ToolModelSettingsView>;
  saveBinding(input: z.infer<typeof saveToolModelBindingSchema>): Promise<ToolModelSettingsView>;
  prepareGitGeneration(request: ToolGitGenerationRequest): Promise<GitToolModelPreparation>;
  confirmGitGeneration(input: {
    confirmationId: string;
    request: ToolGitGenerationRequest;
  }): Promise<GitGenerateCommitMessageResult>;
}
export const IToolModelSettingsService =
  createServiceDescriptor<IToolModelSettingsService>("tool-model-settings");
