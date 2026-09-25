/** CCB prompt-cache markers are placement hints, not model history. Remove
 * only validated wrapper-level hints; never recurse into tool input/result
 * payloads, where a key named cache_control may be real user/tool data. */
import type { ProxyBody } from "./shared.js";

export class BoxCacheAnnotationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxCacheAnnotationError"; }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validMarker(value: unknown): boolean {
  if (!object(value) || value.type !== "ephemeral") return false;
  const keys = Object.keys(value);
  return keys.length <= 3 && keys.every((key) => ["type", "ttl", "scope"].includes(key))
    && (value.ttl === undefined || value.ttl === "1h")
    && (value.scope === undefined || value.scope === "global");
}
function block(raw: unknown, allowedTypes: readonly string[]): unknown {
  if (!object(raw) || !Object.hasOwn(raw, "cache_control")) return raw;
  if (!allowedTypes.includes(String(raw.type)) || !validMarker(raw.cache_control)) {
    throw new BoxCacheAnnotationError("BOX_CACHE_ANNOTATION_INVALID");
  }
  const { cache_control: _hint, ...semantic } = raw;
  return semantic;
}
export function normalizeBoxToolDeclaration(raw: unknown): unknown {
  if (!object(raw) || !Object.hasOwn(raw, "cache_control")) return raw;
  if (typeof raw.name !== "string" || !object(raw.input_schema)
    || !validMarker(raw.cache_control)) {
    throw new BoxCacheAnnotationError("BOX_CACHE_ANNOTATION_INVALID");
  }
  const { cache_control: _hint, ...semantic } = raw;
  return semantic;
}
function content(raw: unknown, allowedTypes: readonly string[],
  collapseSingleText: boolean): unknown {
  if (!Array.isArray(raw)) return raw;
  if (raw.length > 1_000_000) throw new BoxCacheAnnotationError("BOX_CACHE_BODY_TOO_LARGE");
  const normalized = raw.map((value, index) => {
    if (!Object.hasOwn(raw, index)) {
      throw new BoxCacheAnnotationError("BOX_CACHE_BODY_INVALID");
    }
    return block(value, allowedTypes);
  });
  const only = normalized[0];
  // CCB turns string content into one text block solely to attach a cache
  // marker. Both forms have identical model-visible content and must hash alike.
  if (collapseSingleText && normalized.length === 1 && object(only)
    && Object.keys(only).sort().join(",") === "text,type"
    && only.type === "text" && typeof only.text === "string") return only.text;
  return normalized;
}
export function normalizeBoxAssistantContent(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((value, index) => {
    if (!Object.hasOwn(raw, index)) throw new BoxCacheAnnotationError("BOX_CACHE_BODY_INVALID");
    return block(value, ["text", "tool_use"]);
  });
}
export function normalizeBoxToolResultBlock(raw: unknown): unknown {
  return block(raw, ["tool_result"]);
}
export function normalizeBoxSemanticBody(body: ProxyBody,
  options: { collapseSingleText?: boolean } = {}): ProxyBody {
  const collapse = options.collapseSingleText !== false;
  const messages = body.messages.map((raw) => {
    if (!object(raw)) return raw;
    const allowed = raw.role === "assistant" ? ["text", "tool_use"]
      : ["text", "tool_result", "image"];
    return { ...raw, content: content(raw.content, allowed, collapse) };
  });
  const system = content(body.system, ["text"], collapse);
  const tools = Array.isArray(body.tools)
    ? body.tools.map(normalizeBoxToolDeclaration) : body.tools;
  return { ...body, messages, ...(body.system === undefined ? {} : { system }),
    ...(body.tools === undefined ? {} : { tools }) } as ProxyBody;
}
