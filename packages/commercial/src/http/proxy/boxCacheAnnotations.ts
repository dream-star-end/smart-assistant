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
/** Anthropic context editing with keep=all makes no edit for Opus 5.5.
 * Accept only the exact current CCB2.1.280 shape; all other policies require
 * a separately proved mapping and remain rejected before any paid launch. */
export function isBoxNoopContextManagement(body: ProxyBody): boolean {
  if (body.model !== "box-api-claude-opus-5-5" && body.model !== "claude-opus-5-5") {
    return false;
  }
  const ctx = body.context_management;
  if (!object(ctx) || Object.keys(ctx).join(",") !== "edits"
    || !Array.isArray(ctx.edits) || ctx.edits.length !== 1
    || !Object.hasOwn(ctx.edits, 0)) return false;
  const edit = ctx.edits[0];
  return object(edit) && Object.keys(edit).sort().join(",") === "keep,type"
    && edit.type === "clear_thinking_20251015" && edit.keep === "all";
}
/** CCB merges a generated hook reminder into the following user tool_result.
 * The held Claude CLI has no separate user-message channel while awaiting its
 * virtual MCP result, so retain the reminder bytes as another result text
 * block. Unrecognized sibling text stays untouched and is rejected later. */
// CCB HISTORY_SNIP's mergeUserMessages can append a six-char base36 [id:]
// tag after a non-meta tool result joins this generated hook reminder.
const HOOK_CONTEXT = /^<system-reminder>\n(?:PreToolUse|PostToolUse|PostToolUseFailure):[A-Za-z][A-Za-z0-9_.:-]{0,127} hook additional context: [\s\S]+\n<\/system-reminder>\n?(?:\[id:[0-9a-z]{1,6}\])?$/;
// CCB 2.1.280 emits this as a meta user text block. Unlike a hook it is
// local token-budget telemetry, not a tool result or a new user instruction.
const USER_BUDGET = /^<system-reminder>\n<total_tokens>(?:0|[1-9][0-9]{0,15}|Infinite) tokens left<\/total_tokens>\n<\/system-reminder>\n?(?:\[id:[0-9a-z]{1,6}\])?$/;
// CCB 2.1.280 can place the same hook line, without a system-reminder
// wrapper, in one system text block ahead of the existing budget line.
const BARE_HOOK = /^(?:PreToolUse|PostToolUse|PostToolUseFailure):[A-Za-z][A-Za-z0-9_.:-]{0,127} hook additional context: [\s\S]+$/;
const BARE_BUDGET = /^<total_tokens>(?:0|[1-9][0-9]{0,15}|Infinite) tokens left<\/total_tokens>$/;
function bareHookBeforeBudget(text: string): string | null {
  const seam = "\n\n";
  const at = text.lastIndexOf(seam);
  if (at <= 0) return null;
  const hook = text.slice(0, at);
  const budget = text.slice(at + seam.length);
  if (!BARE_HOOK.test(hook) || !BARE_BUDGET.test(budget)) return null;
  return hook;
}
function denseArray(value: unknown[]): boolean {
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) return false;
  }
  return true;
}
function generatedToolMeta(text: string): { hook?: string; budget: boolean } | null {
  if (USER_BUDGET.test(text)) return { budget: true };
  return HOOK_CONTEXT.test(text) ? { hook: text, budget: false } : null;
}
/** CCB's default mergeUserContentBlocks folds generated meta into the LAST
 * tool_result.content with a two-newline seam. Only remove an exact terminal
 * budget wrapper; an ordinary result, including embedded reminder-like text,
 * remains untouched. The separate-sibling branch below covers other layouts. */
function stripEmbeddedBudget(last: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: string): string | null => {
    if (USER_BUDGET.test(value)) return "";
    const seam = "\n\n<system-reminder>\n<total_tokens>";
    const at = value.lastIndexOf(seam);
    if (at < 0 || !USER_BUDGET.test(value.slice(at + 2))) return null;
    return value.slice(0, at);
  };
  if (typeof last.content === "string") {
    const text = strip(last.content);
    return text === null ? last : { ...last, content: text };
  }
  if (!Array.isArray(last.content) || last.content.length === 0) return last;
  const tail = last.content.at(-1);
  if (!object(tail) || tail.type !== "text" || typeof tail.text !== "string") return last;
  const text = strip(tail.text);
  if (text === null) return last;
  const content = text === "" && USER_BUDGET.test(tail.text)
    ? last.content.slice(0, -1)
    : [...last.content.slice(0, -1), { ...tail, text }];
  return { ...last, content };
}
function foldBoxCcbHookContext(body: ProxyBody): ProxyBody {
  if ((body.model !== "box-api-claude-opus-5-5" && body.model !== "claude-opus-5-5")
    || !Array.isArray(body.messages)) return body;
  for (let i = 0; i < body.messages.length; i++) {
    if (!Object.hasOwn(body.messages, i)) return body;
  }
  let changed = false;
  const messages = body.messages.map((message, index) => {
    if (!object(message) || message.role !== "user" || !Array.isArray(message.content)
      || !message.content.some((part: unknown) => object(part) && part.type === "tool_result")) {
      return message;
    }
    const assistant = body.messages[index - 1];
    if (!object(assistant) || assistant.role !== "assistant"
      || !Array.isArray(assistant.content)
      || !assistant.content.some((part: unknown) => object(part) && part.type === "tool_use")) {
      return message;
    }
    const results: Record<string, unknown>[] = [];
    const reminders: string[] = [];
    let removedBudget = false;
    for (let i = 0; i < message.content.length; i++) {
      if (!Object.hasOwn(message.content, i)) return message;
      const part = message.content[i];
      if (object(part) && part.type === "tool_result") {
        results.push(part);
        continue;
      }
      const text = block(part, ["text"]);
      if (!object(text) || Object.keys(text).sort().join(",") !== "text,type"
        || text.type !== "text" || typeof text.text !== "string") return message;
      const meta = generatedToolMeta(text.text);
      if (!meta) return message;
      if (meta.hook !== undefined) reminders.push(meta.hook);
      if (meta.budget) removedBudget = true;
    }
    const last = results.at(-1)!;
    if (!last) return message;
    const stripped = stripEmbeddedBudget(last);
    const embeddedChanged = stripped !== last;
    if (reminders.length === 0 && !removedBudget && !embeddedChanged) return message;
    if (reminders.length === 0) {
      const folded = [...results];
      folded[folded.length - 1] = stripped;
      changed = true;
      return { ...message, content: folded };
    }
    const previous = stripped.content;
    if (typeof previous !== "string" && !Array.isArray(previous)) return message;
    if (Array.isArray(previous)) {
      for (let i = 0; i < previous.length; i++) {
        if (!Object.hasOwn(previous, i)) return message;
      }
    }
    const content = typeof previous === "string"
      ? [{ type: "text", text: previous }]
      : [...previous];
    content.push(...reminders.map((text) => ({ type: "text", text })));
    const folded = [...results];
    folded[folded.length - 1] = { ...stripped, content };
    changed = true;
    return { ...message, content: folded };
  });
  // CCB 2.1.280 also emits a PreToolUse hook as a *system* message after
  // user(tool_result), with an ephemeral cache hint. This was observed in the
  // actual CCB wire body, not inferred from the stored attachment order.
  // Keep the generated instruction bytes inside that result for the held CLI;
  // remove only this exact transport envelope so the following budget hint
  // again sits directly after assistant(tool_use) -> user(tool_result).
  const folded: typeof messages = [];
  for (const message of messages) {
    if (object(message) && message.role === "system"
      && Object.keys(message).sort().join(",") === "content,role"
      && Array.isArray(message.content) && message.content.length === 1
      && Object.hasOwn(message.content, 0)) {
      const part = message.content[0];
      const keys = object(part) ? Object.keys(part).sort().join(",") : "";
      const marker = object(part) ? part.cache_control : null;
      const wrapped = object(part) && part.type === "text" && typeof part.text === "string"
        && HOOK_CONTEXT.test(part.text)
        && (keys === "text,type" || (keys === "cache_control,text,type"
          && object(marker) && Object.keys(marker).join(",") === "type"
          && marker.type === "ephemeral"));
      const bare = !wrapped && keys === "cache_control,text,type"
        && object(marker) && Object.keys(marker).join(",") === "type"
        && marker.type === "ephemeral" && typeof part.text === "string"
        ? bareHookBeforeBudget(part.text) : null;
      const hookBytes = wrapped ? part.text as string : bare;
      if (hookBytes !== null) {
        const result = folded.at(-1);
        const assistant = folded.at(-2);
        if (object(result) && result.role === "user" && Array.isArray(result.content)
          && denseArray(result.content)
          && result.content.length > 0
          && result.content.every((block: unknown) => object(block)
            && block.type === "tool_result")
          && object(assistant) && assistant.role === "assistant"
          && Array.isArray(assistant.content)
          && assistant.content.some((block: unknown) => object(block)
            && block.type === "tool_use")) {
          const results = [...result.content];
          const last = results.at(-1);
          const previous = object(last) ? last.content : null;
          if (typeof previous === "string" || Array.isArray(previous)
            && denseArray(previous)) {
            const content = typeof previous === "string"
              ? [{ type: "text", text: previous }] : [...previous];
            results[results.length - 1] = { ...last,
              content: [...content, { type: "text", text: hookBytes }] };
            folded[folded.length - 1] = { ...result, content: results };
            changed = true;
            continue;
          }
        }
      }
    }
    folded.push(message);
  }
  return changed ? { ...body, messages: folded } as ProxyBody : body;
}
/** CCB2.1.280 appends this budget telemetry *after each* tool_result user
 * message. The held inner Claude Code CLI independently emits its own
 * <total_tokens> system hint after the virtual MCP result (proved by the
 * local two-CLI tool loop); the outer hint is not a new user instruction.
 * Recognize only this exact shape at each handoff boundary. Every other
 * system message stays in the body and fails the resume gate if misplaced. */
function isBoxCcbToolBudgetAt(body: ProxyBody, index: number): boolean {
  if ((body.model !== "box-api-claude-opus-5-5" && body.model !== "claude-opus-5-5")
    || !Array.isArray(body.messages) || index < 2 || index >= body.messages.length) return false;
  if (!Object.hasOwn(body.messages, index)
    || !Object.hasOwn(body.messages, index - 1)
    || !Object.hasOwn(body.messages, index - 2)) return false;
  const tail = body.messages[index];
  const result = body.messages[index - 1];
  const assistant = body.messages[index - 2];
  if (!object(tail) || tail.role !== "system"
    || Object.keys(tail).sort().join(",") !== "content,role"
    || !Array.isArray(tail.content) || tail.content.length !== 1
    || !Object.hasOwn(tail.content, 0)
    || !object(result) || result.role !== "user"
    || !Array.isArray(result.content) || result.content.length < 1
    || result.content.some((part: unknown) => !object(part) || part.type !== "tool_result")
    || !object(assistant) || assistant.role !== "assistant"
    || !Array.isArray(assistant.content)
    || !assistant.content.some((part: unknown) => object(part) && part.type === "tool_use")) {
    return false;
  }
  const block = tail.content[0];
  return object(block) && Object.keys(block).sort().join(",") === "cache_control,text,type"
    && block.type === "text"
    && typeof block.text === "string"
    && /^<total_tokens>(?:0|[1-9][0-9]{0,15}|Infinite) tokens left<\/total_tokens>$/.test(block.text)
    && object(block.cache_control)
    && Object.keys(block.cache_control).join(",") === "type"
    && block.cache_control.type === "ephemeral";
}
export function isBoxCcbToolBudgetTail(body: ProxyBody): boolean {
  const effective = foldBoxCcbHookContext(body);
  return Array.isArray(effective.messages)
    && isBoxCcbToolBudgetAt(effective, effective.messages.length - 1);
}
export function stripBoxCcbToolBudgetTail(body: ProxyBody): ProxyBody {
  if (!Array.isArray(body.messages)) return body;
  // Never compact a malformed sparse message array into a different request.
  for (let i = 0; i < body.messages.length; i++) {
    if (!Object.hasOwn(body.messages, i)) return body;
  }
  const effective = foldBoxCcbHookContext(body);
  const kept = effective.messages.filter((_, index) => !isBoxCcbToolBudgetAt(effective, index));
  return kept.length === effective.messages.length ? effective
    : { ...effective, messages: kept } as ProxyBody;
}
export function normalizeBoxSemanticBody(body: ProxyBody,
  options: { collapseSingleText?: boolean } = {}): ProxyBody {
  // A validated keep-all hint has no model-visible effect. Drop it from the
  // semantic request hash as well as the CLI plan so a retry with/without the
  // hint cannot evade the same paid-call replay fingerprint.
  let semanticBody = body;
  if (isBoxNoopContextManagement(body)) {
    const { context_management: _hint, ...rest } = body;
    semanticBody = rest as ProxyBody;
  }
  semanticBody = stripBoxCcbToolBudgetTail(semanticBody);
  // Opus 5.5 defaults adaptive display to "omitted". The actual Box CLI plan
  // maps both request forms to the same effort and response behavior; normalize
  // only this verified equivalence so a retry/continuation cannot evade its
  // paid replay fence by adding the redundant display key.
  const thinking = semanticBody.thinking;
  if ((semanticBody.model === "box-api-claude-opus-5-5"
      || semanticBody.model === "claude-opus-5-5")
    && object(thinking) && Object.keys(thinking).sort().join(",") === "display,type"
    && thinking.type === "adaptive" && thinking.display === "omitted") {
    semanticBody = { ...semanticBody, thinking: { type: "adaptive" } } as ProxyBody;
  }
  const collapse = options.collapseSingleText !== false;
  const messages = semanticBody.messages.map((raw) => {
    if (!object(raw)) return raw;
    const allowed = raw.role === "assistant" ? ["text", "tool_use"]
      : ["text", "tool_result", "image"];
    return { ...raw, content: content(raw.content, allowed, collapse) };
  });
  const system = content(semanticBody.system, ["text"], collapse);
  const tools = Array.isArray(semanticBody.tools)
    ? semanticBody.tools.map(normalizeBoxToolDeclaration) : semanticBody.tools;
  return { ...semanticBody, messages,
    ...(semanticBody.system === undefined ? {} : { system }),
    ...(semanticBody.tools === undefined ? {} : { tools }) } as ProxyBody;
}
