/**
 * V3 commercial container → master sink for server-authored assistant
 * messages.
 *
 * Why this exists:
 *   In v3 commercial, the per-user container runs an OpenClaude gateway
 *   with its own SQLite. But the authoritative `client_sessions` row lives
 *   in master's SQLite (the WebChat frontend PUTs there). Container's
 *   `client_sessions` is permanently empty for v3, so
 *   `appendServerAuthoredMessageDurable` always returns session_not_found
 *   and dead-letters into the local msg-outbox.jsonl. On startup,
 *   `replayMsgOutbox` permanently drops session_not_found entries — the
 *   row is never going to materialise locally. Result: every turn's
 *   authoritative assistant text was lost, and mobile clients that missed
 *   the streaming tail had nothing to recover via REST force-sync.
 *
 *   This module is the container-side counterpart of master's
 *   `packages/commercial/src/http/internalServerAuthored.ts`. We POST to
 *   master via the same internal listener that already terminates
 *   anthropicProxy traffic (self-host plain 18791 / remote-host mTLS
 *   18443) — the route splitter on master mounts our handler on
 *   `/internal/v3/server-authored-message`. Reusing the listener means
 *   no new ports, no new firewall rules, and the same container identity
 *   bearer (`oc-v3.<containerId>.<secret>`) is honoured by the same
 *   `verifyContainerIdentity` machinery on master.
 *
 * Module split:
 *   - `attemptSend(...)` — single HTTP attempt + classification. Throws
 *     typed errors. No retry, no durable state.
 *   - `getV3MasterSinkOrNull()` — reads env, returns a closure-bound
 *     sink, or null if env missing (personal version, dev sandbox, etc.).
 *   - `persistOrQueue(...)` — high-level helper sessionManager calls:
 *     awaits one attempt; on transient/session_missing/network/auth
 *     failures awaits enqueue to durable retry queue; on fatal
 *     classification (4xx schema/method violations from our own bug)
 *     drops with structured warn.
 *
 * Trust boundary:
 *   - Bearer goes in `Authorization: Bearer oc-v3.<id>.<secret>`. We
 *     never log the bearer or echo it into error messages.
 *   - We never send `userId` / `peerId` / `id` over the wire — master
 *     derives those from the verified identity + (sessionId, turnIndex)
 *     to keep tenant isolation tight.
 *   - Body fields are validated client-side ONLY for size sanity (so we
 *     don't enqueue obviously bogus payloads); master's Zod schema is
 *     authoritative.
 *
 * Failure semantics:
 *   - 200 ok / 200 idempotent → success, drop entry.
 *   - 404 SESSION_NOT_FOUND → SessionMissing (retryable under TTL —
 *     frontend's debounced PUT may still be in flight).
 *   - 410 SESSION_DELETED → Fatal (master row was soft-deleted; terminal —
 *     retrying for 24h achieves nothing and just floods logs. Drop on
 *     first response, both for the live persistOrQueue path and for the
 *     drainer replaying a stale durable-queue entry).
 *   - 5xx → Transient.
 *   - Network error / timeout / DNS / TCP RST → Transient.
 *   - 401/403 → Transient (auth misconfig is operationally recoverable;
 *     bearer rotation / clock skew / cert issuance race; we don't want
 *     to drop legit user data because of an ops mistake).
 *   - 400 INVALID_BODY / 405 METHOD / 413 PAYLOAD / 415 → Fatal (these
 *     mean WE are sending something master refuses; retrying with same
 *     payload will never succeed).
 *   - Anything else → Fatal (defensive default: master's contract says
 *     these are the only codes; an unexpected status is a contract
 *     violation worth surfacing rather than spinning).
 */

import { request as undiciRequest } from 'undici'

import { createLogger } from './logger.js'
import type { TurnToolEntry } from './ccbMessageParser.js'
import type { V3MasterRetryQueue, V3MasterRetryEntry } from './v3MasterRetryQueue.js'

const log = createLogger({ module: 'v3MasterSink' })

/** Master's path for server-authored messages. Must match the master
 *  side's `SERVER_AUTHORED_PATH` constant. Don't import from commercial —
 *  gateway is shipped INTO the container image and must not depend on
 *  master-only packages at compile time. Path is part of the wire
 *  contract; master + gateway change it together. */
export const SERVER_AUTHORED_PATH = '/internal/v3/server-authored-message'

/** Body cap for one POST. Mirrors master's MAX_BODY_BYTES so the
 *  payload sanity check matches what master will accept. 256 KB. */
const MAX_BODY_BYTES = 256 * 1024

/** Mirrors master's `SCHEMA_TOOLS_MAX_LEN` in
 *  `commercial/src/http/internalServerAuthored.ts`. Master rejects the
 *  whole POST with 400 INVALID_BODY if `tools.length` exceeds this — and
 *  4xx is classified as fatal here, which means a 51st tiny tool would
 *  drop the *entire* payload including the assistant text. We enforce
 *  the same count policy on this side and drop tools[] (best-effort
 *  durability) to preserve the primary assistant write.
 *
 *  Truncate-to-50 was rejected: if tools.length > 50 we have no signal
 *  on which 50 to keep, and the durable copy is already a redundancy of
 *  what the client streamed. Dropping the whole array is simpler and
 *  preserves the more important invariant (assistant-never-cut). The
 *  parser-side per-tool caps still apply; only the count gate fires here. */
const MAX_TOOLS_PER_PAYLOAD = 50

/** HTTP timeout per single attempt — short enough that a hung master
 *  doesn't pile up turn callbacks; long enough that a slow first SQLite
 *  write under contention won't false-trip. 10s. */
const ATTEMPT_TIMEOUT_MS = 10_000

/**
 * Wire-shape payload. Mirrors what attemptSend serializes to the master.
 *
 * `agentId` is the disambiguator that joins (peerId, agentId, turnIndex)
 * into a globally unique messageId: a single chat (peerId) can rotate
 * across multiple AgentSessions (e.g. user switches model mid-chat,
 * codex → main), each tracking its own `session.turns` counter starting
 * at 0. Without `agentId` the resulting `srv-${peerId}-t1` collides and
 * the client merges two distinct answers into one row (root cause of the
 * 2026-05-13 "switched to deepseek, only thinking visible" bug). Master
 * folds it into the persisted message id (`srv-${peerId}-${agentId}-t${n}`)
 * so refresh-recovery from SQLite recovers the disambiguated row too.
 *
 * Wire optional vs live required: the on-disk retry queue may carry
 * entries written by a pre-Fix-A gateway image (no `agentId` field) —
 * the drainer must be able to deserialize them. So this wire shape
 * marks `agentId?: string`. Live callers in sessionManager use the
 * stricter {@link V3MasterSinkPayload} that requires `agentId`.
 */
export interface V3MasterSinkWirePayload {
  /** Agent that produced this turn. Optional on the wire ONLY to allow
   *  the retry queue to deserialize legacy on-disk entries. New live
   *  callers always set this; absence implies "old queue entry, fall
   *  back to peerId-only messageId on the master side". */
  agentId?: string
  sessionId: string
  turnIndex: number
  status: 'completed' | 'interrupted' | 'crashed'
  /** Assistant text — the user-visible content. Always written if non-empty.
   *  Empty string is allowed when this is a thinking-only turn (Sonnet 4.6
   *  adaptive thinking that ran out of tokens before producing text). */
  text: string
  /** Optional reasoning/thinking text accumulated by ccbMessageParser
   *  during the same turn (capped at MAX_THINKING_BUFFER_BYTES = 8 KB,
   *  UTF-8 safe with `…[truncated]` tail). Master persists this as a
   *  separate `_source: 'server'` message with `role: 'thinking'` and
   *  ts = assistantTs - 1 so it sorts immediately before the assistant
   *  message of the same turn. Body-cap policy: if combined body exceeds
   *  MAX_BODY_BYTES, we drop tools[] first (durable tool snapshot is
   *  redundant with the live stream), then thinkingText, to preserve
   *  assistant — thinking is auxiliary debug content, assistant is the
   *  conversation. */
  thinkingText?: string
  /** Optional client-supplied wall-clock ms; master uses this for the
   *  message ts so all clients see the same timestamp regardless of
   *  retry timing. Defaults to Date.now() at master if omitted. */
  createdAt?: number
  /** Plan §4.4 改动 7 — required when text is non-empty. Joins this
   *  assistant message with the eventual `appendCostCredits` patch via
   *  master's `server_authored_request_map` table. Caller propagates this
   *  from the upstream proxy `x-openclaude-request-id` header captured at
   *  stream begin, so master and gateway agree on a single key. */
  requestId?: string
  /** Plan §4.4 改动 7 — token usage gathered by the gateway-side stream
   *  finalizer at `message_stop`. Persisted into `messages[i].usage`;
   *  costCredits joins later via `appendCostCredits`. Snake-case JSON
   *  field names (matching master schema in `internalServerAuthored.ts`)
   *  are camelCased here for TS hygiene. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    model?: string
    turn?: number
    /** Master-owned per-turn canonical traceId (generated at inbound.message
     *  entry, stamped onto the outbound.message frame). Folded into
     *  `messages[i].usage.traceId` so the web UI can surface a copyable
     *  "请求ID" that ops greps verbatim against master turn logs — and so it
     *  survives refresh via the same server-authoritative usage sync channel
     *  as inputTokens/costCredits. Nested under usage (not a sibling) because
     *  usage is already the sync overlay key carrying turn metadata (model/
     *  turn), so traceId rides existing rails with no new overlay-key wiring. */
    traceId?: string
  }
  /** Plan §4.4 改动 7 — turn was truncated (max_tokens / stop_reason
   *  diverged from `end_turn`). Renders the red "已截断" pill on the
   *  assistant message after a refresh. */
  truncated?: boolean
  /** Plan §4.4 改动 7 — short error code for refresh-stable error pill
   *  (e.g. 'overloaded_error'). Joins `errorDetail` for the long form. */
  errorCode?: string
  errorDetail?: string
  /** Top-level tool calls completed in this turn (parser already capped
   *  per-tool: output ≤4KB, inputJson ≤8KB, inputPreview ≤500 chars).
   *  Master persists each as a separate `_source: 'server'` message with
   *  `role: 'tool'` between thinking and assistant of the same turn — that
   *  durable copy is what survives a refresh, replacing the ephemeral
   *  client-authored tool rows whose details are stripped on persist.
   *  Body-cap policy (see attemptSend): tools[] is dropped before
   *  thinkingText, because losing tool details is more recoverable than
   *  losing the thinking trace (tools can be re-inferred from result text
   *  in a degraded UI; thinking can't be reconstructed).
   *
   *  Fix B (2026-05-25): each `TurnToolEntry.arrivedAt` is the tool CARD
   *  APPEARANCE time (parser-stamped at first tool_use observation, NEW
   *  field). Master priority chain `arrivedAt ?? (baseTs - toolsCount + i)`
   *  prefers it for the persisted row ts so parallel-tool refresh order
   *  matches the live emit order. The legacy `ts` field retains the
   *  tool_result completion semantic and is ignored by master (preserves
   *  pre-Fix-B behavior for old gateways). */
  tools?: TurnToolEntry[]
  /** Fix B (2026-05-25) — per-text-segment payload. When present, master
   *  writes ONE assistant row per segment (`srv-...-tN-s${idx}`) with the
   *  segment's own ts so ts-sort interleaves correctly with tool rows.
   *  When absent (old gateway, legacy callers), master falls back to the
   *  single-row `text` field above.
   *  Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §3.5.1. */
  assistantSegments?: Array<{ index: number; text: string; ts: number }>
  /** Fix B (2026-05-25) — same per-segment treatment for thinking rows
   *  (`srv-...-tN-thinking-s${idx}`). */
  thinkingSegments?: Array<{ index: number; text: string; ts: number }>
}

/**
 * Live caller payload — required by sessionManager.persistServerAuthoredTurn
 * and the V3MasterSink interface. Tightens {@link V3MasterSinkWirePayload}
 * by making `agentId` non-optional, matching the in-process invariant that
 * any live turn-end has a known agentId (AgentSession.agentId is set at
 * getOrCreate time). The wire variant exists ONLY so the retry queue can
 * deserialize pre-Fix-A disk entries.
 */
export interface V3MasterSinkPayload extends V3MasterSinkWirePayload {
  agentId: string
}

export type V3SinkErrorClass = 'transient' | 'session_missing' | 'fatal'

/** Base class so callers can `instanceof V3SinkError` to gate fallback. */
export class V3SinkError extends Error {
  constructor(
    message: string,
    public readonly errorClass: V3SinkErrorClass,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'V3SinkError'
  }
}

export interface V3MasterSinkConfig {
  baseUrl: string
  bearer: string
}

/** Read env-driven config. Returns null when either env is missing —
 *  personal version + dev sandbox don't set them, and we want to
 *  no-op silently in that case (sessionManager falls back to the
 *  legacy local durable path). */
export function readV3MasterSinkConfig(env: NodeJS.ProcessEnv = process.env): V3MasterSinkConfig | null {
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !bearer) return null
  // Strip trailing slash so URL composition is unambiguous.
  return { baseUrl: baseUrl.replace(/\/+$/, ''), bearer }
}

export interface AttemptSendDeps {
  config: V3MasterSinkConfig
  /** Override only for tests — real callers use undici. */
  fetcher?: typeof undiciRequest
  /** Override only for tests — real callers use Date.now. */
  now?: () => number
  /** Override only for tests — real callers use ATTEMPT_TIMEOUT_MS. */
  timeoutMs?: number
}

/**
 * One immediate POST attempt. Returns void on success; throws V3SinkError
 * with .errorClass set on any failure. Caller decides what to do with
 * the classification (enqueue durable / drop / log).
 *
 * NEVER logs the bearer; only the path + status code on the failure log
 * line. Body is logged at debug only when classification is fatal (so
 * ops can see what schema we sent that master rejected).
 *
 * Wire-format rolling-deploy invariant (2026-05-13 Fix A):
 *   New live gateway always sends `agentId` (V3MasterSinkPayload requires
 *   it; sessionManager call sites pass `session.agentId`). The retry
 *   queue can ALSO call this with `V3MasterSinkWirePayload` for pre-Fix-A
 *   on-disk entries that have no agentId.
 *
 *   The supported rollout direction is master-first: `scripts/deploy-v3.sh`
 *   updates the master host (rsync + `systemctl restart openclaude`) and
 *   does NOT touch per-host container images. Container image
 *   build/distribution is a separate manual step (`build-image.sh` +
 *   `scripts/distribute-image-explicit.ts`). Therefore live traffic during
 *   any normal upgrade is "old-container → new-master" (handled by the
 *   agentId-optional schema on master, falling back to the legacy
 *   `srv-${sessionId}-t${turnIndex}` id) and after distribution
 *   "new-container → new-master".
 *
 *   "new-container → old-master" can only arise from operator-coordinated
 *   master rollback after container image rollout. That is operationally
 *   out-of-contract for any wire-format change; rolling master back must
 *   either pause user traffic or roll containers back together. The
 *   sink intentionally does NOT carry a fallback retry without agentId —
 *   doing so would (a) reintroduce the exact id collision Fix A removes
 *   on rollback, (b) mask legitimate INVALID_BODY ops signals, and (c)
 *   couple the sink to wire-format versioning that belongs in deploy
 *   tooling.
 */
export async function attemptSend(
  payload: V3MasterSinkWirePayload,
  deps: AttemptSendDeps,
): Promise<void> {
  const url = `${deps.config.baseUrl}${SERVER_AUTHORED_PATH}`
  const fetcher = deps.fetcher ?? undiciRequest
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS

  const bodyObj: Record<string, unknown> = {
    sessionId: payload.sessionId,
    turnIndex: payload.turnIndex,
    status: payload.status,
    text: payload.text,
    // agentId is optional on the wire to keep legacy retry-queue entries
    // (written by pre-Fix-A gateway images) drainable. Master folds it
    // into the persisted messageId when present; absence falls back to
    // the pre-Fix-A `srv-${sessionId}-t${turnIndex}` format.
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    ...(payload.createdAt !== undefined ? { createdAt: payload.createdAt } : {}),
    // Plan §4.4 改动 7 — extra fields. All optional on the wire; master's
    // schema refine requires `requestId` only when text is non-empty (i.e.
    // assistant write). We forward them as-is (null/empty values are
    // dropped by the spread guard below).
    ...(payload.requestId !== undefined ? { requestId: payload.requestId } : {}),
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
    ...(payload.truncated ? { truncated: true } : {}),
    ...(payload.errorCode !== undefined ? { errorCode: payload.errorCode } : {}),
    ...(payload.errorDetail !== undefined ? { errorDetail: payload.errorDetail } : {}),
  }
  if (payload.thinkingText && payload.thinkingText.length > 0) {
    bodyObj.thinkingText = payload.thinkingText
  }
  // Fix B (2026-05-25) — per-segment row id. Forward both segment arrays
  // when non-empty. Master uses these in preference to the single-row
  // `text` / `thinkingText` fields above. NOTE: master BodySchema is
  // `.strict()` (rejects unknown fields with 400 INVALID_BODY → fatal-drop
  // in this sink), so a new gateway × old master cross will hard-fail
  // these turns. Deploy contract is **master-first** per the v3 rollout
  // SOP (deploy-v3.sh sequences master → image distribute). Do NOT roll
  // a gateway image carrying these fields before the master upgrade.
  // Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §3.5.1.
  if (payload.assistantSegments && payload.assistantSegments.length > 0) {
    bodyObj.assistantSegments = payload.assistantSegments
  }
  if (payload.thinkingSegments && payload.thinkingSegments.length > 0) {
    bodyObj.thinkingSegments = payload.thinkingSegments
  }
  if (payload.tools && payload.tools.length > 0) {
    // Count cap (must precede byte cap): master rejects > MAX_TOOLS_PER_PAYLOAD
    // with 400 INVALID_BODY which our classifier marks fatal — that would
    // drop the assistant text too. Drop the durable tool snapshot here so
    // the primary assistant write still goes through. Live streamed tool
    // blocks are unaffected; only refresh-recovery durability degrades.
    if (payload.tools.length > MAX_TOOLS_PER_PAYLOAD) {
      log.warn('v3 sink dropped tools[] to fit master count cap', {
        sessionId: payload.sessionId,
        turnIndex: payload.turnIndex,
        toolCount: payload.tools.length,
        cap: MAX_TOOLS_PER_PAYLOAD,
      })
    } else {
      bodyObj.tools = payload.tools
    }
  }
  let body = JSON.stringify(bodyObj)
  let bodyBytes = Buffer.byteLength(body, 'utf8')
  if (bodyBytes > MAX_BODY_BYTES) {
    const hasTools = bodyObj.tools !== undefined
    // Truncation order (most-droppable first):
    //   1. tools[]       — durable redundancy of streaming tool rows; client
    //                      already has the bare tool_use/result blocks from
    //                      the live stream, so dropping the durable copy
    //                      degrades refresh-recovery only (no live impact).
    //   2. thinkingText  — auxiliary debug content; conversation survives.
    //   3. else fatal    — assistant text alone over 256 KB is a CCB bug
    //                      worth surfacing rather than silently truncating.
    if (hasTools) {
      log.warn('v3 sink dropped tools[] to fit body cap', {
        sessionId: payload.sessionId,
        turnIndex: payload.turnIndex,
        originalBytes: bodyBytes,
        toolCount: (payload.tools ?? []).length,
      })
      delete bodyObj.tools
      body = JSON.stringify(bodyObj)
      bodyBytes = Buffer.byteLength(body, 'utf8')
    }
  }
  if (bodyBytes > MAX_BODY_BYTES) {
    const hasAssistant =
      (bodyObj.text as string).length > 0 || bodyObj.assistantSegments !== undefined
    const hasThinking =
      bodyObj.thinkingText !== undefined || bodyObj.thinkingSegments !== undefined
    if (hasAssistant && hasThinking) {
      // Combined over cap — drop BOTH thinkingText and thinkingSegments
      // (atomically: they describe the same thinking content in two encodings)
      // to preserve assistant. Thinking is auxiliary debug content; the
      // conversation can survive without it.
      log.warn('v3 sink dropped thinking content to fit body cap', {
        sessionId: payload.sessionId,
        turnIndex: payload.turnIndex,
        originalBytes: bodyBytes,
        hadThinkingText: bodyObj.thinkingText !== undefined,
        hadThinkingSegments: bodyObj.thinkingSegments !== undefined,
      })
      delete bodyObj.thinkingText
      delete bodyObj.thinkingSegments
      body = JSON.stringify(bodyObj)
      bodyBytes = Buffer.byteLength(body, 'utf8')
      if (bodyBytes > MAX_BODY_BYTES) {
        // Assistant alone still over cap — fatal. Master's contract caps at
        // MAX_BODY_BYTES; sending invalid body would just 413 with retry.
        // Never partial-drop assistantSegments: dropping a middle segment
        // would let tool rows sandwich incorrectly on refresh.
        throw new V3SinkError('assistant-only payload exceeds master body cap', 'fatal')
      }
    } else if (hasThinking && !hasAssistant) {
      // Thinking-only over cap. Parser-side MAX_THINKING_BUFFER_BYTES = 8 KB
      // should prevent this; if we hit it, log loudly because it indicates
      // the parser cap leaked. Don't strip thinkingText/thinkingSegments —
      // that would yield a schema-invalid body (master refines
      // text>0 || thinkingText || assistantSegments || thinkingSegments
      // is present).
      log.error(
        'v3 sink thinking-only payload exceeds body cap (parser cap should have prevented this)',
        {
          sessionId: payload.sessionId,
          turnIndex: payload.turnIndex,
          bodyBytes,
        },
      )
      throw new V3SinkError('thinking-only payload exceeds master body cap', 'fatal')
    } else {
      // Assistant alone over cap (no thinking content to drop). Never
      // partial-drop assistantSegments.
      throw new V3SinkError('assistant-only payload exceeds master body cap', 'fatal')
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Awaited<ReturnType<typeof undiciRequest>>
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${deps.config.bearer}`,
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    // Network / DNS / TCP / TLS / abort — all transient. Log at debug
    // because retry is automatic; ops only cares if drainer can't keep
    // up (queue depth metric).
    const msg = err instanceof Error ? err.message : String(err)
    throw new V3SinkError(`network error: ${msg}`, 'transient')
  }
  clearTimeout(timer)

  const status = res.statusCode
  // Drain the body even on success so the keep-alive socket can return
  // to the pool (undici holds it open otherwise). 256 KB cap on the
  // body we read so a misbehaving master can't OOM the container with
  // a giant error payload.
  let bodyText = ''
  try {
    bodyText = await readBoundedBody(res.body, MAX_BODY_BYTES)
  } catch {
    // Body read failed — for non-2xx this means we lose master's error
    // detail, but we still have the status code which carries the
    // classification we need.
  }

  if (status >= 200 && status < 300) {
    return
  }
  if (status === 404) {
    throw new V3SinkError(`session_not_found: ${truncateForLog(bodyText)}`, 'session_missing', 404)
  }
  if (status === 410) {
    // Master row was soft-deleted. Terminal — retrying is pointless and
    // generates 24h-TTL log spam (historical incident: ~190K log lines from
    // one user across 7 successive container replacements draining the same
    // dead session). The bare-4xx fallback below would also classify this
    // as fatal, but an explicit branch makes the contract self-documenting
    // and gives a clearer error message.
    throw new V3SinkError(`session_deleted: ${truncateForLog(bodyText)}`, 'fatal', 410)
  }
  if (status >= 500 && status < 600) {
    throw new V3SinkError(`master ${status}: ${truncateForLog(bodyText)}`, 'transient', status)
  }
  if (status === 401 || status === 403) {
    // Auth misconfig (bearer rotation / clock skew / cert issuance race).
    // Treat as transient so the durable queue keeps the data; ops can
    // fix the env without losing turn texts. If it persists past TTL the
    // entry will TTL-drop with a warn — that's the loud signal.
    throw new V3SinkError(`auth ${status}: ${truncateForLog(bodyText)}`, 'transient', status)
  }
  // Any other 4xx — schema / method / payload violation. Master's
  // contract says only the codes above can occur; an unexpected one
  // means our request shape is wrong and retrying changes nothing.
  throw new V3SinkError(`master rejected ${status}: ${truncateForLog(bodyText)}`, 'fatal', status)
}

async function readBoundedBody(
  body: { [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array | string> },
  max: number,
): Promise<string> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    const b = chunk instanceof Buffer
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk)
    total += b.length
    if (total > max) break
    chunks.push(b)
  }
  return Buffer.concat(chunks, Math.min(total, max)).toString('utf8')
}

function truncateForLog(s: string): string {
  if (s.length <= 200) return s
  return s.slice(0, 200) + '…'
}

// ─── high-level orchestration ───────────────────────────────────────────

export interface V3MasterSink {
  /** Try once. On transient / session_missing → enqueue durable. On
   *  fatal → log + drop. Returns the outcome so callers can metric.
   *  Live caller path — payload must include `agentId`. */
  persistOrQueue(payload: V3MasterSinkPayload): Promise<PersistOutcome>
  /** Single-attempt for the drainer to call directly without going
   *  through enqueue. Accepts the wire shape (agentId optional) so the
   *  retry queue can drain pre-Fix-A on-disk entries that were written
   *  before the agentId field existed. Master tolerates the absence by
   *  falling back to the legacy `srv-${sessionId}-t${turnIndex}` id. */
  attemptOnce(payload: V3MasterSinkWirePayload): Promise<void>
}

export type PersistOutcome =
  | { ok: true }
  | { ok: false; queued: true; errorClass: 'transient' | 'session_missing' }
  | { ok: false; queued: false; droppedReason: string }

export interface MakeV3MasterSinkDeps {
  config: V3MasterSinkConfig
  retryQueue: V3MasterRetryQueue
  /** Override only for tests. */
  attemptSendImpl?: typeof attemptSend
  now?: () => number
}

export function makeV3MasterSink(deps: MakeV3MasterSinkDeps): V3MasterSink {
  const attempt = deps.attemptSendImpl ?? attemptSend
  const now = deps.now ?? (() => Date.now())

  const attemptOnce = (payload: V3MasterSinkWirePayload): Promise<void> =>
    attempt(payload, { config: deps.config })

  const persistOrQueue = async (payload: V3MasterSinkPayload): Promise<PersistOutcome> => {
    try {
      await attemptOnce(payload)
      return { ok: true }
    } catch (err) {
      if (err instanceof V3SinkError) {
        if (err.errorClass === 'transient' || err.errorClass === 'session_missing') {
          // Plan v2.1 explicit-await chain: the enqueue must complete
          // before we return — otherwise a process exit in the next
          // millisecond loses the entry. sessionManager already kicks
          // this from a .then() chain, so awaiting here is fine
          // latency-wise (turn-end fan-out, not in-loop).
          const entry: V3MasterRetryEntry = {
            schemaVersion: 1,
            payload: { ...payload, createdAt: payload.createdAt ?? now() },
            firstSeenAt: now(),
            attempts: 1,
            lastErrorClass: err.errorClass,
            lastErrorAt: now(),
            lastErrorMessage: err.message,
          }
          await deps.retryQueue.enqueueDurable(entry)
          log.info('v3 master sink: enqueued for retry', {
            sessionId: payload.sessionId,
            turnIndex: payload.turnIndex,
            errorClass: err.errorClass,
            httpStatus: err.httpStatus,
          })
          return { ok: false, queued: true, errorClass: err.errorClass }
        }
        // fatal — schema violation on our side; queue won't help.
        log.warn(
          'v3 master sink: dropping fatal payload',
          {
            sessionId: payload.sessionId,
            turnIndex: payload.turnIndex,
            httpStatus: err.httpStatus,
          },
          err,
        )
        return { ok: false, queued: false, droppedReason: err.message }
      }
      // Unknown throw — defensively classify as transient so we don't
      // drop user data on a bug we didn't anticipate.
      log.error(
        'v3 master sink: unexpected throw, treating as transient',
        { sessionId: payload.sessionId, turnIndex: payload.turnIndex },
        err,
      )
      const entry: V3MasterRetryEntry = {
        schemaVersion: 1,
        payload: { ...payload, createdAt: payload.createdAt ?? now() },
        firstSeenAt: now(),
        attempts: 1,
        lastErrorClass: 'transient',
        lastErrorAt: now(),
        lastErrorMessage: err instanceof Error ? err.message : String(err),
      }
      await deps.retryQueue.enqueueDurable(entry)
      return { ok: false, queued: true, errorClass: 'transient' }
    }
  }

  return { persistOrQueue, attemptOnce }
}

// ─── module-level singleton (set at startup, read at turn-end) ──────────

let singleton: V3MasterSink | null = null

/** Wire at startup from server.ts. Pass null to disable explicitly
 *  (tests, dev). */
export function setV3MasterSinkSingleton(sink: V3MasterSink | null): void {
  singleton = sink
}

/** Returns the current sink, or null if not configured. sessionManager
 *  uses this gate to choose between v3-master-sink and the legacy
 *  durable local-SQLite path. */
export function getV3MasterSinkOrNull(): V3MasterSink | null {
  return singleton
}
