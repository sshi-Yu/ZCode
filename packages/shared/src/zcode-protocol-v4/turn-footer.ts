import { z } from "zod";

export const TURN_FOOTER_LIMITS = {
  historyChars: 24_000,
  historyRows: 40,
  maxOutputTokens: 1_600,
  requestTimeoutMs: 65_000,
} as const;

export const turnFooterAnchorSchema = z.strictObject({
  sessionId: z.string().trim().min(1),
  productTurnId: z.string().trim().min(1),
  assistantMessageId: z.string().trim().min(1),
});
export type TurnFooterAnchor = z.infer<typeof turnFooterAnchorSchema>;

export const turnFooterWorkspaceSchema = z.strictObject({
  workspacePath: z.string().trim().min(1),
  workspaceIdentity: z.string().optional(),
});
export const turnFooterResolveAnchorParamsSchema = turnFooterWorkspaceSchema.extend({
  sessionId: z.string().trim().min(1),
  rowId: z.number().int().nonnegative(),
});
export const turnFooterResolveAnchorResultSchema = turnFooterAnchorSchema.nullable();
export const turnFooterHistoryParamsSchema = turnFooterWorkspaceSchema.extend(
  turnFooterAnchorSchema.shape,
);
export const turnFooterHistoryResultSchema = z
  .array(
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      text: z.string().refine((text) => text.trim().length > 0),
    }),
  )
  .max(TURN_FOOTER_LIMITS.historyRows)
  .refine(
    (rows) =>
      rows.reduce((total, row) => total + row.text.length, 0) <= TURN_FOOTER_LIMITS.historyChars,
  );
export const turnFooterGenerateTextParamsSchema = turnFooterHistoryParamsSchema.extend({
  text: z
    .string()
    .max(TURN_FOOTER_LIMITS.historyChars)
    .refine((text) => text.trim().length > 0),
  maxOutputTokens: z.number().int().min(1).max(TURN_FOOTER_LIMITS.maxOutputTokens),
});
export const turnFooterGenerateTextResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    text: z.string(),
    model: z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1) }),
  }),
  z.strictObject({ status: z.enum(["failed", "unknown"]), code: z.string().min(1) }),
]);
export const turnFooterSubmitSuggestionParamsSchema = turnFooterHistoryParamsSchema.extend({
  text: z
    .string()
    .max(TURN_FOOTER_LIMITS.historyChars)
    .refine((text) => text.trim().length > 0),
  commandId: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
});
export type TurnFooterWorkspace = z.infer<typeof turnFooterWorkspaceSchema>;
export type TurnFooterResolveAnchorParams = z.infer<typeof turnFooterResolveAnchorParamsSchema>;
export type TurnFooterHistoryParams = z.infer<typeof turnFooterHistoryParamsSchema>;
export type TurnFooterHistory = z.infer<typeof turnFooterHistoryResultSchema>;
export type TurnFooterGenerateTextParams = z.infer<typeof turnFooterGenerateTextParamsSchema>;
export type TurnFooterGenerateTextResult = z.infer<typeof turnFooterGenerateTextResultSchema>;
export type TurnFooterSubmitSuggestionParams = z.infer<
  typeof turnFooterSubmitSuggestionParamsSchema
>;
export type TurnFooterCompleted = TurnFooterWorkspace & TurnFooterAnchor;
