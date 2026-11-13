/** OCV5-756: content-free explanation of a native resume miss. When a pointer
 * is attached, the per-part digests of the request it describes are kept in a
 * small in-process LRU keyed by that request's context hash. A later "context"
 * miss compares the next request's prefix part by part and reports only part
 * names, counts, indexes, roles and block types; never text, digests or tool
 * input. Lost on restart, which only means "basis unknown" in the log. */
import { createHash } from "node:crypto";
import type { ProxyBody } from "./shared.js";
import { normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import { updateStableJson } from "./boxCallFingerprint.js";

interface ContextParts {
  readonly system: readonly string[];
  readonly tools: readonly string[];
  readonly params: Readonly<Record<string, string>>;
  readonly messages: readonly string[];
  readonly kinds: readonly string[];
}

const MAX_REMEMBERED = 128;
const remembered = new Map<string, ContextParts>();

function digest(value: unknown): string {
  const hasher = createHash("sha256");
  updateStableJson(value, (part) => { hasher.update(part); });
  return hasher.digest("hex").slice(0, 32);
}

function kindOf(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "invalid";
  const { role, content } = message as { role?: unknown; content?: unknown };
  const types = typeof content === "string" ? "str"
    : Array.isArray(content) ? content.map((block) => block && typeof block === "object"
      && typeof (block as { type?: unknown }).type === "string"
      ? String((block as { type: string }).type).slice(0, 32) : "?").join("|")
    : "none";
  return `${typeof role === "string" ? role.slice(0, 16) : "?"}:${types}`;
}

function blocks(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Parts of an already semantically normalized body (explain's prefix view). */
function partsOfNormalized(normalized: ProxyBody): ContextParts {
  const { metadata: _tracking, messages, system, tools, ...rest } = normalized as ProxyBody
    & { system?: unknown; tools?: unknown };
  const params: Record<string, string> = {};
  for (const key of Object.keys(rest).sort()) params[key] = digest((rest as Record<string, unknown>)[key]);
  const list = Array.isArray(messages) ? messages : [];
  return { system: blocks(system).map(digest), tools: blocks(tools).map(digest), params,
    messages: list.map(digest), kinds: list.map(kindOf) };
}

/** Remember the parts of the request whose context hash a pointer records. */
export function rememberBoxNativeContext(contextHash: string, body: ProxyBody): void {
  try {
    const parts = partsOfNormalized(normalizeBoxSemanticBody(body));
    remembered.delete(contextHash);
    remembered.set(contextHash, parts);
    while (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next().value;
      if (oldest === undefined) break;
      remembered.delete(oldest);
    }
  } catch { /* Diagnosis only: an unhashable body just stays unknown. */ }
}

function firstDiff(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export type BoxNativeMissDetail = Record<string, unknown>;

/** Which part of a "context" miss changed, relative to the remembered basis. */
export function describeBoxNativeContextMiss(normalizedPrefix: ProxyBody,
  contextHash: string): BoxNativeMissDetail {
  const prev = remembered.get(contextHash);
  if (!prev) return { basis: "unknown" };
  let next: ContextParts;
  try { next = partsOfNormalized(normalizedPrefix); } catch { return { basis: "unhashable" }; }
  const changed: string[] = [];
  const out: BoxNativeMissDetail = { basis: "known" };
  const systemAt = firstDiff(prev.system, next.system);
  if (systemAt >= 0) {
    changed.push("system");
    out.system = { prev: prev.system.length, next: next.system.length, firstDiff: systemAt };
  }
  const toolsAt = firstDiff(prev.tools, next.tools);
  if (toolsAt >= 0) {
    changed.push("tools");
    out.tools = { prev: prev.tools.length, next: next.tools.length, firstDiff: toolsAt };
  }
  const keys = [...new Set([...Object.keys(prev.params), ...Object.keys(next.params)])].sort();
  const params = keys.filter((key) => prev.params[key] !== next.params[key]);
  if (params.length) { changed.push("params"); out.params = params; }
  const at = firstDiff(prev.messages, next.messages);
  if (at >= 0) {
    changed.push("messages");
    let aligned = 0, shiftedNext = 0, shiftedPrev = 0;
    for (let i = at + 1; i < Math.max(prev.messages.length, next.messages.length); i++) {
      if (prev.messages[i] !== undefined && prev.messages[i] === next.messages[i]) aligned++;
      if (prev.messages[i - 1] !== undefined && prev.messages[i - 1] === next.messages[i]) shiftedNext++;
      if (next.messages[i - 1] !== undefined && prev.messages[i] === next.messages[i - 1]) shiftedPrev++;
    }
    out.messages = { prev: prev.messages.length, next: next.messages.length, firstDiff: at,
      prevKind: prev.kinds[at] ?? null, nextKind: next.kinds[at] ?? null,
      alignedAfter: aligned, insertedShift: shiftedNext, removedShift: shiftedPrev };
  }
  out.changed = changed.length ? changed : ["none"];
  return out;
}

/** Shape of the tail of a request, for "roles"/"shape"/"tool_result" misses. */
export function describeBoxNativeTail(messages: unknown): BoxNativeMissDetail {
  if (!Array.isArray(messages)) return { count: null };
  return { count: messages.length, tail: messages.slice(-4).map(kindOf) };
}

export function resetBoxNativeContextDiagnosisForTest(): void { remembered.clear(); }
