import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
// Test-only override of the spawn used to launch `codex app-server`. See
// codexRunner.ts `__setCodexSpawnForTests` for rationale; same pattern here.
let _spawnFn: typeof spawn = spawn
export function __setCodexAppServerSpawnForTests(fn: typeof spawn | null): void {
  _spawnFn = fn ?? spawn
}
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type OpenClaudeConfig, paths } from '@openclaude/storage'
import { type CodexLaunchOverrides, buildCodexLaunchOverrides } from './codexLaunchOverrides.js'
import { _sanitizeThreadId, buildCodexEnv, copyImagePathsToPublicDir } from './codexRunner.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'codexAppServerRunner' })

const CODEX_DEFAULT_MODE_INSTRUCTIONS = [
  'You are in implementation mode, not plan-only mode.',
  'If the user asks to start or implement an approved plan, first create or update a concise task list, then execute the work in the same turn.',
  'Keep exactly one task in progress while working and mark tasks completed as you finish them.',
  'Do not create another review-only plan document unless the user explicitly asks to revise the plan.',
].join(' ')

// ───────────────────────────────────────────────
// CodexAppServerRunner
//
// Drop-in replacement for the legacy CodexRunner that talks to a long-lived
// `codex app-server --listen stdio://` JSON-RPC subprocess instead of spawning
// `codex exec` per turn. Wins over CodexRunner:
//   1. Token-level streaming via `item/agentMessage/delta` notifications, so
//      the web client can render assistant text as it arrives instead of
//      waiting for `item.completed agent_message` at end of turn.
//   2. Native `imageGeneration` thread item with `savedPath` field, removing
//      the directory-baseline-diff dance the exec runner relied on (codex
//      `--json` exec stream omits image_gen events).
//
// Emits the same SubprocessRunner-shaped events sessionManager subscribes to:
//   session_id, spawn, exit, message, error, telemetry, parse_error
// Exposes the same public surface (start/submit/shutdown/interrupt/
// updateConfig/setEffortLevel/sendPermissionResponse, isRunning getter,
// lastActivityAt + effortLevel fields) so it slots in via the existing
// `as unknown as SubprocessRunner` cast in sessionManager.
//
// Protocol notes (codex app-server v2 — verified against schemas at
// /tmp/codex-protocol/v2 and live spike on 2026-04-30):
//   - Line-delimited JSON-RPC 2.0 over stdio, bidirectional (server can issue
//     requests too — OpenClaude personal runs codex app-server as a trusted,
//     autonomous agent, so approval-style requests are auto-approved instead
//     of being surfaced to the browser UI).
//   - Handshake: `initialize { clientInfo: { name, version } }` once per proc.
//   - Thread create: `thread/start { approvalPolicy: 'never', sandbox: 'danger-full-access', cwd, model? }`.
//     Resume: `thread/resume { threadId, approvalPolicy, sandbox, cwd?, model? }`.
//   - Turn: `turn/start { threadId, input: [{type:'text', text}] }` returns
//     `{ turn: { id, status:'inProgress' } }`. Turn id captured for filtering
//     and `turn/interrupt`.
//   - Notifications during a turn:
//       item/started / item/completed { threadId, turnId, item }
//       item/agentMessage/delta       { threadId, turnId, itemId, delta }
//       turn/completed                { threadId, turn: { id, status, durationMs, error? } }
//     status enum: completed | interrupted | failed | inProgress.
// ───────────────────────────────────────────────

export interface CodexAppServerRunnerOpts {
  sessionKey: string
  agentId: string
  cwd: string
  /** Previously captured codex thread_id — continue the conversation. Caller
   *  must ensure this is a codex thread_id, not a CCB session id; sessionManager
   *  enforces this via provider-tagged resume map. */
  resumeSessionId?: string
  /** Agent model id from agents.yaml (e.g. `gpt-5-codex`). Forwarded to
   *  thread/start/resume so codex picks the right model. */
  model?: string
  /** Optional egress HTTP proxy URL (per-agent). Forwarded into buildCodexEnv
   *  → HTTPS_PROXY/HTTP_PROXY (+ lowercase) for the spawned codex app-server
   *  subprocess. See AgentDef.proxyUrl in storage/config.ts for semantics. */
  proxyUrl?: string
  // ── Platform context injection (parity with SubprocessRunner / CodexRunner) ──
  // When `config` is provided, the runner builds an `extra-prompt.md` from
  // `buildPromptContext()` and an mcp-memory MCP server entry, then passes
  // them to `codex app-server` via `-c model_instructions_file=...` and
  // `-c mcp_servers.openclaude_memory.*=...`. Omit `config` to keep the
  // legacy "naked codex" launch (no platform context) — used by tests.
  /** Path to agent's persona file (CLAUDE.md / SOUL.md). Forwarded to
   *  `buildPromptContext` to render the SOUL slot. */
  persona?: string
  /** Effective provider for `buildPromptContext` provider-keyed slot logic.
   *  For codex-native agents this is usually 'codex-native'. */
  agentProvider?: string
  /** Initial effort level passed through to `buildPromptContext` for the
   *  RESEARCH slot activation. */
  effortLevel?: string
  /** Gateway config; required for platform context injection. When omitted,
   *  the runner skips override generation entirely (legacy behavior). */
  config?: OpenClaudeConfig
  /** Forwarded to mcp-memory env so delegate_task can enforce recursion caps. */
  delegationDepth?: number
  /** Per-turn default. SessionManager resets this before every submit. */
  conversationMode?: 'default' | 'plan'
}

interface QueuedTurn {
  prompt: string
  resolve: () => void
  reject: (err: Error) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
}

type CodexPlanStep = { step: string; status: 'pending' | 'inProgress' | 'completed' }
type CodexGoalBlock = {
  blockId: string
  objective?: string
  status?: string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
  createdAt?: number
  updatedAt?: number
  cleared?: boolean
}

type CollabAgentStateSummary = { status: string; message?: string }

function normalizeCodexPlanSteps(raw: unknown): CodexPlanStep[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => {
      const obj = s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
      const step = typeof obj.step === 'string' ? obj.step : ''
      const status = obj.status
      if (!step) return null
      return {
        step,
        status:
          status === 'inProgress' || status === 'completed' || status === 'pending'
            ? status
            : 'pending',
      } as const
    })
    .filter((s): s is CodexPlanStep => Boolean(s))
}

function codexPlanBlockId(rawId: unknown, fallback = 'codex-plan'): string {
  return typeof rawId === 'string' && rawId.length > 0 ? rawId : fallback
}

function finiteNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

function normalizeCodexGoal(raw: unknown, cleared = false): CodexGoalBlock {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const goal: CodexGoalBlock = { blockId: 'codex-goal' }
  if (typeof obj.objective === 'string') goal.objective = obj.objective
  if (typeof obj.status === 'string') goal.status = obj.status
  if (obj.tokenBudget === null) {
    goal.tokenBudget = null
  } else {
    const tokenBudget = finiteNumber(obj.tokenBudget)
    if (tokenBudget !== undefined) goal.tokenBudget = tokenBudget
  }
  const tokensUsed = finiteNumber(obj.tokensUsed)
  if (tokensUsed !== undefined) goal.tokensUsed = tokensUsed
  const timeUsedSeconds = finiteNumber(obj.timeUsedSeconds)
  if (timeUsedSeconds !== undefined) goal.timeUsedSeconds = timeUsedSeconds
  const createdAt = finiteNumber(obj.createdAt)
  if (createdAt !== undefined) goal.createdAt = createdAt
  const updatedAt = finiteNumber(obj.updatedAt)
  if (updatedAt !== undefined) goal.updatedAt = updatedAt
  if (cleared) goal.cleared = true
  return goal
}

function collabReceiverThreadIds(item: Record<string, unknown>): string[] {
  return Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
}

function collabAgentsStates(
  item: Record<string, unknown>,
): Record<string, CollabAgentStateSummary> {
  const raw = item.agentsStates
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CollabAgentStateSummary> = {}
  for (const [threadId, stateUnk] of Object.entries(raw as Record<string, unknown>)) {
    const state =
      stateUnk && typeof stateUnk === 'object' ? (stateUnk as Record<string, unknown>) : {}
    const status = typeof state.status === 'string' ? state.status : ''
    if (!threadId || !status) continue
    const message = typeof state.message === 'string' && state.message ? state.message : undefined
    out[threadId] = message ? { status, message } : { status }
  }
  return out
}

function collabTool(item: Record<string, unknown>): string {
  return typeof item.tool === 'string' && item.tool ? item.tool : 'unknown'
}

function collabStatus(item: Record<string, unknown>): string {
  return typeof item.status === 'string' && item.status ? item.status : 'unknown'
}

function collabPrompt(item: Record<string, unknown>): string {
  return typeof item.prompt === 'string' ? item.prompt : ''
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 6)}…${threadId.slice(-4)}` : threadId
}

function collabAgentInput(
  item: Record<string, unknown>,
  description: string,
): Record<string, unknown> {
  const prompt = collabPrompt(item)
  const receivers = collabReceiverThreadIds(item)
  const input: Record<string, unknown> = {
    description: description || prompt || 'Codex 子 Agent',
    codexTool: collabTool(item),
  }
  if (prompt) input.prompt = prompt
  if (receivers.length > 0) input.receiverThreadIds = receivers
  if (typeof item.model === 'string' && item.model) input.model = item.model
  if (typeof item.reasoningEffort === 'string' && item.reasoningEffort) {
    input.reasoningEffort = item.reasoningEffort
  }
  const states = collabAgentsStates(item)
  if (Object.keys(states).length > 0) input.agentsStates = states
  return input
}

function summarizeCollabControl(item: Record<string, unknown>): string {
  const tool = collabTool(item)
  const status = collabStatus(item)
  const receivers = collabReceiverThreadIds(item)
  const states = collabAgentsStates(item)
  const parts = [`${tool}: ${status}`]
  if (receivers.length > 0) parts.push(`receivers: ${receivers.map(shortThreadId).join(', ')}`)
  const stateLines = Object.entries(states).map(([threadId, state]) => {
    const msg = state.message ? ` — ${state.message}` : ''
    return `${shortThreadId(threadId)}: ${state.status}${msg}`
  })
  if (stateLines.length > 0) parts.push(stateLines.join('\n'))
  return parts.join('\n')
}

function isTerminalCollabAgentStatus(status: string): boolean {
  return (
    status === 'completed' || status === 'errored' || status === 'shutdown' || status === 'notFound'
  )
}

function isErrorCollabAgentStatus(status: string): boolean {
  return status === 'errored' || status === 'notFound'
}

/** Structured error produced by `sendRequest` when codex replies with a
 *  JSON-RPC error frame. Callers can branch on `rpcCode` / `rpcMessage` /
 *  `rpcMethod` without re-parsing `message`; the human-readable `message`
 *  is preserved (`"<method> -> <code>: <message>"`) for log/UI use. */
export interface JsonRpcCallError extends Error {
  rpcCode: number
  rpcMessage: string
  rpcMethod: string
}

/** Detect codex's "thread/resume against a thread whose rollout is no longer
 *  on disk" failure mode. Triggered when v3 commercial containers idle-rebuild
 *  and their `~/.codex/sessions/...` JSONL is wiped while master gateway still
 *  holds the old `thread_id` in resume-map.json. The fix is a transparent
 *  thread/start fallback (see runTurn attach block).
 *
 *  Three guards (Codex review #019e0b72 BLOCKER 1):
 *   - `rpcMethod === 'thread/resume'` — only this method can produce the
 *     missing-rollout case; other methods returning -32600 mean something else.
 *   - `rpcCode === -32600` — JSON-RPC "Invalid Request" code that codex 0.125
 *     reuses for missing rollout (verified via spike).
 *   - `/no rollout found/i` — text guard so a future codex release that
 *     repurposes -32600 for protocol/schema drift (e.g. param shape change)
 *     won't be silently downgraded into "start a fresh thread". Drift should
 *     surface as a hard error instead. */
export function isMissingRolloutError(err: unknown): err is JsonRpcCallError {
  if (!(err instanceof Error)) return false
  const e = err as Partial<JsonRpcCallError>
  return (
    e.rpcMethod === 'thread/resume' &&
    e.rpcCode === -32600 &&
    typeof e.rpcMessage === 'string' &&
    /no rollout found/i.test(e.rpcMessage)
  )
}

/** Runner message shape used by sessionManager.ts (subset of SdkMessage). */
interface RunnerMessage {
  type: string
  subtype?: string
  session_id?: string | null
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: string | unknown
      is_error?: boolean
    }>
  }
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
  usage?: { input_tokens?: number; output_tokens?: number }
  event?: unknown
}

type JsonRpcLine =
  | {
      kind: 'response'
      id: number | string
      result?: unknown
      error?: { code: number; message: string }
    }
  | { kind: 'server-request'; id: number | string; method: string; params?: unknown }
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'unknown' }

function jsonRpcResult(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function jsonRpcMethodNotFound(id: number | string, method: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `method '${method}' not implemented by openclaude-gateway`,
    },
  })
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function chooseApprovalString(options: unknown[]): string {
  const strings = options.filter((v): v is string => typeof v === 'string')
  const preferred = [
    'approve',
    'always_allow',
    'allow',
    'approved',
    'accept',
    'approved_for_session',
    'yes',
  ]
  for (const p of preferred) {
    const hit = strings.find((s) => s.toLowerCase().includes(p))
    if (hit) return hit
  }
  return (
    strings.find((s) => !/decline|deny|denied|cancel|abort|reject/i.test(s)) ?? strings[0] ?? ''
  )
}

function buildMcpElicitationFieldValue(schemaUnk: unknown): unknown {
  const schema = asRecord(schemaUnk)
  if ('default' in schema && schema.default !== undefined && schema.default !== null) {
    return schema.default
  }

  if (Array.isArray(schema.enum)) {
    return chooseApprovalString(schema.enum)
  }
  if (Array.isArray(schema.oneOf)) {
    return chooseApprovalString(schema.oneOf.map((o) => asRecord(o).const))
  }
  const items = asRecord(schema.items)
  if (Array.isArray(items.anyOf)) {
    return [chooseApprovalString(items.anyOf.map((o) => asRecord(o).const))]
  }
  if (Array.isArray(items.enum)) {
    return [chooseApprovalString(items.enum)]
  }

  switch (schema.type) {
    case 'boolean':
      return true
    case 'number':
    case 'integer':
      return 0
    case 'array':
      return []
    case 'string':
      return ''
    default:
      return null
  }
}

function buildMcpElicitationContent(paramsUnk: unknown): Record<string, unknown> | null {
  const params = asRecord(paramsUnk)
  if (params.mode !== 'form') return null
  const requestedSchema = asRecord(params.requestedSchema)
  const properties = asRecord(requestedSchema.properties)
  const required = Array.isArray(requestedSchema.required)
    ? requestedSchema.required.filter((v): v is string => typeof v === 'string')
    : Object.keys(properties)
  const out: Record<string, unknown> = {}
  for (const key of required) {
    if (!(key in properties)) continue
    out[key] = buildMcpElicitationFieldValue(properties[key])
  }
  return out
}

/**
 * Classify a JSON-RPC line. Codex app-server uses bidirectional JSON-RPC 2.0:
 *   - Response: { id, result } or { id, error } — reply to one of our requests.
 *   - Server request: { id, method, params } — server expects a response.
 *   - Notification: { method, params } — fire-and-forget event.
 * Anything else (including non-JSON) is `unknown` and surfaced via parse_error.
 */
export function _classifyJsonRpcLine(line: string): JsonRpcLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'unknown' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'unknown' }
  const m = parsed as Record<string, unknown>
  if (typeof m.method === 'string') {
    if ('id' in m && (typeof m.id === 'number' || typeof m.id === 'string')) {
      return {
        kind: 'server-request',
        id: m.id as number | string,
        method: m.method,
        params: m.params,
      }
    }
    return { kind: 'notification', method: m.method, params: m.params }
  }
  if (
    'id' in m &&
    (typeof m.id === 'number' || typeof m.id === 'string') &&
    ('result' in m || 'error' in m)
  ) {
    return {
      kind: 'response',
      id: m.id as number | string,
      result: m.result,
      error: m.error as { code: number; message: string } | undefined,
    }
  }
  return { kind: 'unknown' }
}

export class CodexAppServerRunner extends EventEmitter {
  private threadId: string | null
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 0
  private pending = new Map<number, PendingRequest>()
  private queue: QueuedTurn[] = []
  private processing = false
  private shuttingDown = false
  private spawnEmitted = false
  private initialized = false
  /** True iff the *current* app-server proc has done thread/start or
   *  thread/resume for this.threadId. Cleared when the proc dies. Distinct
   *  from `initialized` (which tracks the JSON-RPC handshake) — re-spawning
   *  the proc requires re-attaching even when threadId is known. */
  private attached = false
  private activeTurnId: string | null = null
  /** Promise wired into `turn/completed` notification handling. Set by runTurn
   *  before sending `turn/start`, resolved by handleNotification on
   *  `turn/completed` for the matching turnId. */
  private currentTurnCompleter: {
    resolve: (turn: { status?: string; durationMs?: number; error?: { message?: string } }) => void
    reject: (err: Error) => void
  } | null = null
  private stdoutBuf = ''
  /** Accumulated assistant text for the current turn — used to dedupe
   *  imageGeneration savedPath emissions against text the model already
   *  surfaced via deltas. */
  private currentAssistantBuf = ''
  private currentPlanDrafts = new Map<string, string>()
  private activePlanBlockId: string | null = null
  private reasoningItemsWithDeltas = new Set<string>()
  private collabReceiverToSpawnId = new Map<string, string>()
  private collabSpawnReceivers = new Map<string, Set<string>>()
  private completedCollabSpawnResults = new Set<string>()
  private conversationMode: 'default' | 'plan' = 'default'
  /** Serializes cold thread attach for both turns and out-of-band controls
   *  (goals). Without this, a first user turn and a simultaneous goal action
   *  could both issue thread/start or thread/resume against the same proc. */
  private attachPromise: Promise<void> | null = null
  /** In-flight `handleItemCompleted` promises for the current turn. codex
   *  emits `item/completed` then `turn/completed` back-to-back; the
   *  per-item handler is async (file IO for imageGeneration base64 decode,
   *  copyImagePathsToPublicDir for savedPath, etc.) so without tracking,
   *  `runTurn` would snapshot `currentAssistantBuf` and emit `result`
   *  before the handler appends the text_delta / fires emitToolResult.
   *  Drained in `runTurn` (both happy and catch paths) before emitResult. */
  private inflightItemHandlers: Set<Promise<void>> = new Set()

  /** mkdtempSync'd dir holding the per-spawn `extra-prompt.md`. Created lazily
   *  in `ensureSpawned()` whenever a fresh app-server process needs platform
   *  context, cleaned on `shutdown()` and on proc close. Null when overrides
   *  have never been built (no config) or were just cleaned. */
  private sessionDir: string | null = null
  /** Cached overrides for the lifetime of the current proc. Cleared together
   *  with `sessionDir` so the next post-shutdown spawn lazy-rebuilds. */
  private cachedOverrides: CodexLaunchOverrides | null = null

  // ── SubprocessRunner interface parity (referenced by sessionManager.ts) ──
  public lastActivityAt: number = Date.now()
  public effortLevel: string | undefined = undefined

  get isRunning(): boolean {
    return this.proc != null || this.processing
  }

  updateConfig(config: OpenClaudeConfig): void {
    // codex itself doesn't read gateway config, but the platform-context
    // injection path does. Accept the new config and invalidate the cached
    // overrides so the NEXT spawn (after a shutdown/respawn cycle) rebuilds
    // with the new values. Same caveat as CodexRunner.updateConfig: a
    // currently-running mcp-memory child has the old token baked in; full
    // propagation requires the codex proc to respawn.
    this.opts = { ...this.opts, config }
    this.cachedOverrides = null
  }

  setEffortLevel(level: string | undefined): void {
    // codex CLI manages its own effort flag; we don't pass it to thread/start.
    // We DO record it on the runner so a subsequent ensureLaunchOverrides()
    // (after shutdown clears the cache) reflects the new value when
    // buildPromptContext renders the RESEARCH slot.
    this.effortLevel = level
  }

  setConversationMode(mode: 'default' | 'plan' | undefined): void {
    this.conversationMode = mode === 'plan' ? 'plan' : 'default'
  }

  sendPermissionResponse(_requestId: string, _response: unknown): boolean {
    // Same rationale as CodexRunner: app-server is launched with
    // approvalPolicy=never + sandbox=danger-full-access, so it never asks for
    // approval. If future codex versions emit a request anyway, the
    // server-request branch in handleLine answers method-not-found.
    return false
  }

  interrupt(): boolean {
    if (!this.proc || this.proc.killed) return false
    if (!this.threadId || !this.activeTurnId) return false
    void this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    }).catch((err) => {
      // Common case: the turn already completed between us deciding to
      // interrupt and the request landing. Codex returns -32602/etc — we
      // log at warn and move on; runTurn will settle via turn/completed
      // (status=completed) anyway.
      log.warn('turn/interrupt failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
    })
    return true
  }

  constructor(private opts: CodexAppServerRunnerOpts) {
    super()
    this.threadId = opts.resumeSessionId ?? null
    this.effortLevel = opts.effortLevel
    this.setConversationMode(opts.conversationMode)
    // attached is intentionally false on construction even if we have a
    // resumed threadId — the first turn must explicitly thread/resume into
    // the freshly spawned proc.
  }

  private emitSpawnOnce(): void {
    if (this.spawnEmitted) return
    this.spawnEmitted = true
    this.emit('spawn', { resumed: this.threadId != null })
  }

  /** Lazy-build codex launch overrides for the next `app-server` spawn. The
   *  overrides outlive a single turn (the proc is long-lived), so the cache
   *  is only invalidated in `shutdown()` / proc close / `updateConfig()`.
   *  Returns null when `opts.config` is missing (legacy "naked codex" path
   *  used by tests).
   *
   *  Failure rollback: same shape as CodexRunner — on any error, rmSync the
   *  partially-prepared dir before rethrowing so we never leak a tmp dir
   *  whose path is no longer remembered. */
  private async ensureLaunchOverrides(): Promise<CodexLaunchOverrides | null> {
    if (!this.opts.config) return null
    if (this.cachedOverrides && this.sessionDir) return this.cachedOverrides
    // Cache miss with an existing sessionDir means updateConfig invalidated
    // cachedOverrides while the dir was still bound. ensureLaunchOverrides is
    // only called from ensureSpawned (proc===null guard), so by the time we
    // reach this point the previous proc has exited and no live mcp-memory
    // child references the old extra-prompt.md. Clean it before mkdtemp v2
    // so config swaps don't accumulate orphaned tmp dirs.
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex app-server stale sessionDir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    const dir = mkdtempSync(join(tmpdir(), 'oc-codex-app-'))
    try {
      const overrides = await buildCodexLaunchOverrides({
        agentId: this.opts.agentId,
        persona: this.opts.persona,
        provider: this.opts.agentProvider,
        model: this.opts.model,
        effortLevel: this.effortLevel,
        sessionDir: dir,
        cwd: this.opts.cwd,
        claudeCodePath: this.opts.config.auth.claudeCodePath,
        gatewayPort: this.opts.config.gateway.port,
        gatewayToken: this.opts.config.gateway.accessToken,
        delegationDepth: this.opts.delegationDepth,
      })
      writeFileSync(overrides.instructionsFile, overrides.instructionsContent, 'utf8')
      this.sessionDir = dir
      this.cachedOverrides = overrides
      return overrides
    } catch (err) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
      throw err
    }
  }

  /** Cleanup helper shared by `shutdown()` and the proc close handler so
   *  override teardown happens regardless of which path tears the proc down
   *  first. Idempotent. */
  private cleanupLaunchOverrides(): void {
    if (this.sessionDir) {
      try {
        rmSync(this.sessionDir, { recursive: true, force: true })
      } catch (err) {
        log.warn('codex app-server session dir cleanup failed', {
          sessionDir: this.sessionDir,
          err: (err as Error).message,
        })
      }
      this.sessionDir = null
    }
    this.cachedOverrides = null
  }

  async start(): Promise<void> {
    // Subprocess is lazily spawned on first turn (matches CodexRunner
    // semantics — sessionManager polls isRunning and wires up runner.on()
    // listeners between start and submit, so emitting spawn synchronously is
    // expected). The actual `codex app-server` proc starts on first runTurn.
    this.emitSpawnOnce()
  }

  async warmup(timeoutMs = 15_000): Promise<boolean> {
    if (this.processing || this.shuttingDown) return false
    if (this.proc && !this.proc.killed && this.initialized) return true
    this.lastActivityAt = Date.now()
    this.emitSpawnOnce()

    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const warm = this.ensureSpawned()
      .then(() => true)
      .catch((err) => {
        if (!timedOut) {
          log.warn('codex app-server warmup failed', {
            sessionKey: this.opts.sessionKey,
            err: (err as Error).message,
          })
        }
        return false
      })
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(1, timeoutMs))
    })
    const result = await Promise.race([warm, timeout])
    if (timer) clearTimeout(timer)
    if (result === 'timeout') {
      timedOut = true
      log.warn('codex app-server warmup timed out', {
        sessionKey: this.opts.sessionKey,
        timeoutMs,
      })
      // `ensureSpawned()` may be stuck awaiting the initialize response.
      // Shutdown rejects pending JSON-RPC requests and kills the partial proc
      // so the next real submit can cold-start instead of waiting forever
      // behind a poisoned warmup.
      warm.catch(() => {})
      await this.shutdown().catch((err) =>
        log.warn('codex app-server warmup timeout cleanup failed', {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        }),
      )
      return false
    }
    return result
  }

  async submit(textOrBlocks: string | Array<{ type: string; text?: string }>): Promise<void> {
    this.lastActivityAt = Date.now()
    this.emitSpawnOnce()
    const prompt = normalisePrompt(textOrBlocks)
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, resolve, reject })
      void this.drain()
    })
  }

  async shutdown(): Promise<void> {
    // Same transient-shutdown semantics as CodexRunner: kill the current
    // proc, drain queue, but allow subsequent submit() to respawn. effort
    // switching and auth-token refresh paths rely on this.
    this.shuttingDown = true
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      const p = this.proc
      setTimeout(() => {
        if (p && !p.killed) {
          try {
            p.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 3000)
    }
    const pending = this.queue
    this.queue = []
    for (const q of pending) q.reject(new Error('CodexAppServerRunner shutdown'))
    // Reject any in-flight JSON-RPC requests so callers don't hang forever.
    for (const [, p] of this.pending) {
      p.reject(new Error('CodexAppServerRunner shutdown'))
    }
    this.pending.clear()
    // Reject the in-flight turn (if any) so runTurn's await-completer doesn't
    // wedge — the proc.close handler also does this, but shutdown can be
    // called before the close event fires (race).
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error('CodexAppServerRunner shutdown'))
      this.currentTurnCompleter = null
    }
    this.activeTurnId = null
    this.initialized = false
    this.attached = false
    this.proc = null
    this.stdoutBuf = ''
    // Tear down the per-spawn launch overrides so the next post-shutdown
    // submit() rebuilds against a fresh sessionDir. Re-using a stale
    // overrides reference after we rmSync the dir would point codex at a
    // deleted file on respawn.
    this.cleanupLaunchOverrides()
    this.emit('exit', { code: 0, signal: null, crashed: false })
    this.shuttingDown = false
  }

  // ─── internals ────────────────────────────────

  private async drain(): Promise<void> {
    if (this.processing || this.shuttingDown) return
    const turn = this.queue.shift()
    if (!turn) return
    this.processing = true
    try {
      await this.runTurn(turn.prompt)
      turn.resolve()
    } catch (err) {
      turn.reject(err as Error)
    } finally {
      this.processing = false
      void this.drain()
    }
  }

  private buildInitializeParams(): Record<string, unknown> {
    return {
      clientInfo: { name: 'openclaude-gateway', version: '1.0' },
      capabilities: {
        experimentalApi: true,
      },
    }
  }

  private async ensureSpawned(): Promise<void> {
    if (this.proc && !this.proc.killed && this.initialized) return
    if (this.proc && !this.proc.killed && !this.initialized) {
      // Spawn happened but initialize is in flight — caller will await.
      return
    }
    // Clear any partial-line residue from a prior proc (Codex review
    // #019dde20 BLOCKER round 3): stdoutBuf is runner-scoped, so without
    // this, a fragment like '{"jsonrpc":"2.0",' left by the old proc would
    // get prepended to the new proc's first stdout chunk and corrupt the
    // initialize response.
    this.stdoutBuf = ''
    // Build platform context overrides BEFORE spawn so the long-lived
    // app-server proc has model_instructions_file + mcp-memory available
    // from its very first turn. Failure here is non-fatal — fall back to
    // naked launch (same graceful-degradation stance as subprocessRunner's
    // "skip built-in MCP" branch), so the agent at least responds even if
    // platform context can't be assembled.
    let argvOverrides: string[] = []
    try {
      const overrides = await this.ensureLaunchOverrides()
      if (overrides) argvOverrides = overrides.argvOverrides
    } catch (err) {
      log.warn(
        'codex app-server launch overrides build failed; spawning without platform context',
        {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        },
      )
    }
    // `codex app-server` accepts `-c key=value` overrides (verified via
    // `codex app-server --help`). They must precede `--listen` to keep
    // clap's positional/option parser happy.
    const args = ['app-server', ...argvOverrides, '--listen', 'stdio://']
    const proc = _spawnFn('codex', args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCodexEnv({ proxyUrl: this.opts.proxyUrl }),
    }) as ChildProcessWithoutNullStreams
    this.proc = proc
    proc.stdout.on('data', (chunk: Buffer) => {
      // Identity guard (Codex review #019dde20 BLOCKER round 2): a stale
      // stdout frame from a discarded proc must NOT be parsed against the new
      // runner state. Without this, an old proc's queued `item/agentMessage/
      // delta` could land while a fresh `turn/start` is in flight and the
      // early-adopt path would attribute the old turn's text to the new turn.
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now()
      this.stdoutBuf += chunk.toString('utf8')
      let nl = this.stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = this.stdoutBuf.slice(0, nl).trim()
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
        if (line) this.handleLine(line)
        nl = this.stdoutBuf.indexOf('\n')
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      // Same identity guard rationale as stdout — stderr is just structured
      // log, but mis-attributing an old proc's stderr to the current session
      // is misleading in the journal.
      if (this.proc !== proc) return
      this.lastActivityAt = Date.now()
      // Codex app-server logs structured errors to stderr; surface them at
      // warn level so the journal has them but they don't fail the turn —
      // the JSON-RPC error response is the source of truth for failures.
      log.warn('codex app-server stderr', {
        sessionKey: this.opts.sessionKey,
        line: chunk.toString('utf8').trim().slice(0, 1024),
      })
    })
    proc.on('error', (err) => {
      // Identity check: a delayed error from a discarded proc must not corrupt
      // a freshly spawned one. shutdown() (or a previous close) may have already
      // re-pointed `this.proc` at a new child by the time this fires.
      if (this.proc !== proc) {
        log.info('codex app-server stale proc error ignored', {
          sessionKey: this.opts.sessionKey,
          err: err.message,
        })
        return
      }
      log.error('codex app-server proc error', { err: err.message })
      this.emit('error', err)
      this.failAllPending(`codex app-server process error: ${err.message}`)
      this.proc = null
      this.initialized = false
      this.attached = false
      // stdoutBuf cleared so any partial-line residue doesn't poison the
      // next proc's first response (see ensureSpawned for fuller comment).
      this.stdoutBuf = ''
    })
    proc.on('close', (code, signal) => {
      // Identity check: see the `error` handler comment. Without this, the
      // sequence shutdown → submit → respawn → old-proc-close-fires would
      // null out the new proc and reject its pending requests.
      if (this.proc !== proc) {
        log.info('codex app-server stale proc close ignored', {
          sessionKey: this.opts.sessionKey,
          code,
          signal,
        })
        return
      }
      log.info('codex app-server proc close', {
        sessionKey: this.opts.sessionKey,
        code,
        signal,
      })
      const wasShutdown = this.shuttingDown
      // Reject any remaining pending JSON-RPC requests AND the in-flight turn
      // promise so callers don't hang. emitResult is the responsibility of
      // runTurn's catch — we just unwedge promises here.
      if (!wasShutdown) {
        this.failAllPending(`codex app-server exited code=${code} signal=${signal ?? ''}`)
      }
      this.proc = null
      this.initialized = false
      this.attached = false
      this.activeTurnId = null
      // Clear stdoutBuf so the next proc's first response isn't prepended
      // with a partial line residue from this dying proc.
      this.stdoutBuf = ''
      // Drop the launch overrides cache too — the dir contents are tied to
      // the dead proc, and the next ensureSpawned() will lazy-rebuild a
      // fresh dir + instructions file. Not strictly required (shutdown
      // already covers the explicit-stop path) but matches the symmetry
      // "proc gone → context regenerated" so a crash-respawn can't reuse a
      // stale path that was rmSync'd by a concurrent shutdown.
      this.cleanupLaunchOverrides()
      this.emit('exit', {
        code: code ?? 0,
        signal,
        crashed: code != null && code !== 0 && !wasShutdown,
      })
    })

    // JSON-RPC handshake. `collaborationMode` and related plan-first fields are
    // gated behind Codex's experimental API capability, so declare it before any
    // turn/start call. We call the proc fresh-spawned so writes won't EPIPE.
    await this.sendRequest('initialize', this.buildInitializeParams())
    this.initialized = true
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(reason))
    }
    this.pending.clear()
    if (this.currentTurnCompleter) {
      this.currentTurnCompleter.reject(new Error(reason))
      this.currentTurnCompleter = null
    }
  }

  private writeRaw(line: string): void {
    if (!this.proc || this.proc.killed) return
    try {
      this.proc.stdin.write(`${line}\n`)
    } catch (err) {
      // EPIPE if proc died between our check and write — fail pending so
      // callers settle.
      log.warn('codex app-server stdin write failed', {
        err: (err as Error).message,
      })
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private buildServerRequestAutoApproval(method: string, params: unknown): unknown | null {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return { decision: 'acceptForSession' }
      case 'item/fileChange/requestApproval':
        return { decision: 'acceptForSession' }
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: 'approved_for_session' }
      case 'item/permissions/requestApproval': {
        const requested = asRecord(asRecord(params).permissions)
        const permissions: Record<string, unknown> = {}
        if (requested.network !== undefined && requested.network !== null) {
          permissions.network = requested.network
        }
        if (requested.fileSystem !== undefined && requested.fileSystem !== null) {
          permissions.fileSystem = requested.fileSystem
        }
        return { permissions, scope: 'session', strictAutoReview: false }
      }
      case 'mcpServer/elicitation/request':
        return {
          action: 'accept',
          content: buildMcpElicitationContent(params),
          _meta: null,
        }
      default:
        return null
    }
  }

  private handleLine(line: string): void {
    const msg = _classifyJsonRpcLine(line)
    if (msg.kind === 'unknown') {
      this.emit('parse_error', { line, error: 'unknown JSON-RPC shape' })
      return
    }
    if (msg.kind === 'response') {
      const numId = typeof msg.id === 'number' ? msg.id : Number(msg.id)
      const p = this.pending.get(numId)
      if (!p) {
        log.warn('orphan JSON-RPC response', {
          sessionKey: this.opts.sessionKey,
          id: msg.id,
        })
        return
      }
      this.pending.delete(numId)
      if (msg.error) {
        // Structured reject: keep the human message for log/UI use, but also
        // attach `rpcCode` / `rpcMessage` / `rpcMethod` so callers can branch
        // on protocol-level fields without re-parsing the message string. The
        // self-heal in runTurn (attach → thread/resume → -32600 "no rollout
        // found") relies on these fields to avoid swallowing unrelated
        // -32600 Invalid Request errors (e.g. schema/protocol drift) as a
        // missing-rollout case (Codex review #019e0b72 BLOCKER 1).
        const err = new Error(
          `${p.method} -> ${msg.error.code}: ${msg.error.message}`,
        ) as JsonRpcCallError
        err.rpcCode = msg.error.code
        err.rpcMessage = msg.error.message
        err.rpcMethod = p.method
        p.reject(err)
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (msg.kind === 'server-request') {
      const autoApproval = this.buildServerRequestAutoApproval(msg.method, msg.params)
      if (autoApproval !== null) {
        log.info('codex app-server server request auto-approved', {
          sessionKey: this.opts.sessionKey,
          method: msg.method,
        })
        this.writeRaw(jsonRpcResult(msg.id, autoApproval))
      } else {
        // Keep unknown server-initiated methods fail-fast so a future Codex
        // protocol addition doesn't hang this runner silently.
        this.writeRaw(jsonRpcMethodNotFound(msg.id, msg.method))
      }
      return
    }
    if (msg.kind === 'notification') {
      this.handleNotification(msg.method, msg.params)
      return
    }
  }

  private codexReasoningEffort(): 'low' | 'medium' | 'high' | 'xhigh' | null {
    switch (this.effortLevel) {
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
        return this.effortLevel
      default:
        return null
    }
  }

  private buildTurnStartParams(prompt: string): Record<string, unknown> {
    const mode = this.conversationMode
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      collaborationMode: {
        mode,
        settings: {
          model: this.opts.model ?? '',
          reasoning_effort: this.codexReasoningEffort(),
          developer_instructions: mode === 'default' ? CODEX_DEFAULT_MODE_INSTRUCTIONS : null,
        },
      },
      sandboxPolicy:
        mode === 'plan' ? { type: 'readOnly', networkAccess: true } : { type: 'dangerFullAccess' },
    }
    if (this.opts.model) params.model = this.opts.model
    return params
  }

  private emitThinkingDelta(text: string, itemId?: string): void {
    if (!text) return
    if (itemId) this.reasoningItemsWithDeltas.add(itemId)
    this.emit('message', {
      type: 'stream_event',
      session_id: this.threadId,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: text },
      },
    } as unknown as RunnerMessage)
  }

  private emitPlanBlock(plan: {
    blockId?: string
    text?: string
    explanation?: string
    steps?: CodexPlanStep[]
    partial?: boolean
  }): void {
    const { blockId, ...payload } = plan
    this.emit('message', {
      type: 'openclaude_plan',
      session_id: this.threadId,
      plan: {
        blockId: blockId || 'codex-plan',
        ...payload,
      },
    } as unknown as RunnerMessage)
  }

  private emitGoalBlock(goal: CodexGoalBlock): void {
    this.emit('message', {
      type: 'openclaude_goal',
      session_id: this.threadId,
      goal,
    } as unknown as RunnerMessage)
  }

  private handleNotification(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return
    const p = params as Record<string, unknown>
    const turnId = typeof p.turnId === 'string' ? p.turnId : undefined

    // Filter turn-scoped notifications. codex may emit notifications for
    // system-internal turns (compaction, hooks) that the client should ignore.
    //
    // Subtle ordering issue (Codex review #019dde20 MAJOR 3): turn/start is a
    // request whose Promise resolution is a microtask, but stdout `data`
    // events deliver subsequent notifications synchronously inside the same
    // chunk. So a notification carrying the turnId can arrive (and run
    // through handleNotification) BEFORE runTurn assigns activeTurnId from
    // the resolved request. To avoid dropping early tokens/items, when a turn
    // is in flight (`currentTurnCompleter` set) and `activeTurnId` is still
    // null, we adopt the first turnId we see.
    if (turnId) {
      if (this.activeTurnId === null) {
        if (this.currentTurnCompleter) {
          this.activeTurnId = turnId
        } else {
          // No turn in flight → server-internal turn we don't track. Drop.
          return
        }
      } else if (turnId !== this.activeTurnId) {
        return
      }
    }

    if (method === 'thread/goal/updated') {
      this.emitGoalBlock(normalizeCodexGoal(p.goal))
      return
    }
    if (method === 'thread/goal/cleared') {
      this.emitGoalBlock(normalizeCodexGoal(undefined, true))
      return
    }
    if (method === 'item/agentMessage/delta') {
      const delta = typeof p.delta === 'string' ? p.delta : ''
      if (!delta) return
      this.currentAssistantBuf += delta
      this.emit('message', {
        type: 'stream_event',
        session_id: this.threadId,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: delta },
        },
      } as unknown as RunnerMessage)
      return
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const delta = typeof p.delta === 'string' ? p.delta : ''
      const itemId = typeof p.itemId === 'string' ? p.itemId : undefined
      this.emitThinkingDelta(delta, itemId)
      return
    }
    if (method === 'item/plan/delta') {
      const delta = typeof p.delta === 'string' ? p.delta : ''
      if (!delta) return
      const blockId = codexPlanBlockId(p.itemId, this.activePlanBlockId || 'codex-plan')
      this.activePlanBlockId = blockId
      const draft = (this.currentPlanDrafts.get(blockId) || '') + delta
      this.currentPlanDrafts.set(blockId, draft)
      this.emitPlanBlock({ blockId, text: draft, partial: true })
      return
    }
    if (method === 'turn/plan/updated') {
      const blockId = codexPlanBlockId(p.itemId, this.activePlanBlockId || 'codex-plan')
      this.activePlanBlockId = blockId
      const explanation = typeof p.explanation === 'string' ? p.explanation : undefined
      const steps = normalizeCodexPlanSteps(p.plan)
      this.emitPlanBlock({ blockId, explanation, steps, partial: true })
      return
    }
    if (method === 'item/started') {
      this.handleItemStarted(p.item)
      return
    }
    if (method === 'item/completed') {
      // Track the async handler so `runTurn` can drain pending file IO /
      // emits before snapshotting `currentAssistantBuf` and emitting result.
      // codex sends item/completed before turn/completed; without this,
      // imageGeneration's base64 writeFile (or any other async item path)
      // can race past the result frame, leaving the UI with empty output.
      const itemUnk = p.item
      const itemId =
        itemUnk && typeof itemUnk === 'object'
          ? typeof (itemUnk as Record<string, unknown>).id === 'string'
            ? ((itemUnk as Record<string, unknown>).id as string)
            : '<no-id>'
          : '<no-id>'
      const itemType =
        itemUnk && typeof itemUnk === 'object'
          ? typeof (itemUnk as Record<string, unknown>).type === 'string'
            ? ((itemUnk as Record<string, unknown>).type as string)
            : '<no-type>'
          : '<no-type>'
      const p$ = this.handleItemCompleted(itemUnk)
        .catch((e) => {
          log.warn('codex item handler failed', {
            sessionKey: this.opts.sessionKey,
            itemId,
            itemType,
            err: (e as Error).message,
          })
        })
        .finally(() => {
          this.inflightItemHandlers.delete(p$)
        })
      this.inflightItemHandlers.add(p$)
      return
    }
    if (method === 'turn/completed') {
      // Per schema: { threadId, turn: { id, status, durationMs, error? } }
      const turn = p.turn as Record<string, unknown> | undefined
      if (!turn) return
      // Defensive: even though we already filtered turnId above (via top-level
      // p.turnId), turn.id is the authoritative id on this notification —
      // re-check.
      const tid = typeof turn.id === 'string' ? turn.id : undefined
      if (tid && this.activeTurnId && tid !== this.activeTurnId) return
      if (this.currentTurnCompleter) {
        this.currentTurnCompleter.resolve(
          turn as Parameters<typeof this.currentTurnCompleter.resolve>[0],
        )
        this.currentTurnCompleter = null
      }
      return
    }
    // Other notifications (turn/started, config-warning, etc.)
    // are dropped — they are observability/UI hints that don't gate the
    // turn lifecycle.
  }

  private rememberCollabSpawnReceivers(spawnId: string, receiverThreadIds: string[]): void {
    if (receiverThreadIds.length === 0) return
    let receivers = this.collabSpawnReceivers.get(spawnId)
    if (!receivers) {
      receivers = new Set<string>()
      this.collabSpawnReceivers.set(spawnId, receivers)
    }
    for (const receiverId of receiverThreadIds) {
      receivers.add(receiverId)
      this.collabReceiverToSpawnId.set(receiverId, spawnId)
    }
  }

  private handleCollabAgentToolStarted(itemId: string, item: Record<string, unknown>): void {
    const tool = collabTool(item)
    if (tool === 'spawnAgent') {
      const receivers = collabReceiverThreadIds(item)
      this.rememberCollabSpawnReceivers(itemId, receivers)
      const prompt = collabPrompt(item)
      this.emitAssistantToolUse(
        itemId,
        'Agent',
        collabAgentInput(item, prompt || '启动 Codex 子 Agent'),
      )
      return
    }

    this.emitAssistantToolUse(
      itemId,
      'Codex:multiAgent',
      collabAgentInput(item, `Codex multi-agent: ${tool}`),
    )
  }

  private maybeEmitCompletedCollabAgentGroups(item: Record<string, unknown>): void {
    const states = collabAgentsStates(item)
    if (Object.keys(states).length === 0) return

    const touchedReceivers = new Set([...collabReceiverThreadIds(item), ...Object.keys(states)])
    const touchedSpawnIds = new Set<string>()
    for (const receiverId of touchedReceivers) {
      const spawnId = this.collabReceiverToSpawnId.get(receiverId)
      if (spawnId) touchedSpawnIds.add(spawnId)
    }

    for (const spawnId of touchedSpawnIds) {
      if (this.completedCollabSpawnResults.has(spawnId)) continue
      const receivers = this.collabSpawnReceivers.get(spawnId)
      if (!receivers || receivers.size === 0) continue
      const receiverList = [...receivers]
      const allTerminal = receiverList.every((receiverId) =>
        isTerminalCollabAgentStatus(states[receiverId]?.status || ''),
      )
      if (!allTerminal) continue

      const isError = receiverList.some((receiverId) =>
        isErrorCollabAgentStatus(states[receiverId]?.status || ''),
      )
      const lines = receiverList.map((receiverId) => {
        const state = states[receiverId]
        const msg = state?.message ? ` — ${state.message}` : ''
        return `${shortThreadId(receiverId)}: ${state?.status || 'unknown'}${msg}`
      })
      this.completedCollabSpawnResults.add(spawnId)
      this.emitToolResult(spawnId, lines.join('\n') || 'Codex child agent completed', isError)
    }
  }

  private handleCollabAgentToolCompleted(itemId: string, item: Record<string, unknown>): void {
    const tool = collabTool(item)
    const status = collabStatus(item)

    if (tool === 'spawnAgent') {
      this.rememberCollabSpawnReceivers(itemId, collabReceiverThreadIds(item))
      if (status === 'failed') {
        this.completedCollabSpawnResults.add(itemId)
        this.emitToolResult(itemId, summarizeCollabControl(item), true)
      } else {
        this.maybeEmitCompletedCollabAgentGroups(item)
      }
      return
    }

    this.emitToolResult(itemId, summarizeCollabControl(item), status === 'failed')
    this.maybeEmitCompletedCollabAgentGroups(item)
  }

  private handleItemStarted(itemUnk: unknown): void {
    if (!itemUnk || typeof itemUnk !== 'object') return
    const item = itemUnk as Record<string, unknown>
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type
    if (itemType === 'commandExecution') {
      const cmd = typeof item.command === 'string' ? item.command : ''
      this.emitAssistantToolUse(itemId, 'Bash', {
        command: stripShellWrapper(cmd),
        description: 'codex commandExecution',
      })
      return
    }
    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
      const first = (changes[0] ?? {}) as Record<string, unknown>
      const kind = (first.kind as { type?: string } | undefined)?.type
      const name = kind === 'add' ? 'Write' : 'Edit'
      this.emitAssistantToolUse(itemId, name, {
        file_path: typeof first.path === 'string' ? first.path : '',
        kind,
        changes,
      })
      return
    }
    if (itemType === 'collabAgentToolCall') {
      this.handleCollabAgentToolStarted(itemId, item)
      return
    }
    if (itemType === 'plan') {
      this.activePlanBlockId = itemId
      if (!this.currentPlanDrafts.has(itemId)) this.currentPlanDrafts.set(itemId, '')
      return
    }
    // agentMessage / reasoning are streamed via deltas; nothing to surface
    // here. Other types (mcpToolCall, webSearch, imageGeneration, ...)
    // surface as generic tool_use so the user sees something happened —
    // keeps parity with CodexRunner.
    if (
      itemType &&
      itemType !== 'agentMessage' &&
      itemType !== 'reasoning' &&
      typeof itemType === 'string'
    ) {
      this.emitAssistantToolUse(itemId, `Codex:${itemType}`, item)
    }
  }

  private async handleItemCompleted(itemUnk: unknown): Promise<void> {
    if (!itemUnk || typeof itemUnk !== 'object') return
    const item = itemUnk as Record<string, unknown>
    const itemId = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`
    const itemType = item.type
    if (itemType === 'commandExecution') {
      const out = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
      const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined
      this.emitToolResult(itemId, out, exit != null && exit !== 0)
      return
    }
    if (itemType === 'fileChange') {
      const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : []
      const summary = changes
        .map((c) => {
          const o = c as Record<string, unknown>
          const k = (o.kind as { type?: string } | undefined)?.type
          return `${k ?? 'change'}: ${o.path ?? ''}`
        })
        .join('\n')
      this.emitToolResult(itemId, summary || 'file changes applied', false)
      return
    }
    if (itemType === 'plan') {
      const blockId = codexPlanBlockId(item.id, this.activePlanBlockId || 'codex-plan')
      const text = typeof item.text === 'string' ? item.text : ''
      const explanation = typeof item.explanation === 'string' ? item.explanation : undefined
      const steps = normalizeCodexPlanSteps(Array.isArray(item.steps) ? item.steps : item.plan)
      const hadPriorPlan = this.activePlanBlockId === blockId || this.currentPlanDrafts.has(blockId)
      if (text || explanation || steps.length > 0 || hadPriorPlan) {
        this.activePlanBlockId = blockId
        this.emitPlanBlock({
          blockId,
          ...(text ? { text } : {}),
          ...(explanation ? { explanation } : {}),
          ...(steps.length > 0 ? { steps } : {}),
          partial: false,
        })
      }
      return
    }
    if (itemType === 'collabAgentToolCall') {
      this.handleCollabAgentToolCompleted(itemId, item)
      return
    }
    if (itemType === 'imageGeneration') {
      // codex's image_gen tool emits two notification shapes depending on the
      // upstream auth mode (verified 2026-05-03 via JSON-RPC spike vs codex
      // 0.125.0):
      //   - auth_mode=chatgpt (full OAuth + refresh_token): item carries BOTH
      //     `savedPath` (absolute path under <CODEX_HOME>/generated_images/...)
      //     AND `result` (base64 PNG bytes).
      //   - auth_mode=chatgptAuthTokens (commercial pool, token-only): item
      //     carries `result` only — `savedPath` is absent. Codex still writes
      //     the PNG to the same on-disk location, but the path is not surfaced
      //     in the protocol frame.
      // Without the base64 fallback, commercial-pool users see imageGeneration
      // stuck at the started event's `status: in_progress`, no image rendered.
      const saved = typeof item.savedPath === 'string' ? item.savedPath : ''
      const resultB64 = typeof item.result === 'string' ? item.result : ''
      if (!this.threadId || (!saved && !resultB64)) {
        this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
        return
      }
      let publicPaths: string[] = []
      let failedNames: string[] = []
      try {
        if (saved) {
          const { copied, failedNames: f } = await copyImagePathsToPublicDir(
            this.threadId,
            [saved],
            paths.generatedDir,
          )
          publicPaths = copied.map((c) => c.publicPath)
          failedNames = f
        } else {
          // Decode base64 PNG bytes from item.result and write to public dir
          // directly. Mirrors copyImagePathsToPublicDir's naming pattern
          // (`codex-<sanitizedThreadId>-<basename>`) so the file appears in the
          // same place as the savedPath path.
          const safeThread = _sanitizeThreadId(this.threadId)
          // Sanitize itemId before using as filename — it arrives over the wire
          // and must not introduce path separators or shell metacharacters even
          // though codex's observed form is `ig_<hex>`.
          const safeItemId = itemId.replace(/[^A-Za-z0-9._-]/g, '')
          const baseName = `${safeItemId || `image-${Date.now()}`}.png`
          const dst = join(paths.generatedDir, `codex-${safeThread}-${baseName}`)
          try {
            await mkdir(paths.generatedDir, { recursive: true })
            await writeFile(dst, Buffer.from(resultB64, 'base64'))
            publicPaths = [dst]
          } catch (err) {
            log.warn('codex image base64 write failed', {
              sessionKey: this.opts.sessionKey,
              dst,
              err: (err as Error).message,
            })
            failedNames = [baseName]
          }
        }
        const newEmits = publicPaths.filter((p) => !this.currentAssistantBuf.includes(p))
        if (newEmits.length > 0) {
          // Surrounding blank lines so frontend's "absolute path on its own
          // line → render attachment" recognizer matches each path.
          const text = `\n\n${newEmits.join('\n')}\n`
          this.currentAssistantBuf += text
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            },
          } as unknown as RunnerMessage)
        }
        if (failedNames.length > 0) {
          const note = `\n\n[image copy failed: ${failedNames.join(', ')}]\n`
          this.currentAssistantBuf += note
          this.emit('message', {
            type: 'stream_event',
            session_id: this.threadId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: note },
            },
          } as unknown as RunnerMessage)
        }
      } catch (err) {
        log.warn('codex app-server image copy failed', {
          sessionKey: this.opts.sessionKey,
          err: (err as Error).message,
        })
      }
      // Also emit the original tool_result for the imageGeneration card so
      // the UI's tool-call panel reflects the call. Prefer the codex on-disk
      // path when available, otherwise the public path we just wrote.
      const summary = saved || publicPaths[0] || '<base64>'
      this.emitToolResult(itemId, `imageGeneration → ${summary}`, false)
      return
    }
    if (itemType === 'agentMessage') {
      // Already streamed via deltas; no separate tool_result needed.
      return
    }
    if (itemType === 'reasoning') {
      // Prefer live reasoning deltas. If this Codex build only provides a
      // completed reasoning item, surface its text/summary once as a thinking
      // block so the frontend still shows the plan-first thought process.
      if (!this.reasoningItemsWithDeltas.has(itemId)) {
        const parts: string[] = []
        if (typeof item.text === 'string') parts.push(item.text)
        if (Array.isArray(item.summary)) {
          for (const s of item.summary) if (typeof s === 'string') parts.push(s)
        }
        if (Array.isArray(item.content)) {
          for (const c of item.content) if (typeof c === 'string') parts.push(c)
        }
        this.emitThinkingDelta(parts.filter(Boolean).join('\n'), itemId)
      }
      return
    }
    // Generic completion for unknown item types
    this.emitToolResult(itemId, JSON.stringify(item).slice(0, 2000), false)
  }

  /** Spawn a brand-new codex thread and wire its id into runner state +
   *  resume-map. Used both for the "first ever turn" path and the "old
   *  thread_id has no rollout, transparently restart" self-heal. Caller is
   *  responsible for setting `this.attached = true` after this resolves —
   *  attach state is per-proc, not per-thread. */
  private async _startNewThread(): Promise<void> {
    const res = (await this.sendRequest('thread/start', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      cwd: this.opts.cwd,
      ...(this.opts.model ? { model: this.opts.model } : {}),
    })) as { thread?: { id?: string } } | undefined
    const tid = res?.thread?.id
    if (typeof tid !== 'string' || !tid) {
      throw new Error('thread/start did not return thread.id')
    }
    this.threadId = tid
    // sessionManager listens for this and writes the new id (+ provider tag)
    // to resume-map.json, so the *next* turn against this sessionKey resumes
    // against the fresh thread instead of looping back into -32600.
    this.emit('session_id', tid)
  }

  private async attachThreadOnce(): Promise<void> {
    if (this.attached) return
    if (!this.threadId) {
      await this._startNewThread()
    } else {
      try {
        await this.sendRequest('thread/resume', {
          threadId: this.threadId,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          cwd: this.opts.cwd,
          ...(this.opts.model ? { model: this.opts.model } : {}),
        })
      } catch (err) {
        // Self-heal "no rollout found for thread id" (-32600). Caused by
        // master sessionManager persisting `thread_id` across container
        // rebuilds while the codex `~/.codex/sessions/...` rollout JSONL
        // lives only in the per-container ephemeral layer. Without this,
        // every fresh container's first GPT turn ended in a 31ms empty
        // result frame and the user saw "未收到回复" (Codex review
        // #019e0b72 BLOCKER 1, root cause confirmed by user).
        //
        // Trade-off: we lose conversation context for that one turn since
        // the rollout really is gone. emit('session_id') feeds the new
        // tid back into sessionManager → resume-map, so subsequent turns
        // recover normally. Any other thread/resume error (proc died,
        // schema drift, etc.) re-throws so the outer catch surfaces it
        // as ok=false rather than masking it with a fresh thread.
        if (!isMissingRolloutError(err)) throw err
        log.warn('codex thread/resume missing rollout — restarting fresh', {
          sessionKey: this.opts.sessionKey,
          staleThreadId: this.threadId,
          rpcMessage: (err as JsonRpcCallError).rpcMessage,
        })
        this.threadId = null
        await this._startNewThread()
      }
    }
    this.attached = true
  }

  /** Ensure the JSON-RPC proc is initialized and attached to a thread.
   *  Shared by ordinary turns and out-of-band goal controls. */
  private async ensureThreadAttached(): Promise<void> {
    if (this.attached) return
    if (!this.attachPromise) {
      this.attachPromise = (async () => {
        await this.ensureSpawned()
        await this.attachThreadOnce()
      })().finally(() => {
        this.attachPromise = null
      })
    }
    await this.attachPromise
  }

  async getGoal(): Promise<CodexGoalBlock | null> {
    await this.ensureThreadAttached()
    const res = (await this.sendRequest('thread/goal/get', {
      threadId: this.threadId,
    })) as { goal?: unknown } | undefined
    const rawGoal = res?.goal ?? null
    if (!rawGoal) {
      const cleared = normalizeCodexGoal(undefined, true)
      this.emitGoalBlock(cleared)
      return null
    }
    const goal = normalizeCodexGoal(rawGoal)
    this.emitGoalBlock(goal)
    return goal
  }

  async setGoal(input: {
    objective?: string | null
    status?: string | null
    tokenBudget?: number | null
  }): Promise<CodexGoalBlock> {
    await this.ensureThreadAttached()
    const params: Record<string, unknown> = { threadId: this.threadId }
    if (input.objective !== undefined) params.objective = input.objective
    if (input.status !== undefined) params.status = input.status
    if (input.tokenBudget !== undefined) params.tokenBudget = input.tokenBudget

    const res = (await this.sendRequest('thread/goal/set', params)) as
      | { goal?: unknown }
      | undefined
    const goal = normalizeCodexGoal(res?.goal)
    this.emitGoalBlock(goal)
    return goal
  }

  async clearGoal(): Promise<boolean> {
    await this.ensureThreadAttached()
    const res = (await this.sendRequest('thread/goal/clear', {
      threadId: this.threadId,
    })) as { cleared?: boolean } | undefined
    const cleared = res?.cleared !== false
    if (cleared) this.emitGoalBlock(normalizeCodexGoal(undefined, true))
    return cleared
  }

  private async runTurn(prompt: string): Promise<void> {
    const startedAt = Date.now()
    log.info('codex app-server turn start', {
      sessionKey: this.opts.sessionKey,
      resumed: this.threadId != null,
      promptChars: prompt.length,
    })
    this.currentAssistantBuf = ''
    this.currentPlanDrafts.clear()
    this.activePlanBlockId = null
    this.reasoningItemsWithDeltas.clear()

    try {
      await this.ensureThreadAttached()

      // Set up the completion box BEFORE turn/start so a fast turn/completed
      // notification (rare but possible) doesn't slip past us.
      const completed = new Promise<{
        status?: string
        durationMs?: number
        error?: { message?: string }
      }>((resolve, reject) => {
        this.currentTurnCompleter = { resolve, reject }
      })

      const tres = (await this.sendRequest('turn/start', this.buildTurnStartParams(prompt))) as
        | { turn?: { id?: string } }
        | undefined
      const turnId = tres?.turn?.id
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('turn/start did not return turn.id')
      }
      this.activeTurnId = turnId

      const turn = await completed
      // Drain any in-flight item/completed handlers (e.g. imageGeneration
      // base64 decode + writeFile) so emitResult below sees the final
      // currentAssistantBuf and any tool_results have been fired BEFORE
      // the result frame closes the turn.
      if (this.inflightItemHandlers.size > 0) {
        await Promise.allSettled([...this.inflightItemHandlers])
      }
      this.activeTurnId = null

      const durationMs = Date.now() - startedAt
      const status = turn?.status
      log.info('codex app-server turn end', {
        sessionKey: this.opts.sessionKey,
        status,
        durationMs,
        assistantChars: this.currentAssistantBuf.length,
      })

      if (status === 'completed') {
        this.emitResult({
          durationMs,
          ok: true,
          text: this.currentAssistantBuf,
        })
      } else if (status === 'failed') {
        const errMsg = turn?.error?.message ?? 'codex turn failed'
        // Surface error in the stream so the UI shows something — without
        // this, a failed turn after deltas would leave the user wondering.
        this.emit('message', {
          type: 'stream_event',
          session_id: this.threadId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `\n\n[turn failed: ${errMsg}]\n` },
          },
        } as unknown as RunnerMessage)
        this.emitResult({ durationMs, ok: false, error: errMsg })
      } else if (status === 'interrupted') {
        this.emitResult({ durationMs, ok: false, error: 'codex turn interrupted' })
      } else {
        this.emitResult({
          durationMs,
          ok: false,
          error: `codex turn unexpected status=${status ?? 'unknown'}`,
        })
      }
    } catch (err) {
      // Same drain as the happy path — if a handler is still running when
      // the turn errors out, let it finish before we clear state, otherwise
      // it can race onto the next turn's currentAssistantBuf and corrupt it.
      if (this.inflightItemHandlers.size > 0) {
        await Promise.allSettled([...this.inflightItemHandlers])
      }
      this.activeTurnId = null
      this.currentTurnCompleter = null
      const durationMs = Date.now() - startedAt
      log.error('codex app-server turn failed', {
        sessionKey: this.opts.sessionKey,
        err: (err as Error).message,
      })
      this.emitResult({
        durationMs,
        ok: false,
        error: `codex app-server: ${(err as Error).message}`,
      })
      // Do NOT re-throw — drain() catches and rejects the queue entry, but
      // upstream sessionManager handles errors via the result message above.
    }
  }

  private emitAssistantToolUse(id: string, name: string, input: unknown): void {
    this.emit('message', {
      type: 'assistant',
      session_id: this.threadId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    } satisfies RunnerMessage)
  }

  private emitToolResult(toolUseId: string, content: string, isError: boolean): void {
    this.emit('message', {
      type: 'user',
      session_id: this.threadId,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content,
            is_error: isError,
          },
        ],
      },
    } satisfies RunnerMessage)
  }

  private emitResult(opts: {
    durationMs: number
    ok: boolean
    text?: string
    error?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }): void {
    const msg: RunnerMessage = {
      type: 'result',
      subtype: opts.ok ? 'success' : 'error_during_execution',
      session_id: this.threadId,
      total_cost_usd: 0,
      duration_ms: opts.durationMs,
      is_error: !opts.ok,
      result: opts.ok ? (opts.text ?? '') : (opts.error ?? 'codex error'),
      usage: opts.usage,
    }
    this.emit('message', msg)
  }
}

function normalisePrompt(input: string | Array<{ type: string; text?: string }>): string {
  if (typeof input === 'string') return input
  const parts: string[] = []
  for (const b of input) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * Codex wraps every shell command in `/bin/bash -lc '...'`. Strip that wrapper
 * for a cleaner display — the ccb Bash tool card shows the raw user command.
 */
function stripShellWrapper(cmd: string): string {
  const m = cmd.match(/^\/bin\/bash\s+-lc\s+'([\s\S]*)'$/)
  if (m) return m[1].replace(/'\\''/g, "'")
  return cmd
}

// Re-export internal helpers for the test harness — the test patches
// `_classifyJsonRpcLine` to feed synthetic JSON-RPC frames.
export { _sanitizeThreadId }
