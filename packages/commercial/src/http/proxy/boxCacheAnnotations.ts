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
const BARE_HOOK = /^(?:PreToolUse|PostToolUse|PostToolUseFailure):[A-Za-z][A-Za-z0-9_.:-]{0,127} hook additional context: [\s\S]+/;
// Do not end this with `$`. JavaScript's `$` can succeed before a final LF.
const BARE_BUDGET = /^<total_tokens>(?:0|[1-9][0-9]{0,15}|Infinite) tokens left<\/total_tokens>/;
const PROGRESS_SENTENCE = "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell \u2014 a finding, a change of plan.";
function exactMatch(pattern: RegExp, text: string): boolean {
  const match = pattern.exec(text);
  return match !== null && match[0].length === text.length;
}
function historicalBudgetString(text: string): boolean {
  return exactMatch(BARE_BUDGET, text);
}
function bareHookBeforeBudget(text: string): string | null {
  const seam = "\n\n";
  const at = text.lastIndexOf(seam);
  if (at <= 0) return null;
  const head = text.slice(0, at);
  const budget = text.slice(at + seam.length);
  if (!exactMatch(BARE_BUDGET, budget)) return null;
  if (head === PROGRESS_SENTENCE || exactMatch(BARE_HOOK, head)) return head;
  return null;
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
/** CCB records the Read result and its generated image caption as consecutive
 * user messages. The Anthropic continuation boundary is one user tool-result
 * message, so join only this exact generated tail before folding it into the
 * owning image result. Ordinary consecutive user instructions stay untouched. */
function mergeAdjacentGeneratedUserTail(messages: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (object(previous) && previous.role === "user" && Array.isArray(previous.content)
      && previous.content.length > 0
      && previous.content.every((part: unknown) => object(part) && part.type === "tool_result")
      && object(message) && message.role === "user") {
      const raw = message.content;
      const tail = typeof raw === "string" ? [{ type: "text", text: raw }]
        : Array.isArray(raw) && denseArray(raw) ? raw : null;
      // OCV5-302: Claude Code's prompt-cache breakpoint may sit on this tail.
      if (tail && tail.length > 0 && tail.every((part: unknown) => {
        const bare = bareTrailingText(part);
        if (!bare) return false;
        return captionShaped(bare.text as string) || generatedToolMeta(bare.text as string) !== null;
      })) {
        merged[merged.length - 1] = { ...previous, content: [...previous.content, ...tail] };
        continue;
      }
    }
    merged.push(message);
  }
  return merged;
}
// CCB 2.1.280 prints this sibling after a scaled Read image. Only the two
// dimension tuples below were observed (HTTP 80x2200 and JSONL 1290x2796).
// Other sizes stay unfolded. The scale string is kept verbatim.
const IMAGE_CAPTION = /^\[Image: original ([1-9][0-9]*)x([1-9][0-9]*), displayed at ([1-9][0-9]*)x([1-9][0-9]*)\. Multiply coordinates by ([0-9]+\.[0-9]{2}) to map to original image\.\]$/;
const PROVEN_IMAGE_CAPTIONS = new Set(["80x2200>73x2000@1.10", "1290x2796>923x2000@1.40"]);
const TOOL_RESULT_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 - 4096;
function exactCaption(text: string): RegExpExecArray | null {
  const match = IMAGE_CAPTION.exec(text);
  return match !== null && match[0].length === text.length ? match : null;
}
function provenCaption(text: string): boolean {
  const match = exactCaption(text);
  return match !== null && PROVEN_IMAGE_CAPTIONS.has(
    `${match[1]}x${match[2]}>${match[3]}x${match[4]}@${match[5]}`);
}
/** OCV5-302: pixel size from the image header (PNG/JPEG/GIF/WEBP). */
function boxImageDimensions(data: string): { width: number; height: number } | null {
  const b = Buffer.from(data, "base64");
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
/** OCV5-302: a caption proven by the image it describes. Real screenshots come
 * in many sizes; only the two observed tuples were accepted, so any other
 * resized Read image ended the turn with 409. Claude Code's caption
 * (utils/imageResizer createImageMetadataText) must name exactly this image's
 * pixel size as "displayed", describe a real downscale with the same aspect
 * ratio, and carry the scale string Claude Code computes. */
function captionMatchesImage(text: string, image: { width: number; height: number }): boolean {
  const match = exactCaption(text);
  if (!match) return false;
  const [ow, oh, dw, dh] = [match[1], match[2], match[3], match[4]].map(Number) as [number, number, number, number];
  if (dw !== image.width || dh !== image.height || dw > ow || dh > oh || (dw === ow && dh === oh)) return false;
  if (match[5] !== (ow / dw).toFixed(2)) return false;
  // Some single scale s must give Math.round(ow*s) === dw and Math.round(oh*s)
  // === dh. Math.round(x) === d iff d-0.5 <= x < d+0.5, so each interval is
  // half-open and they must share a real point.
  const low = Math.max((dw - 0.5) / ow, (dh - 0.5) / oh);
  const high = Math.min((dw + 0.5) / ow, (dh + 0.5) / oh);
  return low < high;
}
/** Claude Code puts its prompt-cache breakpoint on the last block of the last
 * message, which for a resized Read is the caption itself. */
function bareTrailingText(part: unknown): Record<string, unknown> | null {
  if (!object(part) || part.type !== "text" || typeof part.text !== "string") return null;
  const keys = Object.keys(part).sort().join(",");
  if (keys === "text,type") return part;
  if (keys !== "cache_control,text,type" || !object(part.cache_control)) return null;
  const cc = part.cache_control;
  const ccKeys = Object.keys(cc).sort().join(",");
  if (cc.type !== "ephemeral" || !(ccKeys === "type"
    || (ccKeys === "ttl,type" && (cc.ttl === "5m" || cc.ttl === "1h")))) return null;
  return { type: "text", text: part.text };
}
function captionShaped(text: string): boolean {
  return exactCaption(text) !== null;
}
/** Strict nested image block shared by the matcher and the historical mapper.
 * Extra keys, unknown sources, and non-canonical base64 are not images. */
export function strictBoxImageBlock(block: unknown): { data: string; mimeType: string } | null {
  if (!object(block) || block.type !== "image") return null;
  if (Object.keys(block).sort().join(",") !== "source,type" || !object(block.source)) return null;
  const source = block.source;
  if (Object.keys(source).sort().join(",") !== "data,media_type,type") return null;
  if (source.type !== "base64" || typeof source.data !== "string"
    || typeof source.media_type !== "string"
    || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(source.media_type)) {
    return null;
  }
  const raw = Buffer.from(source.data, "base64");
  if (raw.length > MAX_IMAGE_BYTES || raw.toString("base64") !== source.data) return null;
  return { data: source.data, mimeType: source.media_type };
}
function inspectResultContent(content: unknown): { ok: boolean; images: number; captions: number } {
  if (typeof content === "string") {
    return { ok: true, images: 0, captions: captionShaped(content) ? 1 : 0 };
  }
  if (!Array.isArray(content) || !denseArray(content)) return { ok: false, images: 0, captions: 0 };
  let images = 0, captions = 0;
  for (const part of content) {
    if (!object(part)) return { ok: false, images: 0, captions: 0 };
    if (part.type === "text" && Object.keys(part).sort().join(",") === "text,type"
      && typeof part.text === "string") {
      if (captionShaped(part.text)) captions += 1;
      continue;
    }
    if (strictBoxImageBlock(part)) { images += 1; continue; }
    return { ok: false, images: 0, captions: 0 };
  }
  return { ok: true, images, captions };
}
function legalToolResult(part: Record<string, unknown>): boolean {
  if (part.type !== "tool_result" || typeof part.tool_use_id !== "string"
    || !TOOL_RESULT_ID.test(part.tool_use_id)) return false;
  if (part.is_error !== undefined && typeof part.is_error !== "boolean") return false;
  return Object.keys(part).every((key) => key === "type" || key === "tool_use_id"
    || key === "content" || key === "is_error");
}
function toolUseIds(assistant: Record<string, unknown>): string[] | null {
  if (!Array.isArray(assistant.content) || !denseArray(assistant.content)) return null;
  const ids: string[] = [];
  for (const part of assistant.content) {
    if (!object(part) || part.type !== "tool_use") continue;
    if (typeof part.id !== "string" || !TOOL_RESULT_ID.test(part.id)) return null;
    ids.push(part.id);
  }
  if (ids.length < 1 || new Set(ids).size !== ids.length) return null;
  return ids;
}
/** Move one proven coordinate sentence into the single image's tool_result.
 * Unknown shapes, conflicts, and non-unique images are left untouched. */
function foldProvenImageCaption(message: Record<string, unknown>,
  assistant: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(message.content) || !denseArray(message.content)) return message;
  const content = message.content as unknown[];
  let lastResult = -1;
  for (let index = 0; index < content.length; index++) {
    const part = content[index];
    if (object(part) && part.type === "tool_result") {
      if (index !== lastResult + 1) return message;
      lastResult = index;
    }
  }
  if (lastResult < 0) return message;
  const results = content.slice(0, lastResult + 1);
  const trailing = content.slice(lastResult + 1);
  if (trailing.length === 0) return message;
  const captions: string[] = [];
  const bareTrailing: Record<string, unknown>[] = [];
  for (const part of trailing) {
    const bare = bareTrailingText(part);
    if (!bare) return message;
    bareTrailing.push(bare);
    const text = bare.text as string;
    if (captionShaped(text)) captions.push(text);
    else if (!generatedToolMeta(text)) return message;
  }
  if (captions.length !== 1) return message;
  const useIds = toolUseIds(assistant);
  if (!useIds) return message;
  const resultIds: string[] = [];
  let images = 0, imageIndex = -1, insideCaptions = 0;
  for (let index = 0; index < results.length; index++) {
    const part = results[index];
    if (!object(part) || !legalToolResult(part)) return message;
    resultIds.push(part.tool_use_id as string);
    const inspected = inspectResultContent(part.content);
    if (!inspected.ok) return message;
    insideCaptions += inspected.captions;
    if (inspected.images > 0) { images += inspected.images; imageIndex = index; }
  }
  if (images !== 1 || imageIndex < 0 || insideCaptions !== 0) return message;
  if (resultIds.length !== useIds.length || new Set(resultIds).size !== resultIds.length) return message;
  const expected = new Set(useIds);
  if (resultIds.some((id) => !expected.has(id))) return message;
  const imageResult = results[imageIndex];
  if (!object(imageResult) || !Array.isArray(imageResult.content)
    || !denseArray(imageResult.content)) return message;
  const caption = captions[0]!;
  const imageBlock = imageResult.content.map(strictBoxImageBlock).find((item) => item !== null);
  const dims = imageBlock ? boxImageDimensions(imageBlock.data) : null;
  if (!provenCaption(caption) && !(dims && captionMatchesImage(caption, dims))) return message;
  const nextResults = results.slice();
  nextResults[imageIndex] = { ...imageResult, content: [...imageResult.content,
    { type: "text", text: caption }] };
  const keptTrailing = bareTrailing.filter((part) => part.text !== caption);
  return { ...message, content: [...nextResults, ...keptTrailing] };
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
  const messages = mergeAdjacentGeneratedUserTail(body.messages).map((message, index) => {
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
    const current = foldProvenImageCaption(message, assistant);
    if (current !== message) changed = true;
    const results: Record<string, unknown>[] = [];
    const reminders: string[] = [];
    let removedBudget = false;
    if (!Array.isArray(current.content)) return current;
    for (let i = 0; i < current.content.length; i++) {
      if (!Object.hasOwn(current.content, i)) return current;
      const part = current.content[i];
      if (object(part) && part.type === "tool_result") {
        results.push(part);
        continue;
      }
      const text = block(part, ["text"]);
      if (!object(text) || Object.keys(text).sort().join(",") !== "text,type"
        || text.type !== "text" || typeof text.text !== "string") return current;
      const meta = generatedToolMeta(text.text);
      if (!meta) return current;
      if (meta.hook !== undefined) reminders.push(meta.hook);
      if (meta.budget) removedBudget = true;
    }
    const last = results.at(-1)!;
    if (!last) return current;
    const stripped = stripEmbeddedBudget(last);
    const embeddedChanged = stripped !== last;
    if (reminders.length === 0 && !removedBudget && !embeddedChanged) return current;
    if (reminders.length === 0) {
      const folded = [...results];
      folded[folded.length - 1] = stripped;
      changed = true;
      return { ...message, content: folded };
    }
    const previous = stripped.content;
    if (typeof previous !== "string" && !Array.isArray(previous)) return current;
    if (Array.isArray(previous)) {
      for (let i = 0; i < previous.length; i++) {
        if (!Object.hasOwn(previous, i)) return current;
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
      && typeof message.content === "string") {
      const kept = bareHookBeforeBudget(message.content);
      const budget = historicalBudgetString(message.content);
      if (kept !== null || budget) {
        const result = folded.at(-1);
        const assistant = folded.at(-2);
        const boundary = object(result) && result.role === "user" && Array.isArray(result.content)
          && denseArray(result.content) && result.content.length > 0
          && result.content.every((block: unknown) => object(block) && block.type === "tool_result")
          && object(assistant) && assistant.role === "assistant" && Array.isArray(assistant.content)
          && assistant.content.some((block: unknown) => object(block) && block.type === "tool_use");
        // A non-dense handoff still reaches the shared walk below. Pushing here
        // would hide a later wrapper behind a budget this pass has not judged.
        if (boundary && object(result) && Array.isArray(result.content)) {
          if (kept !== null) {
            const results = [...result.content];
            const last = results.at(-1);
            const previous = object(last) ? last.content : null;
            if (typeof previous === "string" || Array.isArray(previous) && denseArray(previous)) {
              const content = typeof previous === "string"
                ? [{ type: "text", text: previous }] : [...previous];
              results[results.length - 1] = { ...last, content: [...content, { type: "text", text: kept }] };
              folded[folded.length - 1] = { ...result, content: results };
            } else { folded.push(message); continue; }
          }
          changed = true;
          continue;
        }
      }
    }
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
      const bare = !wrapped && object(part) && part.type === "text"
        && keys === "cache_control,text,type"
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
    // Same walk as the hook fold: judge the message against the tail left after
    // earlier hook folds and pure-budget drops, before generic cache collapse.
    const envelope = systemEnvelope(message);
    if (envelope && handoffPair(folded.at(-1), folded.at(-2))) {
      if (approvedPureBudget(envelope)) {
        changed = true;
        continue;
      }
      rejectIfUnapprovedBoundary(envelope);
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
function opusModel(body: ProxyBody): boolean {
  return body.model === "box-api-claude-opus-5-5" || body.model === "claude-opus-5-5";
}
function handoffPair(result: unknown, assistant: unknown): boolean {
  return object(result) && result.role === "user"
    && Array.isArray(result.content) && result.content.length > 0
    && result.content.every((part: unknown) => object(part) && part.type === "tool_result")
    && object(assistant) && assistant.role === "assistant"
    && Array.isArray(assistant.content)
    && assistant.content.some((part: unknown) => object(part) && part.type === "tool_use");
}
function handoffNeighbors(body: ProxyBody, index: number): boolean {
  if (!opusModel(body) || !Array.isArray(body.messages) || index < 2 || index >= body.messages.length) {
    return false;
  }
  if (!Object.hasOwn(body.messages, index)
    || !Object.hasOwn(body.messages, index - 1)
    || !Object.hasOwn(body.messages, index - 2)) return false;
  const result = body.messages[index - 1];
  const assistant = body.messages[index - 2];
  return object(result) && result.role === "user"
    && Array.isArray(result.content) && result.content.length > 0
    && result.content.every((part: unknown) => object(part) && part.type === "tool_result")
    && object(assistant) && assistant.role === "assistant"
    && Array.isArray(assistant.content)
    && assistant.content.some((part: unknown) => object(part) && part.type === "tool_use");
}
function approvedBudgetMarker(block: Record<string, unknown>): boolean {
  return Object.keys(block).sort().join(",") === "cache_control,text,type"
    && block.type === "text"
    && typeof block.text === "string"
    && object(block.cache_control)
    && Object.keys(block.cache_control).join(",") === "type"
    && block.cache_control.type === "ephemeral";
}
function boundaryText(tail: Record<string, unknown>): string | null {
  if (typeof tail.content === "string") return tail.content;
  if (!Array.isArray(tail.content) || tail.content.length !== 1 || !object(tail.content[0])) return null;
  return typeof tail.content[0].text === "string" ? tail.content[0].text : null;
}
function systemEnvelope(message: unknown): Record<string, unknown> | null {
  if (!object(message) || message.role !== "system") return null;
  if (Object.keys(message).sort().join(",") !== "content,role") return null;
  return message;
}
function approvedPureBudget(message: Record<string, unknown>): boolean {
  if (typeof message.content === "string") return historicalBudgetString(message.content);
  if (!Array.isArray(message.content) || message.content.length !== 1 || !object(message.content[0])) {
    return false;
  }
  const block = message.content[0];
  return approvedBudgetMarker(block) && typeof block.text === "string"
    && historicalBudgetString(block.text);
}
/** True only for a collapsible system wrapper that would become a legal budget string. */
function unapprovedCollapsibleBoundary(message: Record<string, unknown>): boolean {
  if (message.role !== "system" || Object.keys(message).sort().join(",") !== "content,role") return false;
  const text = boundaryText(message);
  if (text === null || (!historicalBudgetString(text) && bareHookBeforeBudget(text) === null)) return false;
  if (typeof message.content === "string") return false;
  const block = Array.isArray(message.content) ? message.content[0] : null;
  if (object(block) && approvedBudgetMarker(block)) return false;
  if (!Array.isArray(message.content) || message.content.length !== 1 || !object(block)
    || block.type !== "text") return false;
  const rest = Object.keys(block).filter((key) => key !== "cache_control").sort().join(",");
  const markerOk = !Object.hasOwn(block, "cache_control") || validMarker(block.cache_control);
  return rest === "text,type" && markerOk;
}
function rejectIfUnapprovedBoundary(message: Record<string, unknown>): void {
  if (unapprovedCollapsibleBoundary(message)) {
    throw new BoxCacheAnnotationError("BOX_CACHE_ANNOTATION_INVALID");
  }
}
/** An unapproved wrapper must not collapse into the legal historical string. */
function rejectUnapprovedToolBoundary(body: ProxyBody): void {
  if (!opusModel(body) || !Array.isArray(body.messages)) return;
  for (let index = 2; index < body.messages.length; index++) {
    if (!handoffNeighbors(body, index)) continue;
    const tail = body.messages[index];
    if (object(tail)) rejectIfUnapprovedBoundary(tail);
  }
}
function isBoxCcbToolBudgetAt(body: ProxyBody, index: number): boolean {
  if (!handoffNeighbors(body, index)) return false;
  const tail = body.messages[index];
  if (!object(tail) || tail.role !== "system"
    || Object.keys(tail).sort().join(",") !== "content,role") return false;
  if (typeof tail.content === "string") return historicalBudgetString(tail.content);
  if (!Array.isArray(tail.content) || tail.content.length !== 1
    || !Object.hasOwn(tail.content, 0)) return false;
  const block = tail.content[0];
  return object(block) && approvedBudgetMarker(block)
    && typeof block.text === "string" && exactMatch(BARE_BUDGET, block.text);
}
export function isBoxCcbToolBudgetTail(body: ProxyBody): boolean {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  for (let i = 0; i < body.messages.length; i++) {
    if (!Object.hasOwn(body.messages, i)) return false;
  }
  const tail = body.messages[body.messages.length - 1];
  if (!object(tail) || typeof tail.content === "string" || !approvedPureBudget(tail)) return false;
  const prefix = { ...body, messages: body.messages.slice(0, -1) } as ProxyBody;
  let folded: ProxyBody;
  try { folded = foldBoxCcbHookContext(prefix); }
  catch (error) {
    if (error instanceof BoxCacheAnnotationError) return false;
    throw error;
  }
  return Array.isArray(folded.messages)
    && handoffPair(folded.messages.at(-1), folded.messages.at(-2));
}
export function stripBoxCcbToolBudgetTail(body: ProxyBody): ProxyBody {
  if (!Array.isArray(body.messages)) return body;
  // Never compact a malformed sparse message array into a different request.
  for (let i = 0; i < body.messages.length; i++) {
    if (!Object.hasOwn(body.messages, i)) return body;
  }
  rejectUnapprovedToolBoundary(body);
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
