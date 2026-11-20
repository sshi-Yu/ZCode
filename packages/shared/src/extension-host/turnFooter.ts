import { z } from "zod";

const id = z.string().min(1).max(200);
const path = z.string().min(1).max(8192);
const boundedText = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((s) => s.trim().length > 0);
const version = z.number().int().positive();
const revision = z.number().int().nonnegative();

export const turnFooterAnchorSchema = z.strictObject({
  workspaceKey: path,
  sessionId: id,
  productTurnId: id,
  assistantMessageId: id,
});
export type TurnFooterAnchor = z.infer<typeof turnFooterAnchorSchema>;

// Renderer 只交出即时的行定位；持久锚点由 CLI 的当前分支解析。
export const turnFooterTargetSchema = z.strictObject({
  workspacePath: path,
  workspaceIdentity: path.optional(),
  sessionId: id,
  rowId: z.number().int().nonnegative(),
});
export type TurnFooterTarget = z.infer<typeof turnFooterTargetSchema>;

export const turnFooterSuggestionSchema = z.strictObject({
  id,
  dimension: boundedText(60),
  label: boundedText(100),
  prompt: boundedText(4000),
});
export type TurnFooterSuggestion = z.infer<typeof turnFooterSuggestionSchema>;
const suggestions = z
  .array(turnFooterSuggestionSchema)
  .min(2)
  .max(5)
  .refine(
    (items) =>
      new Set(items.map((item) => item.id)).size === items.length &&
      new Set(items.map((item) => item.dimension.trim().toLowerCase())).size === items.length,
  );
export const turnFooterResultSchema = z.union([
  z.null(),
  z.strictObject({ version, revision, status: z.literal("ready"), items: suggestions }),
  z.strictObject({
    version,
    revision,
    status: z.enum(["generating", "empty", "failed", "unknown"]),
  }),
]);
export type TurnFooterResult = z.infer<typeof turnFooterResultSchema>;

export const turnFooterCommandArgsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("readLatest"), anchor: turnFooterAnchorSchema }),
  z.strictObject({
    kind: z.literal("completed"),
    anchor: turnFooterAnchorSchema,
    requestId: id,
    permit: id,
  }),
  z.strictObject({
    kind: z.literal("refresh"),
    anchor: turnFooterAnchorSchema,
    requestId: id,
    permit: id,
  }),
]);
export type TurnFooterCommandArgs = z.infer<typeof turnFooterCommandArgsSchema>;

export const turnFooterRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("readLatest"), target: turnFooterTargetSchema }),
  z.strictObject({ kind: z.literal("refresh"), target: turnFooterTargetSchema, requestId: id }),
  z.strictObject({
    kind: z.literal("submit"),
    target: turnFooterTargetSchema,
    version,
    suggestionId: id,
    commandId: id,
  }),
]);
export type TurnFooterRequest = z.infer<typeof turnFooterRequestSchema>;
export const turnFooterSubmitResultSchema = z.strictObject({
  status: z.enum(["accepted", "stale", "blocked"]),
});
export const turnFooterResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("view"), result: turnFooterResultSchema }),
  z.strictObject({ kind: z.literal("unavailable") }),
  turnFooterSubmitResultSchema.extend({ kind: z.literal("submitted") }),
]);
export type TurnFooterResponse = z.infer<typeof turnFooterResponseSchema>;

export const turnFooterChangeSchema = z.strictObject({
  anchor: turnFooterAnchorSchema,
  version,
  revision,
});
export type TurnFooterChange = z.infer<typeof turnFooterChangeSchema>;
export const turnFooterHistoryInputSchema = z.strictObject({ permit: id });
export const turnFooterHistoryResultSchema = z.strictObject({
  messages: z
    .array(z.strictObject({ role: z.enum(["user", "assistant"]), text: boundedText(24000) }))
    .max(40)
    .refine(
      (messages) => messages.reduce((total, message) => total + message.text.length, 0) <= 24000,
    ),
});
export const turnFooterGenerateInputSchema = z.strictObject({
  permit: id,
  text: boundedText(24000),
  maxOutputTokens: z.number().int().min(1).max(1600),
});
export const turnFooterGenerateResultSchema = z.union([
  z.strictObject({
    status: z.literal("ok"),
    text: z.string().max(16000),
    model: z.strictObject({ providerId: id, modelId: id }),
  }),
  z.strictObject({ status: z.enum(["failed", "unknown"]), code: id }),
]);
export type TurnFooterGenerateResult = z.infer<typeof turnFooterGenerateResultSchema>;
