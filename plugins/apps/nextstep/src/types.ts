export interface Anchor {
  workspaceKey: string;
  sessionId: string;
  productTurnId: string;
  assistantMessageId: string;
}
export type TriggerKind = "completed" | "refresh";
export type GenerationCommand = {
  kind: TriggerKind;
  anchor: Anchor;
  requestId: string;
  permit: string;
};
export type Command = { kind: "readLatest"; anchor: Anchor } | GenerationCommand;
export interface SuggestionItem {
  id: string;
  dimension: string;
  label: string;
  prompt: string;
}
export interface Model {
  providerId: string;
  modelId: string;
}
export type Status = "generating" | "ready" | "empty" | "failed" | "unknown";
export type VersionView = { version: number; revision: number } & (
  | { status: "ready"; items: SuggestionItem[] }
  | { status: Exclude<Status, "ready"> }
);
export interface Change {
  anchor: Anchor;
  version: number;
  revision: number;
}
export type Outcome = (
  | { status: "ready"; items: SuggestionItem[] }
  | { status: "empty" }
  | { status: "failed" | "unknown"; errorCode: string }
) & { model?: Model };
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}
export interface Disposable {
  dispose(): void;
}
export interface Context {
  extension: { dataPath: unknown };
  commands: {
    register(id: string, handler: (call: unknown) => Promise<VersionView | null>): Disposable;
  };
  turnFooter: {
    history(input: { permit: string }): Promise<unknown>;
    generate(input: { permit: string; text: string; maxOutputTokens: number }): Promise<unknown>;
    invalidate(change: Change): Promise<unknown>;
  };
  log?: Partial<Record<"info" | "warn" | "error", (code: string) => void>>;
}
export interface ClaimInput {
  key: string;
  requestId: string;
  kind: TriggerKind;
}
export type ClaimResult =
  | { claimed: true; claimId: string; result: VersionView }
  | { claimed: false; result: VersionView };
export interface SettleInput {
  key: string;
  version: number;
  claimId: string;
  outcome: Outcome;
}
export interface Storage {
  changes: Change[];
  read(key: string): Promise<VersionView | null>;
  claim(input: ClaimInput): Promise<ClaimResult>;
  settle(input: SettleInput): Promise<VersionView | null>;
  fence(): Promise<Change[]>;
  close(): Promise<void>;
}
export interface StorageOperations {
  read: { input: { key: string }; output: VersionView | null };
  claim: { input: ClaimInput; output: ClaimResult };
  settle: { input: SettleInput; output: VersionView | null };
  fence: { input: undefined; output: Change[] };
  close: { input: undefined; output: null };
}
export type WorkerRequest = {
  [K in keyof StorageOperations]: { id: number; method: K; input: StorageOperations[K]["input"] };
}[keyof StorageOperations];
export type WorkerResponse =
  | { type: "ready"; changes: Change[] }
  | { type: "failed" }
  | { id: number; result: unknown; error?: never }
  | { id: number; error: string; result?: never };
