import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ModelSelectionView } from "@zcode/provider";
import {
  SUPPORTED_LOCALES,
  type GitGenerateCommitMessageRequest,
  type GitGenerateCommitMessageResult,
  type ZCodeWorkspaceGenerateTextParams,
} from "@zcode/shared";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import {
  saveToolModelBindingSchema,
  toolModelReferenceSchema,
  type IToolModelSettingsService,
  type ToolModelReference,
  type ToolGitGenerationRequest,
} from "./contract.js";

const storedSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    selection: toolModelReferenceSchema.nullable(),
  })
  .strict();
const requestSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    sessionWorkspacePath: z.string().min(1).max(32768),
    remoteSessionId: z.string().max(256).optional(),
    workspacePath: z.string().min(1).max(32768),
    workspaceIdentity: z.string().max(32768).optional(),
    locale: z.enum(SUPPORTED_LOCALES).optional(),
    includeUnstaged: z.boolean().optional(),
    currentSessionFilePaths: z.array(z.string().max(32768)).max(10000).optional(),
    conversationContext: z
      .object({
        sessionId: z.string().max(256).optional(),
        omittedMessageCount: z.number().int().nonnegative().optional(),
        messages: z
          .array(
            z
              .object({ role: z.enum(["user", "assistant"]), content: z.string().max(100000) })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .optional(),
  })
  .strict();
const fail = (code: string): never => {
  throw Object.assign(new Error(`tool-model.${code}`), { code: `tool-model.${code}` });
};

export function createToolModelSettingsService(options: {
  appConfigDir: string;
  readModels(): Promise<ModelSelectionView>;
  resolveModel(
    selection: ToolModelReference,
  ): Promise<{ selection: ZCodeWorkspaceGenerateTextParams["selection"]; fingerprint: string }>;
  validateGitTarget(request: ToolGitGenerationRequest): Promise<void>;
  prepareGitPrompt(request: GitGenerateCommitMessageRequest): Promise<string>;
  generateGit(
    request: GitGenerateCommitMessageRequest,
    model: { selection: ZCodeWorkspaceGenerateTextParams["selection"]; fingerprint: string },
    prompt: string,
  ): Promise<GitGenerateCommitMessageResult>;
}): IToolModelSettingsService {
  const filePath = join(options.appConfigDir, "tool-model-settings.json");
  const confirmations = new Map<
    string,
    {
      request: string;
      revision: number;
      selection: ToolModelReference;
      fingerprint: string;
      prompt: string;
    }
  >();
  const read = async () => {
    try {
      return storedSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { revision: 0, selection: null };
      throw new Error("tool-model.settings-unavailable");
    }
  };
  const normalizeRequest = (input: unknown): ToolGitGenerationRequest => {
    const result = requestSchema.safeParse(input);
    if (
      !result.success ||
      !isAbsolute(result.data.workspacePath) ||
      !isAbsolute(result.data.sessionWorkspacePath) ||
      result.data.workspaceIdentity?.trim() ||
      result.data.remoteSessionId?.trim() ||
      (result.data.conversationContext?.sessionId &&
        result.data.conversationContext.sessionId !== result.data.sessionId)
    )
      return fail("invalid-request");
    return result.data;
  };
  const getView: IToolModelSettingsService["getView"] = async () => {
    const [stored, view] = await Promise.all([read(), options.readModels()]);
    const candidates = view.providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.config.properties.outputFormat.supportsText)
        .map((model) => ({
          providerId: provider.providerId,
          modelId: model.modelId,
          providerName: provider.providerName || provider.providerId,
          modelName: model.modelId,
        })),
    );
    return {
      revision: stored.revision,
      candidates,
      bindings: [
        {
          toolId: "git-commit-message",
          selection: stored.selection,
          available:
            !stored.selection ||
            candidates.some(
              (entry) =>
                entry.providerId === stored.selection?.providerId &&
                entry.modelId === stored.selection.modelId,
            ),
        },
      ],
    };
  };
  return {
    getView,
    async saveBinding(input) {
      const parsed = saveToolModelBindingSchema.safeParse(input);
      if (!parsed.success) return fail("invalid-request");
      await mkdir(dirname(filePath), { recursive: true });
      await withAtomicFileLock(filePath, async () => {
        const stored = await read();
        if (stored.revision !== parsed.data.expectedRevision) return fail("revision-conflict");
        if (parsed.data.selection) {
          const selection = parsed.data.selection;
          const view = await getView();
          if (
            !view.candidates.some(
              (entry) =>
                entry.providerId === selection.providerId && entry.modelId === selection.modelId,
            )
          )
            return fail("model-unavailable");
          await options.resolveModel(selection);
        }
        await atomicWriteText(
          filePath,
          JSON.stringify({ revision: stored.revision + 1, selection: parsed.data.selection }),
          { useFileLock: false },
        );
      });
      return getView();
    },
    async prepareGitGeneration(input) {
      const request = normalizeRequest(input);
      const stored = await read();
      if (!stored.selection) return { kind: "default" };
      await options.validateGitTarget(request);
      const model = await options.resolveModel(stored.selection);
      const view = await getView();
      const candidate = view.candidates.find(
        (entry) =>
          entry.providerId === stored.selection?.providerId &&
          entry.modelId === stored.selection.modelId,
      );
      if (!candidate) return fail("model-unavailable");
      const prompt = await options.prepareGitPrompt(request);
      const confirmationId = randomUUID();
      // 未确认令牌有界；没有超时或自动重试，丢弃旧准备只会要求用户重新确认。
      if (confirmations.size >= 32) confirmations.delete(confirmations.keys().next().value!);
      confirmations.set(confirmationId, {
        request: JSON.stringify(request),
        revision: stored.revision,
        selection: stored.selection,
        fingerprint: model.fingerprint,
        prompt,
      });
      return {
        kind: "confirmation",
        confirmationId,
        revision: stored.revision,
        providerName: candidate.providerName,
        modelName: candidate.modelName,
        hasConversationContext: Boolean(request.conversationContext?.messages.length),
      };
    },
    async confirmGitGeneration(input) {
      if (!input || typeof input.confirmationId !== "string") return fail("invalid-request");
      const prepared = confirmations.get(input.confirmationId);
      confirmations.delete(input.confirmationId);
      const request = normalizeRequest(input.request);
      if (!prepared || prepared.request !== JSON.stringify(request))
        return fail("reconfirm-required");
      const stored = await read();
      if (
        stored.revision !== prepared.revision ||
        JSON.stringify(stored.selection) !== JSON.stringify(prepared.selection)
      )
        return fail("reconfirm-required");
      await options.validateGitTarget(request);
      let model: Awaited<ReturnType<typeof options.resolveModel>>;
      try {
        if ((await options.prepareGitPrompt(request)) !== prepared.prompt)
          return fail("reconfirm-required");
        model = await options.resolveModel(prepared.selection);
      } catch {
        return fail("reconfirm-required");
      }
      if (
        model.fingerprint !== prepared.fingerprint ||
        (await read()).revision !== prepared.revision
      )
        return fail("reconfirm-required");
      return options.generateGit(request, model, prepared.prompt);
    },
  };
}
