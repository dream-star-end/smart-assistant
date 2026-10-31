/** A running Box Claude chat moves to another login only when its login is near its window limit
 * (BOX_CHAT_SWITCH_AT) or benched. Claude prompt caches are per account, so continuing with the
 * whole conversation makes the new login write all of it again, at the chat model's cache-write
 * price. Instead Haiku compacts the earlier conversation once, as its own billed request, and the
 * chat continues on the new login from that summary plus the turn in progress. The complete
 * conversation stays in the container's own Claude Code transcript; the summary names that file
 * so the model can Grep it for a detail the summary dropped.
 *
 * The container keeps sending its full history. Every later request of the chat is rewritten the
 * same way (same boundary, same summary) before replay lookup, fingerprinting and planning, so a
 * retry, a tool continuation and native resume all see one consistent body. The record lives in
 * this process: after a restart the chat simply continues with full context, as before. */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Writable } from "node:stream";

import type { Pool } from "pg";

import { g8CompactSummaryCheckpointInput, runG8ReplayCheckpoint } from "@openclaude/protocol";

import type { AccountScheduler } from "../../account-pool/scheduler.js";
import type { ModelCatalogSnapshot } from "../../billing/modelCatalog.js";
import { serializeBillingPricing } from "../../billing/persistedBillingPricing.js";
import {
  InsufficientCreditsError,
  preCheckWithCost,
  releasePreCheck,
  type PreCheckRedis,
} from "../../billing/preCheck.js";
import {
  makeFinalizer,
  startInflightJournal,
  type BillingAuthorityStamp,
} from "../../billing/proxyBilling.js";
import type { Logger } from "../../logging/logger.js";
import { serializeBoxBillingContext } from "./boxBillingContext.js";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import { BOX_TOOL_MAX_WALL_MS } from "./boxToolCapacity.js";
import { estimateMaxCostBothSides, pipeStreamWithUsageCapture, type ProxyBody } from "./shared.js";

/** The compaction is a billed model call the user did not type, so an installation turns it on
 * explicitly (OC_BOX_SWITCH_COMPACTION=1 on the egress). Unset: a chat that has to move continues
 * with its full context, exactly as before this feature. */
export function boxSwitchCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_BOX_SWITCH_COMPACTION === "1";
}

export const BOX_SWITCH_COMPACT_MODEL = "box-claude-haiku-5-5";
/** OCV5-388: the Haiku rows a compaction may run on, first available wins (selfhost has
 * box-claude-haiku-5-5, commercial box-api-claude-haiku-5-5; same upstream model and prices). */
export const BOX_SWITCH_COMPACT_MODELS: readonly string[] = [BOX_SWITCH_COMPACT_MODEL, "box-api-claude-haiku-5-5"];
/** Below this the whole conversation costs less to rewrite on the new login than to compact. */
export const BOX_SWITCH_COMPACT_MIN_TOKENS = 30_000;
export const BOX_SWITCH_COMPACT_MAX_OUTPUT = 8_000;
/** What Haiku reads: about 120k tokens, inside its window with room for the prompt and answer.
 * A longer conversation keeps its start and its most recent part; the rest is in the archive. */
export const BOX_SWITCH_TRANSCRIPT_MAX_CHARS = 480_000;
const BLOCK_MAX_CHARS = 6_000;
const RECORD_TTL_MS = 7 * 24 * 3_600_000;
const RECORD_MAX = 10_000;

const COMPACT_SYSTEM = "You write continuation summaries of engineering conversations. Output only the summary.";
const COMPACT_INSTRUCTIONS = `Write a detailed continuation summary of the conversation in the transcript above, so that another assistant with no access to it can continue the work exactly. It replaces the transcript.

Keep, in sections with bullet lists:
1. Standing rules and preferences the user stated (quote short ones verbatim).
2. Every decision, with its reason and the numbers that justified it.
3. Files and code locations touched: exact paths, line numbers, commit ids, what changed.
4. Errors and incidents: symptom, root cause, fix, exact values before and after.
5. Measurements and identifiers worth keeping: tickets, builds, migrations, durations, sizes, percentages.
6. Todos: every open item with owner and deadline; items completed.
7. Current state and the next step.

Do not invent anything. Prefer completeness to brevity (up to about 1500 words). Output only the summary.`;

type Block = Record<string, unknown>;

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content)
    ? content.filter((b): b is Block => !!b && typeof b === "object" && !Array.isArray(b)) : [];
}

function role(message: unknown): unknown {
  return message && typeof message === "object" ? (message as { role?: unknown }).role : undefined;
}

function contentOf(message: unknown): unknown {
  return message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
}

/** The user message that opened the turn in progress (plain user input, not a tool result). The
 * summary is joined to it; everything before it is compacted. Null when nothing precedes it. */
export function boxSwitchBoundary(messages: readonly unknown[]): number | null {
  for (let i = messages.length - 1; i >= 2; i--) {
    const parts = blocks(contentOf(messages[i]));
    if (role(messages[i]) === "user" && parts.length > 0
      && !parts.some((b) => b.type === "tool_result")) return i;
  }
  return null;
}

/** Claude Code moves its cache_control markers between requests; they are not content. */
export function boxSwitchPrefixDigest(messages: readonly unknown[], boundary: number): string {
  const semantic = messages.slice(0, boundary).map((m) => ({ role: role(m),
    content: blocks(contentOf(m)).map(({ cache_control: _marker, ...rest }) => rest) }));
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

function clip(text: string): string {
  return text.length <= BLOCK_MAX_CHARS ? text
    : `${text.slice(0, BLOCK_MAX_CHARS)} [... ${text.length - BLOCK_MAX_CHARS} characters cut]`;
}

function blockText(block: Block): string {
  switch (block.type) {
    case "text": return typeof block.text === "string" ? block.text : "";
    case "tool_use": return `[tool call ${String(block.name)}] ${clip(JSON.stringify(block.input ?? {}))}`;
    case "tool_result": return `[tool result${block.is_error === true ? " (error)" : ""}] ${
      clip(blocks(block.content).map(blockText).filter(Boolean).join("\n"))}`;
    case "image": return "[image]";
    case "document": return "[document]";
    // Thinking is not part of the record a summary keeps.
    default: return "";
  }
}

export function renderBoxSwitchTranscript(messages: readonly unknown[], boundary: number): string {
  const text = messages.slice(0, boundary).map((m, i) =>
    `[${i}] ${role(m) === "assistant" ? "Assistant" : "User"}:\n${
      blocks(contentOf(m)).map(blockText).filter(Boolean).join("\n")}`).join("\n\n");
  if (text.length <= BOX_SWITCH_TRANSCRIPT_MAX_CHARS) return text;
  const head = Math.floor(BOX_SWITCH_TRANSCRIPT_MAX_CHARS * 0.2);
  const tail = BOX_SWITCH_TRANSCRIPT_MAX_CHARS - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - head - tail} characters of the middle of the conversation are not shown here ...]\n\n${text.slice(-tail)}`;
}

export function boxSwitchSummaryText(summary: string, cliSessionId: string): string {
  return `<system-reminder>
This conversation moved to another Box login. Everything before this message was compacted into the summary below; the turn in progress follows it unchanged.

<summary>
${summary.trim()}
</summary>

The complete earlier conversation is still in this session's Claude Code transcript, the file ${cliSessionId}.jsonl in a project folder under the Claude config directory (in an OpenClaude container: /run/oc/claude-config/projects/*/${cliSessionId}.jsonl). When you need a detail the summary does not have, search that file with the Grep tool and a specific pattern before answering (each line is one long JSON record). Do not guess.
</system-reminder>`;
}

export interface BoxSwitchRecord {
  /** Index in the container's full message list. */
  readonly boundary: number;
  readonly prefixDigest: string;
  readonly summary: string;
  readonly cliSessionId: string;
  /** Claude Code's leading <system-reminder> blocks of the first message (user context such as
   * CLAUDE.md). Claude Code re-sends them on every request; they stay at the start. */
  readonly reminders: readonly Block[];
}

function leadingReminders(message: unknown): Block[] {
  const out: Block[] = [];
  for (const block of blocks(contentOf(message))) {
    if (block.type !== "text" || typeof block.text !== "string"
      || !block.text.trimStart().startsWith("<system-reminder>")) break;
    const { cache_control: _marker, ...rest } = block;
    out.push(rest);
  }
  return out;
}

/** Rewrites `body.messages` in place when its history still starts with the compacted prefix. */
export function applyBoxSwitchRecord(body: ProxyBody, record: BoxSwitchRecord): boolean {
  const messages = body.messages as unknown;
  if (!Array.isArray(messages) || messages.length <= record.boundary) return false;
  if (boxSwitchPrefixDigest(messages, record.boundary) !== record.prefixDigest) return false;
  const first = messages[record.boundary] as Record<string, unknown>;
  body.messages = [{ ...first, content: [...record.reminders,
    { type: "text", text: boxSwitchSummaryText(record.summary, record.cliSessionId) },
    ...blocks(first.content)] }, ...messages.slice(record.boundary + 1)] as ProxyBody["messages"];
  return true;
}

export class BoxSwitchStore {
  private readonly records = new Map<string, { record: BoxSwitchRecord; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  get(uid: bigint, cliSessionId: string): BoxSwitchRecord | undefined {
    const key = `${uid}:${cliSessionId}`;
    const hit = this.records.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) { this.records.delete(key); return undefined; }
    return hit.record;
  }

  set(uid: bigint, record: BoxSwitchRecord): void {
    const key = `${uid}:${record.cliSessionId}`;
    this.records.delete(key);
    this.records.set(key, { record, expires: this.now() + RECORD_TTL_MS });
    for (const old of this.records.keys()) {
      if (this.records.size <= RECORD_MAX) break;
      this.records.delete(old);
    }
  }
}

function derivedHex(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function boxSwitchCompactionBody(transcript: string, ids: { sessionId: string; turnKey: string },
  model: string = BOX_SWITCH_COMPACT_MODEL): ProxyBody {
  return { model, max_tokens: BOX_SWITCH_COMPACT_MAX_OUTPUT, stream: true,
    system: COMPACT_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text",
      text: `<transcript>\n${transcript}\n</transcript>\n\n${COMPACT_INSTRUCTIONS}` }] }],
    metadata: { user_id: JSON.stringify({ session_id: ids.sessionId, oc_turn_key: ids.turnKey }) },
  } as ProxyBody;
}

/** Text of an Anthropic SSE stream (text deltas only). */
export function sseText(raw: string): string {
  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim()) as { type?: string;
        delta?: { type?: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta"
        && typeof event.delta.text === "string") text += event.delta.text;
    } catch { /* not JSON: ignore */ }
  }
  return text;
}

/** The compaction runs before the request's dispatch identity is known, so its usage row first
 * carries the container's session id. Once the proxy has the final (server-owned) session id it
 * relabels that one row, so per-session usage counts the compaction with its chat. Statistics
 * only: cost, ledger and journal are untouched. */
export async function relabelBoxSwitchSession(pool: Pick<Pool, "query">, input: { uid: bigint;
  billingRequestId: string; sessionId: string }): Promise<boolean> {
  const updated = await pool.query(`UPDATE usage_records SET session_id = $3
     WHERE user_id = $1 AND request_id = $2 AND session_id IS DISTINCT FROM $3`,
  [input.uid.toString(), input.billingRequestId, input.sessionId]);
  return updated.rowCount === 1;
}

export interface BoxSwitchDeps {
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
  store: BoxSwitchStore;
  /** True when this chat's last login may no longer take it (benched or >= BOX_CHAT_SWITCH_AT). */
  chatMustMove(uid: bigint, cliSessionId: string): boolean | Promise<boolean>;
  /** The Box text path for one model call (BoxTextFetch.fetch). */
  fetch(args: { uid: bigint; sessionId: string | null; requestId: string; canonicalModel: string;
    canonicalBody: ProxyBody; upstreamModel: string; url: string; init: RequestInit }): Promise<Response>;
  endpoint: string;
  log: Logger;
  /** Tests only: the billing calls (defaults are the proxy's own). */
  billing?: { preCheck?: typeof preCheckWithCost; startJournal?: typeof startInflightJournal;
    finalizer?: typeof makeFinalizer; release?: typeof releasePreCheck };
}

export interface BoxSwitchInput {
  uid: bigint;
  containerId: bigint | null;
  requestId: string;
  /** The request body; its messages are rewritten in place. */
  body: ProxyBody;
  snapshot: ModelCatalogSnapshot;
  deniedModelIds: ReadonlySet<string>;
  sessionId: string | null;
  authority: BillingAuthorityStamp | null;
  signal: AbortSignal;
  /** Set when the caller already has a trace. A request id is not a trace. */
  traceId?: string | null;
}

export type BoxSwitchOutcome =
  | { kind: "none" }
  | { kind: "applied"; boundary: number }
  | { kind: "compacted"; boundary: number; billingRequestId: string; credits: string;
    tokensBefore: number; tokensAfter: number }
  | { kind: "skipped"; reason: string };

function estimateTokens(messages: unknown): number {
  return Math.ceil(JSON.stringify(messages ?? []).length / 4);
}

/** Applies this chat's compaction, or makes one when the chat is about to leave its login. Never
 * throws: any failure leaves the body as it is (full context, the behaviour before this). */
export async function prepareBoxSwitch(deps: BoxSwitchDeps, input: BoxSwitchInput): Promise<BoxSwitchOutcome> {
  let cliSessionId: string;
  try { cliSessionId = deriveBoxCallFingerprint(input.uid, input.body).sessionId; }
  catch { return { kind: "none" }; }
  const raw = input.body.messages as unknown;
  if (!Array.isArray(raw)) return { kind: "none" };
  const rawMessages = [...raw];
  const existing = deps.store.get(input.uid, cliSessionId);
  const applied = existing ? applyBoxSwitchRecord(input.body, existing) : false;
  if (applied) runG8ReplayCheckpoint(g8CompactSummaryCheckpointInput(input.traceId ?? null));
  const offset = applied ? existing!.boundary : 0;
  let mustMove = false;
  try { mustMove = await deps.chatMustMove(input.uid, cliSessionId); } catch { mustMove = false; }
  if (!mustMove) {
    return applied ? { kind: "applied", boundary: existing!.boundary } : { kind: "none" };
  }
  const current = input.body.messages as unknown[];
  const local = boxSwitchBoundary(current);
  const tokensBefore = estimateTokens(current);
  const skip = (reason: string): BoxSwitchOutcome => {
    deps.log.info("box_switch_compaction", { outcome: "skipped", reason, tokensBefore });
    return { kind: "skipped", reason };
  };
  // Only a turn that just started: a tool round in progress keeps its exact history.
  if (local === null || local !== current.length - 1) return skip("not_turn_start");
  if (tokensBefore < BOX_SWITCH_COMPACT_MIN_TOKENS) return skip("short");
  const boundary = offset + local;
  if (existing && applied && boundary <= existing.boundary) return skip("already_compacted");

  const usable = (id: string) => {
    const descriptor = input.snapshot.resolve(id);
    const pricing = input.snapshot.billingPricingFor(id);
    return descriptor && descriptor.providerId === "box_cli" && pricing && !input.deniedModelIds.has(id)
      ? { model: id, descriptor, pricing } : null;
  };
  const pick = BOX_SWITCH_COMPACT_MODELS.map(usable).find((m) => m !== null);
  if (!pick) return skip("model_unavailable");
  const { model, descriptor, pricing } = pick;
  const upstreamModel = descriptor.upstreamModelId ?? model;

  const billingRequestId = `${input.requestId}-switch-compact`;
  const turnKey = derivedHex("box-switch-compact", input.uid.toString(), cliSessionId, String(boundary));
  const compactSessionId = `${cliSessionId}.switch`;
  const transcript = renderBoxSwitchTranscript(current, local);
  const compactBody = boxSwitchCompactionBody(transcript, { sessionId: compactSessionId, turnKey }, model);
  const started = Date.now();
  let pre: Awaited<ReturnType<typeof preCheckWithCost>>;
  try {
    pre = await (deps.billing?.preCheck ?? preCheckWithCost)(deps.preCheckRedis, { userId: input.uid, requestId: billingRequestId,
      maxCost: estimateMaxCostBothSides(Math.ceil(transcript.length / 3), BOX_SWITCH_COMPACT_MAX_OUTPUT, pricing),
      ttlSeconds: BOX_TOOL_MAX_WALL_MS / 1000 + 300 });
  } catch (error) {
    return skip(error instanceof InsufficientCreditsError ? "insufficient_credits" : "precheck_failed");
  }
  let admitted = false;
  try {
    admitted = await (deps.billing?.startJournal ?? startInflightJournal)(deps.pgPool, { requestId: billingRequestId, userId: input.uid,
      containerId: input.containerId, model, precheckCredits: pre.maxCost,
      ctxJson: { boxInvocationRecovery: "v1", billingPricing: serializeBillingPricing(pricing),
        boxBillingContext: serializeBoxBillingContext({ sessionId: input.sessionId, mode: "chat",
          turnKey, authority: input.authority }),
        boxSwitchCompactionFor: input.requestId } });
  } catch { admitted = false; }
  if (!admitted) {
    await (deps.billing?.release ?? releasePreCheck)(deps.preCheckRedis, pre.reservation).catch(() => {});
    return skip("journal_conflict");
  }
  const finalize = (deps.billing?.finalizer ?? makeFinalizer)({ pgPool: deps.pgPool, preCheckRedis: deps.preCheckRedis,
    scheduler: deps.scheduler }, { requestId: billingRequestId, userId: input.uid,
    containerId: input.containerId, accountId: null, slotId: null, model, pricing,
    precheckCredits: pre.maxCost, preCheckReservation: pre.reservation, log: deps.log,
    sessionId: input.sessionId, mode: "chat", turnKey, authority: input.authority });
  const upstreamBody = { ...compactBody, model: upstreamModel,
    metadata: { user_id: JSON.stringify({ session_id: compactSessionId }) } };
  let response: Response;
  try {
    response = await deps.fetch({ uid: input.uid, sessionId: null, requestId: billingRequestId,
      canonicalModel: model, canonicalBody: compactBody, upstreamModel, url: deps.endpoint,
      init: { method: "POST", body: JSON.stringify(upstreamBody), signal: input.signal } });
  } catch (error) {
    await finalize.fail({ kind: "none" }, error, "UPSTREAM_UNAVAILABLE").catch(() => {});
    return skip("compaction_failed");
  }
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _enc, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const piped = response.body
    ? await pipeStreamWithUsageCapture(response.body, sink as unknown as ServerResponse, input.signal)
    : null;
  if (!piped || piped.error !== null) {
    await finalize.fail(piped?.observation ?? { kind: "none" }, piped?.error ?? new Error("no body"),
      "STREAM_FAILED").catch(() => {});
    return skip("compaction_failed");
  }
  const outcome = await finalize.commit(piped.observation);
  const summary = sseText(Buffer.concat(chunks).toString("utf8")).trim();
  if (outcome.state !== "committed" || summary.length < 200) return skip("compaction_empty");
  const record: BoxSwitchRecord = { boundary, prefixDigest: boxSwitchPrefixDigest(rawMessages, boundary),
    summary, cliSessionId, reminders: leadingReminders(rawMessages[0]) };
  deps.store.set(input.uid, record);
  input.body.messages = rawMessages as ProxyBody["messages"];
  applyBoxSwitchRecord(input.body, record);
  runG8ReplayCheckpoint(g8CompactSummaryCheckpointInput(input.traceId ?? null));
  const tokensAfter = estimateTokens(input.body.messages);
  deps.log.info("box_switch_compaction", { outcome: "compacted", billingRequestId, boundary,
    tokensBefore, tokensAfter, credits: outcome.finalCredits.toString(), ms: Date.now() - started });
  return { kind: "compacted", boundary, billingRequestId, credits: outcome.finalCredits.toString(),
    tokensBefore, tokensAfter };
}
