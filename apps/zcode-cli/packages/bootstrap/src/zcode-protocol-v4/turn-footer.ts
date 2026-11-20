import { selectActiveConversationBranch, type ActiveConversationBranchOptions, type MessageWithParts } from "@zcode/contracts";
import { isConversationRealUserTurnStarter } from "@zcode/shared";
import {
  TURN_FOOTER_LIMITS,
  type ConversationSnapshot,
  type TurnFooterAnchor,
  type TurnFooterHistory,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

/** 只使用 publisher 内部的持久 message 映射，不把可见 rowId 当作锚点。 */
export function resolveTurnFooterAnchor(
  publisher: ConversationTopicPublisher,
  rowId?: number,
  productTurnId?: string,
): TurnFooterAnchor | null {
  const snapshot = publisher.getSnapshot();
  const header = [...snapshot.rows.window].reverse().find((row) =>
    row.kind === "turnHeader" && (productTurnId === undefined || row.turnId === productTurnId),
  );
  if (header?.kind !== "turnHeader" || header.state !== "completedSuccess") return null;
  const assistant = [...snapshot.rows.window].reverse().find((row) =>
    row.kind === "assistantText" && row.turnId === header.turnId,
  );
  if (assistant?.kind !== "assistantText" || !assistant.text.trim() ||
      (rowId !== undefined && rowId !== assistant.rowId)) return null;
  const resolved = publisher.resolveStableForkCandidate(assistant.rowId);
  if (!resolved.ok) return null;
  return {
    sessionId: snapshot.sessionId,
    productTurnId: resolved.candidate.productTurnId,
    assistantMessageId: resolved.candidate.boundaryMessageId,
  };
}

export function newlyCompletedTurnFooterAnchors(
  before: ConversationSnapshot,
  publisher: ConversationTopicPublisher,
): TurnFooterAnchor[] {
  const previouslyComplete = new Set(before.rows.window.flatMap((row) =>
    row.kind === "turnHeader" && row.state === "completedSuccess" ? [row.turnId] : [],
  ));
  return publisher.getSnapshot().rows.window.flatMap((row) => {
    if (row.kind !== "turnHeader" || row.state !== "completedSuccess" || previouslyComplete.has(row.turnId)) return [];
    // queue drain 可以在同一 runtime turn 中收口旧产品轮；不能只观察 TurnComplete。
    const anchor = resolveTurnFooterAnchor(publisher, undefined, row.turnId);
    return anchor ? [anchor] : [];
  });
}

export function matchesTurnFooterAnchor(
  current: TurnFooterAnchor | null,
  expected: TurnFooterAnchor,
): boolean {
  return current?.sessionId === expected.sessionId &&
    current.productTurnId === expected.productTurnId &&
    current.assistantMessageId === expected.assistantMessageId;
}

/** 原回复是唯一时间上界；不包含工具、附件、隐藏注入或其后的任何消息。 */
export function readBoundedTurnFooterHistory(
  messages: readonly MessageWithParts[],
  anchor: TurnFooterAnchor,
  branch: ActiveConversationBranchOptions = {},
): TurnFooterHistory {
  const activeMessages = selectActiveConversationBranch(messages, branch);
  const boundary = activeMessages.findIndex((message) =>
    message.info.role === "assistant" && String(message.info.id) === anchor.assistantMessageId,
  );
  if (boundary < 0) return [];
  const candidates = activeMessages.slice(0, boundary + 1).flatMap((message, index) => {
    if (String(message.info.sessionID) !== anchor.sessionId) return [];
    if (message.info.role === "user" && !isConversationRealUserTurnStarter(message)) return [];
    if (message.info.role === "assistant" && (message.info.summary || message.info.error)) return [];
    const text = message.parts.flatMap((part) =>
      part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : [],
    ).join("\n");
    return text.trim() ? [{ index, role: message.info.role, text }] : [];
  });
  const final = candidates.find((row) => row.index === boundary);
  if (!final) return [];
  const latestUser = candidates.findLast((row) => row.role === "user");
  const selected = new Map<number, TurnFooterHistory[number]>();
  let remaining = TURN_FOOTER_LIMITS.historyChars;
  const take = (row: typeof final, budget: number) => {
    const text = row.text.slice(0, budget);
    if (!text.trim()) return;
    selected.set(row.index, { role: row.role, text });
    remaining -= text.length;
  };
  // 长回答不能挤掉最近用户任务；两者先分配，再用剩余预算补更早的当前分支对话。
  const userReserve = latestUser ? Math.min(latestUser.text.length, Math.floor(remaining / 2)) : 0;
  take(final, remaining - userReserve);
  if (latestUser) take(latestUser, remaining);
  for (const row of candidates.toReversed()) {
    if (remaining <= 0 || selected.size >= TURN_FOOTER_LIMITS.historyRows) break;
    if (!selected.has(row.index)) take(row, remaining);
  }
  return [...selected.entries()].sort(([left], [right]) => left - right).map(([, row]) => row);
}
