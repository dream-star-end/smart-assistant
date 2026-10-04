/** Completed-turn native resume is a cache hit only when OpenClaude's next
 * authenticated Messages request still contains the exact prior context and
 * assistant answer. The Box native file is never the history authority. */
import type { ProxyBody } from "./shared.js";
import { deriveBoxContextHash, hashBoxAssistantContent } from "./boxCallFingerprint.js";
import { normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";

export interface BoxNativeHistoryBasis {
  readonly contextHashBeforeFinal: string;
  readonly assistantContentHash: string;
}

function hasRoleAndContent(value: unknown, role: "user" | "assistant"):
  value is { role: typeof role; content: unknown } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && "role" in value && value.role === role && "content" in value;
}

export function makeBoxNativeHistoryBasis(previousBody: ProxyBody,
  validatedFinalAssistantContent: unknown): BoxNativeHistoryBasis {
  return { contextHashBeforeFinal: deriveBoxContextHash(previousBody),
    assistantContentHash: hashBoxAssistantContent(validatedFinalAssistantContent) };
}

/** False means a normal synthetic-snapshot miss before admission, not an error
 * and never permission to replay an ambiguous paid invocation. */
export function matchesBoxNativeHistory(nextBody: ProxyBody,
  basis: BoxNativeHistoryBasis): boolean {
  try {
    const rawMessages = nextBody.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length < 3
      || !Object.hasOwn(rawMessages, rawMessages.length - 1)) return false;
    const rawCurrent = rawMessages.at(-1);
    if (!rawCurrent || typeof rawCurrent !== "object" || Array.isArray(rawCurrent)
      || !Object.hasOwn(rawCurrent, "content")) return false;
    const normalized = normalizeBoxSemanticBody(nextBody);
    const messages = normalized.messages;
    if (!Array.isArray(messages) || messages.length < 3) return false;
    const previousUser = messages.at(-3);
    const assistant = messages.at(-2);
    const currentUser = messages.at(-1);
    if (!hasRoleAndContent(previousUser, "user")
      || !hasRoleAndContent(assistant, "assistant")
      || !hasRoleAndContent(currentUser, "user")) return false;
    const currentContent = currentUser.content;
    if (Array.isArray(currentContent) && currentContent.some((part) => part
      && typeof part === "object" && "type" in part && part.type === "tool_result")) return false;
    const prefixBody = { ...normalized, messages: messages.slice(0, -2) } as ProxyBody;
    // Semantic normalization collapses a one-block text assistant to a string.
    // The existing assistant hash takes block arrays, so restore that exact
    // text-block representation rather than weakening the hash comparison.
    const assistantBlocks = typeof assistant.content === "string"
      ? [{ type: "text", text: assistant.content }] : assistant.content;
    return deriveBoxContextHash(prefixBody) === basis.contextHashBeforeFinal
      && hashBoxAssistantContent(assistantBlocks) === basis.assistantContentHash;
  } catch { return false; }
}
