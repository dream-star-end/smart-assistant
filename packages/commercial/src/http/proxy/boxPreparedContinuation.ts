/** One versioned continuation decision for a single HTTP request.
 * Pure prepare once; the journal still binds the owner inside its lock.
 * Persisted digest, context, and fingerprint algorithms are unchanged.
 */
import { createHash } from "node:crypto";
import type { ProxyBody } from "./shared.js";
import { BoxCacheAnnotationError, normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash, deriveBoxFallbackAlias,
  fingerprintOfPrepared, type BoxCallFingerprint } from "./boxCallFingerprint.js";
import { compileBoxToolCatalog, type BoxToolCatalog } from "./boxToolCatalog.js";

export const PREPARED_CONTINUATION_VERSION = 1 as const;
const AUTHORITY_TURN_ID = /^[0-9a-f]{32}$/;
const TOOL_ID = /^toolu_[A-Za-z0-9_-]{1,120}$/;

export class BoxContinuationDecisionError extends Error {
  constructor(readonly decision: "in_progress_or_unknown" | "reject", readonly code: string) {
    super(code);
    this.name = "BoxContinuationDecisionError";
  }
}

export type AuthorityProjection =
  | { readonly kind: "bridge_signed"; readonly authorityTurnId: string }
  | { readonly kind: "legacy_unsigned" }
  | { readonly kind: "malformed" };

export type ContinuationClass = "fresh" | "continuation_candidate" | "reject";

export interface PreparedContinuation {
  readonly version: typeof PREPARED_CONTINUATION_VERSION;
  readonly uid: bigint;
  readonly canonicalModel: string;
  readonly sessionId: string | null;
  readonly turnKey: string | null;
  readonly authority: AuthorityProjection;
  readonly rawBoundarySha256: string;
  readonly classification: ContinuationClass;
  readonly rejectCode: string | null;
  readonly effectiveBody: ProxyBody | null;
  readonly toolIds: readonly string[];
  readonly priorContextHash: string | null;
  readonly nextContextHash: string | null;
  readonly fingerprint: BoxCallFingerprint | null;
  readonly fallbackAlias: string | null;
  /** Compiled once from the raw tool list. Null unless this request can resume. */
  readonly catalog: BoxToolCatalog | null;
  /** Assistant content frozen for the existing comparison projection. */
  readonly assistantContent: unknown;
  /** OCV5-322: a fresh request whose current message carries this answered
   * tool exchange before the new prompt (see classifyBoxContinuation). */
  readonly answeredToolIds?: readonly string[];
}

export function decisionMayPublish(decision: { readonly kind: string }): boolean {
  return decision.kind === "new_claim";
}

/** Sole publish predicate shared by the publisher and the formal gate. */
export function resumeMayPublish(decision: { readonly kind: string }): boolean {
  return decisionMayPublish(decision);
}

export function isContinuationConflict(code: string): boolean {
  return code === "BOX_CALL_AMBIGUOUS"
    || code === "BOX_RESUME_IN_PROGRESS"
    || code === "BOX_AUTHORITY_REJECTED"
    || code === "BOX_AUTHORITY_MALFORMED"
    || code === "BOX_PREPARED_STALE"
    || code === "BOX_PREPARED_CATALOG_MISSING"
    || code === "BOX_PREPARED_REJECT"
    || code === "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION"
    || code === "BOX_TOOL_RESULT_MISMATCH"
    || code === "BOX_TOOL_CONTEXT_CHANGED"
    || code === "BOX_TOOL_CATALOG_CHANGED"
    || code === "BOX_TOOL_ASSISTANT_CHANGED"
    || code === "BOX_TOOL_RESUME_FENCE_LOST"
    || code === "BOX_TOOL_OWNER_UNKNOWN"
    || code === "BOX_CACHE_ANNOTATION_INVALID";
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function freezeDeep(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  if (value instanceof Map || value instanceof Set) {
    for (const item of value.values()) freezeDeep(item);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
}

export class PreparedConsumptionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PreparedConsumptionError";
  }
}

export interface PreparedConsumption {
  readonly prepared: PreparedContinuation;
  readonly fingerprint: BoxCallFingerprint;
  readonly fallbackAlias: string;
  readonly priorContextHash: string | null;
  readonly nextContextHash: string | null;
  readonly catalog: BoxToolCatalog | null;
  readonly assistantContent: unknown;
  readonly effectiveBody: ProxyBody | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (!record(value)) return JSON.stringify(null);
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/** Process-local raw boundary. This is not a persisted replay digest. */
export function rawBoundarySha256(body: ProxyBody): string {
  const pinned = {
    model: body.model,
    stream: body.stream,
    max_tokens: body.max_tokens,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    system: body.system,
    thinking: body.thinking,
    output_config: body.output_config,
    metadata: body.metadata,
  };
  return createHash("sha256").update("ocv5-prepared-raw-v1\0")
    .update(stableJson(pinned)).digest("hex");
}

export function projectAuthority(kind: unknown, authorityTurnId: unknown): AuthorityProjection {
  if (kind === "bridge_signed") {
    return typeof authorityTurnId === "string" && AUTHORITY_TURN_ID.test(authorityTurnId)
      ? { kind: "bridge_signed", authorityTurnId }
      : { kind: "malformed" };
  }
  if ((kind === undefined || kind === null || kind === "local_catalog")
    && (authorityTurnId === undefined || authorityTurnId === null)) {
    return { kind: "legacy_unsigned" };
  }
  return { kind: "malformed" };
}

export function authorityFromJournalCtx(ctx: Record<string, unknown>): AuthorityProjection {
  if (!Object.hasOwn(ctx, "authorityKind") && !Object.hasOwn(ctx, "authorityTurnId")) {
    return { kind: "legacy_unsigned" };
  }
  return projectAuthority(ctx.authorityKind, ctx.authorityTurnId);
}

export function authoritiesBind(left: AuthorityProjection, right: AuthorityProjection):
  { ok: true } | { ok: false; code: string } {
  if (left.kind === "malformed" || right.kind === "malformed") {
    return { ok: false, code: "BOX_AUTHORITY_MALFORMED" };
  }
  if (left.kind !== right.kind) return { ok: false, code: "BOX_AUTHORITY_REJECTED" };
  if (left.kind === "bridge_signed" && right.kind === "bridge_signed"
    && left.authorityTurnId !== right.authorityTurnId) {
    return { ok: false, code: "BOX_AUTHORITY_REJECTED" };
  }
  return { ok: true };
}

export interface TrustedContinuationIdentity {
  readonly uid: bigint;
  readonly sessionId: string;
  readonly canonicalModel: string;
  readonly turnKey: string;
  readonly authority: AuthorityProjection;
}

export function trustedIdentitiesBind(left: TrustedContinuationIdentity,
  right: TrustedContinuationIdentity): { ok: true } | { ok: false; code: string } {
  if (left.uid !== right.uid || left.sessionId !== right.sessionId
    || left.canonicalModel !== right.canonicalModel || left.turnKey !== right.turnKey) {
    return { ok: false, code: "BOX_AUTHORITY_REJECTED" };
  }
  return authoritiesBind(left.authority, right.authority);
}

function toolUseIds(assistant: Record<string, unknown>): string[] | null {
  if (!Array.isArray(assistant.content)) return null;
  const ids: string[] = [];
  for (const block of assistant.content) {
    if (!record(block) || block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || !TOOL_ID.test(block.id)) return null;
    ids.push(block.id);
  }
  return ids.length > 0 && new Set(ids).size === ids.length ? ids : null;
}

/** Content-free shape of the last request messages for reject diagnostics:
 * role and block types only (e.g. "user:tool_result+tool_result+text"). */
export function boxRequestTailShape(body: ProxyBody, count = 3): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.slice(-count).map((message) => {
    if (!record(message)) return typeof message;
    const role = typeof message.role === "string" ? message.role.slice(0, 16) : "?";
    const content = message.content;
    const types = typeof content === "string" ? "string"
      : Array.isArray(content) ? content.slice(0, 16).map((block) => record(block)
        && typeof block.type === "string" ? block.type.slice(0, 24) : "?").join("+")
        + (content.length > 16 ? `+…${content.length}` : "")
      : typeof content;
    return `${role}:${types}`;
  }).join(" | ").slice(0, 400);
}

/** Text Claude Code itself injects beside tool results (image captions,
 * hook / budget reminders, Skill bodies). Alone it is never a user prompt;
 * an unfolded one must keep the live-continuation rejection (OCV5-302/303). */
const CCB_INJECTED_TEXT = /^(?:<system-reminder>|<total_tokens>|\[Image[: ]|\[Request interrupted|Base directory for this skill:)/;

/** OCV5-322: tool results followed only by non-empty text blocks, at least
 * one of which is not text Claude Code injected itself. */
export function answeredExchangeSplit(content: readonly unknown[]):
  { results: Record<string, unknown>[]; texts: Record<string, unknown>[] } | null {
  let cut = 0;
  while (cut < content.length && record(content[cut])
    && (content[cut] as Record<string, unknown>).type === "tool_result") cut += 1;
  const results = content.slice(0, cut) as Record<string, unknown>[];
  const texts = content.slice(cut);
  if (results.length < 1 || texts.length < 1 || !texts.every((block) => record(block)
    && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
    || texts.every((block) => CCB_INJECTED_TEXT.test(((block as { text: string }).text).trimStart()))) {
    return null;
  }
  return { results, texts: texts as Record<string, unknown>[] };
}

export function classifyBoxContinuation(body: ProxyBody): Pick<PreparedContinuation,
  "classification" | "rejectCode" | "effectiveBody" | "toolIds" | "priorContextHash"
  | "nextContextHash" | "answeredToolIds"> {
  let effective: ProxyBody;
  try { effective = normalizeBoxSemanticBody(body); }
  catch (error) {
    const code = error instanceof BoxCacheAnnotationError ? error.code : "BOX_PREPARED_REJECT";
    return { classification: "reject", rejectCode: code, effectiveBody: null,
      toolIds: [], priorContextHash: null, nextContextHash: null };
  }
  const messages = Array.isArray(effective.messages) ? effective.messages : [];
  let currentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (record(message) && message.role === "user") { currentIndex = index; break; }
  }
  const fresh = { classification: "fresh" as const, rejectCode: null, effectiveBody: effective,
    toolIds: [] as const, priorContextHash: null, nextContextHash: null };
  if (currentIndex < 0) return fresh;
  const current = messages[currentIndex];
  if (!record(current)) return fresh;
  const content = current.content;
  const blocks = Array.isArray(content) ? content : [];
  const hasToolResult = blocks.some((block) => record(block) && block.type === "tool_result");
  if (!hasToolResult) return fresh;
  const rejected = (rejectCode: string) => ({
    classification: "reject" as const, rejectCode, effectiveBody: effective,
    toolIds: [] as const, priorContextHash: null, nextContextHash: null,
  });
  const assistant = messages[currentIndex - 1];
  const useIds = record(assistant) && assistant.role === "assistant" ? toolUseIds(assistant) : null;
  const pairs = (ids: unknown[]): boolean => !!useIds && ids.length === useIds.length
    && ids.every((id) => typeof id === "string" && useIds.includes(id))
    && new Set(ids).size === ids.length;
  // OCV5-322: the answered exchange of a turn that failed before the model
  // read it, followed by a new user prompt. Claude Code drops its own API
  // error rows, so a later prompt (e.g. a recovery "继续") is merged into the
  // tool-result message. No live CLI can take text, so it runs fresh with the
  // exchange staged as history (BoxToolFetch first proves no handoff waits).
  // Trailing system hints (e.g. the CCB budget) become fresh system prompt.
  const split = Array.isArray(content) && messages.slice(currentIndex + 1)
    .every((message) => record(message) && message.role === "system")
    ? answeredExchangeSplit(content) : null;
  if (split && pairs(split.results.map((block) => block.tool_use_id))) {
    return { ...fresh, answeredToolIds: split.results.map((block) => block.tool_use_id as string) };
  }
  // A legal budget/hook tail is already folded away. Anything still sitting
  // after the current user message is an unapproved boundary, not a resume.
  if (currentIndex !== messages.length - 1 || !Array.isArray(content) || content.length < 1
    || content.some((block) => !record(block) || block.type !== "tool_result")) {
    return rejected("BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  }
  const resultIds = content.map((block) => record(block) ? block.tool_use_id : null);
  if (!pairs(resultIds)) {
    return rejected("BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  }
  if (!Array.isArray(body.tools) || body.tools.length < 1) {
    return rejected("BOX_PREPARED_CATALOG_MISSING");
  }
  try {
    return { classification: "continuation_candidate", rejectCode: null, effectiveBody: effective,
      toolIds: resultIds as string[],
      priorContextHash: deriveBoxContextHash(body, true),
      nextContextHash: deriveBoxContextHash(body) };
  } catch {
    return rejected("BOX_PREPARED_REJECT");
  }
}

export function prepareBoxContinuation(input: {
  uid: bigint;
  canonicalModel: string;
  rawBody: ProxyBody;
  authorityKind: unknown;
  authorityTurnId: unknown;
}): PreparedContinuation {
  const authority = projectAuthority(input.authorityKind, input.authorityTurnId);
  const classified = classifyBoxContinuation(input.rawBody);
  let fingerprint: BoxCallFingerprint | null = null;
  let fallbackAlias: string | null = null;
  let sessionId: string | null = null;
  let turnKey: string | null = null;
  try {
    fingerprint = deriveBoxCallFingerprint(input.uid, input.rawBody);
    fallbackAlias = deriveBoxFallbackAlias(input.uid, input.rawBody);
    sessionId = fingerprint.sessionId;
    turnKey = fingerprint.turnKey;
  } catch { /* fresh admission still reports its own identity error */ }
  let classification = classified.classification;
  let rejectCode = classified.rejectCode;
  let catalog: BoxToolCatalog | null = null;
  let assistantContent: unknown = null;
  if (classification === "continuation_candidate" && classified.effectiveBody) {
    try {
      catalog = compileBoxToolCatalog(structuredClone(input.rawBody.tools));
      const assistant = classified.effectiveBody.messages.at(-2);
      assistantContent = record(assistant) ? structuredClone(assistant.content) : null;
      if (assistantContent == null) throw new Error("assistant missing");
    } catch {
      classification = "reject";
      rejectCode = "BOX_PREPARED_REJECT";
      catalog = null;
      assistantContent = null;
    }
  }
  if (authority.kind === "malformed" && classification !== "reject") {
    classification = "reject";
    rejectCode = "BOX_AUTHORITY_MALFORMED";
  }
  if (classification === "continuation_candidate" && !fingerprint) {
    classification = "reject";
    rejectCode = "BOX_PREPARED_REJECT";
  }
  const prepared: PreparedContinuation = {
    version: PREPARED_CONTINUATION_VERSION,
    uid: input.uid,
    canonicalModel: input.canonicalModel,
    sessionId, turnKey, authority,
    rawBoundarySha256: rawBoundarySha256(input.rawBody),
    classification, rejectCode,
    effectiveBody: classified.effectiveBody ? structuredClone(classified.effectiveBody) : null,
    toolIds: Object.freeze([...classified.toolIds]),
    priorContextHash: classified.priorContextHash,
    nextContextHash: classified.nextContextHash,
    fingerprint: fingerprint ? structuredClone(fingerprint) : null,
    fallbackAlias,
    catalog: catalog ? structuredClone(catalog) : null,
    assistantContent,
    ...(classification === "fresh" && classified.answeredToolIds
      ? { answeredToolIds: [...classified.answeredToolIds] } : {}),
  };
  freezeDeep(prepared);
  return prepared;
}

export function preparedMatchesBody(prepared: Pick<PreparedContinuation, "rawBoundarySha256">,
  body: ProxyBody): boolean {
  return prepared.rawBoundarySha256 === rawBoundarySha256(body);
}

/** Non-streaming replay flips only `stream` on a clone. Messages stay the prepared raw. */
export function preparedMatchesReplayBody(prepared: Pick<PreparedContinuation, "rawBoundarySha256">,
  body: ProxyBody): boolean {
  if (preparedMatchesBody(prepared, body)) return true;
  if (body.stream !== false) return false;
  if (preparedMatchesBody(prepared, { ...body, stream: true })) return true;
  const { stream: _stream, ...omitted } = body;
  return preparedMatchesBody(prepared, omitted as ProxyBody);
}

/** Use the prepared view. A missing one is prepared once for old callers, never twice. */
export function consumePrepared(input: {
  uid: bigint;
  canonicalModel: string;
  canonicalBody: ProxyBody;
  prepared?: PreparedContinuation;
  trustedAuthority?: AuthorityProjection;
  allowPrepareOnce: boolean;
  replayAlias?: boolean;
}): PreparedConsumption {
  let prepared = input.prepared;
  if (!prepared) {
    if (!input.allowPrepareOnce) throw new PreparedConsumptionError("BOX_PREPARED_STALE");
    const authority = input.trustedAuthority;
    prepared = prepareBoxContinuation({
      uid: input.uid,
      canonicalModel: input.canonicalModel,
      rawBody: input.canonicalBody,
      authorityKind: !authority || authority.kind === "legacy_unsigned" ? "local_catalog" : "bridge_signed",
      authorityTurnId: authority?.kind === "bridge_signed" ? authority.authorityTurnId
        : authority?.kind === "malformed" ? "short" : null,
    });
  }
  if (prepared.uid !== input.uid || prepared.canonicalModel !== input.canonicalModel) {
    throw new PreparedConsumptionError("BOX_AUTHORITY_REJECTED");
  }
  const matches = input.replayAlias
    ? preparedMatchesReplayBody(prepared, input.canonicalBody)
    : preparedMatchesBody(prepared, input.canonicalBody);
  if (!matches) throw new PreparedConsumptionError("BOX_PREPARED_STALE");
  if (input.trustedAuthority) {
    const bound = authoritiesBind(prepared.authority, input.trustedAuthority);
    if (!bound.ok) throw new PreparedConsumptionError(bound.code);
  }
  if (prepared.authority.kind === "malformed") {
    throw new PreparedConsumptionError("BOX_AUTHORITY_MALFORMED");
  }
  if (!prepared.fingerprint || !prepared.fallbackAlias) {
    throw new PreparedConsumptionError("BOX_PREPARED_REJECT");
  }
  return {
    prepared,
    fingerprint: fingerprintOfPrepared(prepared),
    fallbackAlias: prepared.fallbackAlias,
    priorContextHash: prepared.priorContextHash,
    nextContextHash: prepared.nextContextHash,
    catalog: prepared.catalog,
    assistantContent: prepared.assistantContent,
    effectiveBody: prepared.effectiveBody,
  };
}
