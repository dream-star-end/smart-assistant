/**
 * First-class adapter for xAI's official Grok CLI. The CLI runs once per turn
 * in headless streaming-json mode; subscription credentials never enter the
 * user container. Instead the master supplies an opaque, one-turn relay token.
 */
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GoalStateSnapshot, OutboundContentBlock } from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'
import type { ExecutionTarget } from '../remoteTarget.js'
import type {
  EngineAdapter,
  EngineCapabilities,
  EngineTurnRun,
  NativeModelHandoffArtifact,
  TurnParams,
} from './engineAdapter.js'
import type {
  EngineBillingEvent,
  EngineEvent,
  PartialSnapshot,
  PhantomSignals,
  SegmentRecord,
  TurnSummary,
  TurnToolEntry,
} from './engineEvents.js'
import { engineSessionId } from './engineSessionId.js'
import { type EngineCreateOpts, registerEngine } from './registry.js'
import { BINARY_BLOCK_OMITTED_NOTICE, countBinaryInputBlocks, isBinaryInputBlock } from './promptInput.js'
import { buildCodexEnv } from './codexShared.js'
import { createLogger } from '../logger.js'
import { detachChildStdio, killProcessGroup, shutdownTimeoutMs, waitForCloseWithin } from '../processGroupShutdown.js'
import { grokProductToolInput, grokProductToolName, grokProductToolOutput } from './grokToolNormalize.js'
import { decideEngineCwd } from '../engineCwd.js'
import { persistRunContextSnapshot } from '../runContextPersist.js'
import { buildPromptContext } from '../promptSlots.js'
import { GROK_PREAMBLE, prepareGrokHome, projectGrokPlatform } from './grokPlatform.js'

const log = createLogger({ module: 'grokAdapter' })

const GROK_SHUTDOWN_GRACE_DEFAULT_MS = 3_000
const GROK_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS = 3_000
const GROK_UPSTREAM_MODEL = 'grok-4.6'
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
const PROCESS_KEEPALIVE_INTERVAL_DEFAULT_MS = 30_000
const PROCESS_KEEPALIVE_INTERVAL_MIN_MS = 5_000
const PROCESS_KEEPALIVE_INTERVAL_MAX_MS = 120_000

type GrokProcessKeepaliveTestHooks = {
  intervalMs?: number
}

let processKeepaliveTestHooks: GrokProcessKeepaliveTestHooks | null = null

function parseProcessKeepaliveIntervalMs(): number {
  const raw = process.env.OPENCLAUDE_GROK_PROCESS_KEEPALIVE_MS
  if (!raw) return PROCESS_KEEPALIVE_INTERVAL_DEFAULT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return PROCESS_KEEPALIVE_INTERVAL_DEFAULT_MS
  return Math.min(
    PROCESS_KEEPALIVE_INTERVAL_MAX_MS,
    Math.max(PROCESS_KEEPALIVE_INTERVAL_MIN_MS, Math.floor(parsed)),
  )
}

function resolvedProcessKeepaliveIntervalMs(): number {
  return processKeepaliveTestHooks?.intervalMs ?? parseProcessKeepaliveIntervalMs()
}

function isPidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const GROK_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GROK_CHECKPOINT_MAX_BYTES = 32 * 1024 * 1024
const GROK_SUMMARY_PREFIX = 'This session is being continued from a previous conversation'

function findNativeSummaryCarrier(value: unknown, depth = 0): string | null {
  if (depth > 16) return null
  if (typeof value === 'string') {
    const text = value.trim()
    return text.startsWith(GROK_SUMMARY_PREFIX) ? text : null
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findNativeSummaryCarrier(value[index], depth + 1)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findNativeSummaryCarrier(child, depth + 1)
    if (found) return found
  }
  return null
}

export async function readLatestGrokNativeHandoff(
  grokHome: string,
  sessionId: string,
  compactStartedAt: number,
): Promise<NativeModelHandoffArtifact> {
  if (!GROK_SESSION_ID_RE.test(sessionId)) throw new Error('GROK_COMPACTION_SESSION_INVALID')
  const sessionsRoot = realpathSync(join(grokHome, 'sessions'))
  let latest: { mtimeMs: number; summaryText: string } | null = null
  for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue
    const checkpointDir = resolve(sessionsRoot, group.name, sessionId, 'compaction_checkpoints')
    if (!checkpointDir.startsWith(`${sessionsRoot}/`) || !existsSync(checkpointDir)) continue
    const canonicalDir = realpathSync(checkpointDir)
    if (canonicalDir !== checkpointDir) continue
    for (const entry of readdirSync(canonicalDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) continue
      const file = resolve(canonicalDir, entry.name)
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > GROK_CHECKPOINT_MAX_BYTES) continue
      if (info.mtimeMs + 5_000 < compactStartedAt) continue
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
      const row = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
      if (!row || row.schema_version !== 1 || !Array.isArray(row.compacted_history)) continue
      const summaryText = findNativeSummaryCarrier(row.compacted_history)
      if (!summaryText) continue
      if (!latest || info.mtimeMs >= latest.mtimeMs) latest = { mtimeMs: info.mtimeMs, summaryText }
    }
  }
  if (!latest) throw new Error('GROK_NATIVE_COMPACTION_NOT_EXPORTED')
  return { summaryText: latest.summaryText, source: 'grok', compactStartedAt }
}
const EMPTY_SIGNALS: Readonly<PhantomSignals> = Object.freeze({
  apiState: 'unknown',
  skipReason: null,
})
export interface GrokRouteOverride {
  baseUrl: string
  routeToken: string
}

type GrokEvent = Record<string, unknown> & { type?: unknown }

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Prefer the official toolName. ACP `kind` is often "other"/"read"/"execute". */
function grokNativeToolName(event: GrokEvent): string {
  const toolName = asText(event.toolName)
  if (toolName) return toolName
  const title = asText(event.title)
  if (title && !['read', 'other', 'execute', 'edit'].includes(title.toLowerCase())) return title
  const kind = asText(event.kind)
  if (kind && !['read', 'other', 'execute', 'edit'].includes(kind.toLowerCase())) return kind
  return title || kind || 'GrokTool'
}

function promptText(input: TurnParams['input']): string {
  if (typeof input === 'string') return input
  return input
    .map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      // P0-2:base64 二进制 block 绝不 stringify 进纯文本 prompt,占位替换。
      if (isBinaryInputBlock(block)) return BINARY_BLOCK_OMITTED_NOTICE
      return asText(block)
    })
    .filter(Boolean)
    .join('\n')
}

function snapshotOf(ctx: GrokTurnContext | null): PartialSnapshot {
  if (!ctx) {
    return {
      assistantText: '',
      thinkingText: '',
      completedTools: [],
      assistantSegments: [],
      thinkingSegments: [],
      runtimeEvents: [],
    }
  }
  return {
    assistantText: ctx.assistantText,
    thinkingText: ctx.thinkingText,
    completedTools: [...ctx.tools.values()].map((tool) => structuredClone(tool)),
    assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
    thinkingSegments: ctx.thinkingSegments.map((segment) => ({ ...segment })),
    runtimeEvents: [],
  }
}

function grokUsage(event: GrokEvent): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
} {
  const raw = event.usage && typeof event.usage === 'object'
    ? event.usage as Record<string, unknown>
    : {}
  const safe = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0
  const inputTokens = safe(raw.input_tokens ?? raw.inputTokens)
  const outputTokens = safe(raw.output_tokens ?? raw.outputTokens)
  const cacheReadTokens = safe(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens)
  const cacheWriteTokens = safe(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens)
  const reasoningTokens = safe(raw.reasoning_tokens ?? raw.reasoningTokens)
  const reportedTotal = safe(raw.total_tokens ?? raw.totalTokens)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

function authError(detail: string): boolean {
  return /authenticat|credentials|\b401\b|unauthorized|token (?:is )?(?:expired|invalid|revoked)|not logged in/i.test(detail)
}

interface GrokTurnContext {
  params: TurnParams
  startedAt: number
  proc: ChildProcessByStdio<null, Readable, Readable> | null
  promptDir: string | null
  assistantText: string
  thinkingText: string
  assistantSegments: SegmentRecord[]
  thinkingSegments: SegmentRecord[]
  lastContentKind: 'text' | 'thought' | null
  tools: Map<string, TurnToolEntry>
  toolStartedAt: Map<string, number>
  finalizedToolIds: Set<string>
  pendingToolIds: Set<string>
  stderr: string
  terminal: boolean
  procClosed: boolean
  abandoned: boolean
  resolveDrain: (() => void) | null
  interrupted: boolean
  errorDetail: string | null
  lastUsage: ReturnType<typeof grokUsage>
  resolveSummary: (summary: TurnSummary | null) => void
}

function cleanupPromptDir(ctx: GrokTurnContext): void {
  const promptDir = ctx.promptDir
  if (!promptDir) return
  ctx.promptDir = null
  try {
    rmSync(promptDir, { recursive: true, force: true })
  } catch {
    // Best effort. The directory is mode 0700 and contains only this turn's
    // mode-0600 prompt; a later container recycle removes any residue.
  }
}

export class GrokAdapter extends EventEmitter implements EngineAdapter {
  readonly engineId = 'grok'
  readonly capabilities: EngineCapabilities = {
    billingMode: 'engine-reported',
    supportsEffort: true,
    resumeKind: 'grok-session',
    needsServerRequestId: true,
    historyMode: 'native-resume',
    // grok-build 以 --always-approve 驱动:用户 permissionMode 不会到达底座。
    permissionModel: 'forced-unattended',
    emitsCallUsage: false,
    emitsToolInputDeltas: false,
    supportsNativeCompact: true,
    multimodalInput: 'text-only',
  }

  private readonly opts: EngineCreateOpts
  private readonly stableEngineSessionId: string
  private route: GrokRouteOverride | null = null
  private active: GrokTurnContext | null = null
  private nativeId: string | null
  private currentModel: string | undefined
  private currentEffort: string | undefined
  private currentToolsets: string[] | undefined
  private currentTarget: ExecutionTarget = { kind: 'local' }
  private traceId: string | undefined
  private drain: Promise<void> = Promise.resolve()
  private processKeepaliveTimer: NodeJS.Timeout | null = null
  lastActivityAt = 0

  constructor(opts: EngineCreateOpts) {
    super()
    this.opts = { ...opts }
    this.stableEngineSessionId = engineSessionId(opts.sessionKey)
    this.nativeId = opts.resumeSessionId ?? null
    this.currentModel = opts.model
    this.currentEffort = opts.effortLevel
    this.currentToolsets = opts.agentToolsets
    // forced-unattended:CLI 恒以 --always-approve 驱动,非 bypass 的
    // permissionMode 无法生效。只记日志,不向前端注入提示(用户明确选择全放行)。
    if (opts.permissionMode && opts.permissionMode !== 'bypassPermissions') {
      log.warn('grok engine is forced-unattended; requested permissionMode is ignored', {
        sessionKey: opts.sessionKey,
        permissionMode: opts.permissionMode,
      })
    }
  }

  start(): Promise<void> {
    return Promise.resolve()
  }

  setGrokRoute(route: GrokRouteOverride | null | undefined): void {
    this.route = route ? { ...route } : null
  }

  submitTurn(params: TurnParams): EngineTurnRun {
    let resolveSummary!: (summary: TurnSummary | null) => void
    const summary = new Promise<TurnSummary | null>((resolve) => { resolveSummary = resolve })
    const ctx: GrokTurnContext = {
      params,
      startedAt: Date.now(),
      proc: null,
      promptDir: null,
      assistantText: '',
      thinkingText: '',
      assistantSegments: [],
      thinkingSegments: [],
      lastContentKind: null,
      tools: new Map(),
      toolStartedAt: new Map(),
      finalizedToolIds: new Set(),
      pendingToolIds: new Set(),
      stderr: '',
      terminal: false,
      procClosed: false,
      abandoned: false,
      resolveDrain: null,
      interrupted: false,
      errorDetail: null,
      lastUsage: grokUsage({}),
      resolveSummary,
    }
    this.active = ctx
    this.lastActivityAt = Date.now()
    this.drain = new Promise<void>((resolve) => { ctx.resolveDrain = resolve })
    const submitted = this.spawnTurn(ctx).catch((err) => {
      // Only ever settle this turn's own barrier: shutdown() may have already
      // abandoned it, in which case `active` and `drain` belong to a later turn
      // that this failure says nothing about.
      cleanupPromptDir(ctx)
      if (!ctx.abandoned) {
        this.forceEnd(ctx)
        if (this.active === ctx) this.active = null
      }
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      throw err
    })
    return {
      submitted,
      summary,
      end: () => this.forceEnd(ctx),
      getPartialSnapshot: () => snapshotOf(ctx),
      getPhantomSignals: () => ({ ...EMPTY_SIGNALS }),
      get finalized() { return ctx.terminal },
      get pendingToolCalls() { return ctx.pendingToolIds.size },
    }
  }

  private async spawnTurn(ctx: GrokTurnContext): Promise<void> {
    const route = this.route
    if (!route || !ROUTE_TOKEN_RE.test(route.routeToken)) {
      throw new Error('GROK_ROUTE_REQUIRED: missing master-owned Grok relay route')
    }
    let parsed: URL
    try {
      parsed = new URL(route.baseUrl)
    } catch {
      throw new Error('GROK_ROUTE_INVALID: malformed relay base URL')
    }
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== `/internal/v5/grok-relay/route/${route.routeToken}/v1` ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('GROK_ROUTE_INVALID: relay must be token-bound loopback')
    }

    this.emitOmittedBinaryNotice(ctx)

    let repoSnapshot = null
    if (this.opts.sessionId && this.opts.getRepoSnapshot) {
      repoSnapshot = this.opts.getRepoSnapshot(this.opts.sessionId)
    }
    const cwdDecision = decideEngineCwd({
      agentBaseDir: this.opts.agentBaseDir,
      repoSnapshot,
      projectBound: Boolean(this.opts.projectId),
    })
    const cwd = cwdDecision.cwd
    const platform = projectGrokPlatform({
      agentId: this.opts.agentId,
      projectId: this.opts.projectId,
      sessionKey: this.opts.sessionKey,
      gatewayPort: this.opts.config.gateway.port,
      gatewayToken: this.opts.config.gateway.accessToken ?? '',
      delegationDepth: this.opts.delegationDepth ?? 0,
      claudeCodePath: this.opts.config.auth.claudeCodePath,
      skillEvalMode: this.opts.skillEvalMode,
      skillEvalExclude: this.opts.skillEvalExclude,
      skillEvalDraft: this.opts.skillEvalDraft,
      skillTrainRunId: this.opts.skillTrainRunId,
    })
    const prompt = await this.composePrompt(ctx.params, repoSnapshot, platform.advertisedMcpTools)
    const promptDir = mkdtempSync(join(tmpdir(), 'oc-grok-prompt-'))
    const promptFile = join(promptDir, 'prompt.md')
    try {
      writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (err) {
      try { rmSync(promptDir, { recursive: true, force: true }) } catch { /* best effort */ }
      throw err
    }
    ctx.promptDir = promptDir
    const args = [
      '--agent', 'grok-build',
      '--model', GROK_UPSTREAM_MODEL,
      '--prompt-file', promptFile,
      '--output-format', 'streaming-json',
      '--always-approve',
      '--no-subagents',
      '--no-memory',
      '--cwd', cwd,
    ]
    if (this.nativeId) args.push('--resume', this.nativeId)
    if (this.currentEffort && ['low', 'medium', 'high'].includes(this.currentEffort)) {
      args.push('--reasoning-effort', this.currentEffort)
    }
    const isolatedEnv = buildCodexEnv()
    for (const key of Object.keys(isolatedEnv)) {
      if (key.startsWith('XAI_') || key.startsWith('GROK_') || key.startsWith('CODEX_')) {
        delete isolatedEnv[key]
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...isolatedEnv,
      PATH: '/run/oc/platform/current/bin:/usr/local/bin:/usr/bin:/bin',
      OC_AGENT_ID: this.opts.agentId,
      OC_SESSION_KEY: this.opts.sessionKey,
      OPENCLAUDE_ENGINE: 'grok',
      ...(process.env.OPENCLAUDE_HOME?.trim()
        ? { OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME.trim() }
        : isolatedEnv.OPENCLAUDE_HOME
          ? { OPENCLAUDE_HOME: isolatedEnv.OPENCLAUDE_HOME }
          : {}),
      ...(platform.delegateContextFile
        ? {
            OPENCLAUDE_GATEWAY_PORT: String(this.opts.config.gateway.port),
            OPENCLAUDE_DELEGATE_CONTEXT_FILE: platform.delegateContextFile,
          }
        : {}),
      XAI_API_KEY: route.routeToken,
      GROK_XAI_API_BASE_URL: route.baseUrl,
      GROK_CLI_CHAT_PROXY_BASE_URL: route.baseUrl,
      GROK_MODELS_BASE_URL: route.baseUrl,
      GROK_MODELS_LIST_URL: `${route.baseUrl.replace(/\/$/, '')}/models`,
      GROK_CLI_AUTO_UPDATE: 'false',
      GROK_TELEMETRY_ENABLED: 'false',
      GROK_HOME: platform.grokHome,
      ...(this.traceId ? { OPENCLAUDE_TRACE_ID: this.traceId } : {}),
    }
    const bin = process.env.OC_GROK_CLI_BIN?.trim()
      || (existsSync('/usr/local/bin/grok-native') ? '/usr/local/bin/grok-native' : 'grok')
    let proc: ChildProcessByStdio<null, Readable, Readable>
    try {
      proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (err) {
      cleanupPromptDir(ctx)
      throw err
    }
    ctx.proc = proc
    if (ctx.abandoned) {
      // shutdown() gave up on this turn while we were still composing the
      // prompt. Nobody will read this process and it carries the turn's route
      // token, so it must not outlive the turn it belongs to.
      cleanupPromptDir(ctx)
      killProcessGroup(proc, 'SIGKILL')
      detachChildStdio(proc)
      try { proc.unref() } catch { /* already detached */ }
      return
    }
    this.emit('spawn', { resumed: this.nativeId !== null })
    this.ensureProcessKeepalive()

    let stdoutBuffer = ''
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      stdoutBuffer += chunk
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) this.handleLine(ctx, line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.lastActivityAt = Date.now()
      this.emit('activity')
      ctx.stderr += chunk
    })
    proc.once('error', (err) => {
      if (this.active === ctx) this.stopProcessKeepalive()
      cleanupPromptDir(ctx)
      // An abandoned turn has already been finalized and `active` has moved on;
      // surfacing this would report a later turn as failed.
      if (ctx.abandoned) return
      if (!ctx.terminal) this.finishError(ctx, String(err))
      this.emit('error', err)
    })
    proc.once('close', (code, signal) => {
      if (this.active === ctx) this.stopProcessKeepalive()
      cleanupPromptDir(ctx)
      // shutdown() may have already given up on this process and finalized
      // the turn, in which case `active` belongs to a later turn that this
      // handler must not touch.
      if (ctx.abandoned) return
      ctx.procClosed = true
      if (stdoutBuffer.trim()) this.handleLine(ctx, stdoutBuffer.trim())
      ctx.resolveDrain?.()
      ctx.resolveDrain = null
      const crashed = !ctx.interrupted && code !== 0
      if (!ctx.terminal) {
        const detail = ctx.errorDetail || ctx.stderr.trim() || `grok exited with code ${String(code)}`
        this.finishError(ctx, detail)
      }
      this.emit('exit', { code, signal, crashed })
      if (this.active === ctx) this.active = null
    })
  }

  /** P0-2:输入含图片等二进制 block 时,除 prompt 占位替换外,再向用户发一条
   *  可见 assistant 提示(走常规 segment 机制,live 流与持久化 tape 一致)。 */
  private emitOmittedBinaryNotice(ctx: GrokTurnContext): void {
    const omitted = countBinaryInputBlocks(ctx.params.input)
    if (omitted === 0) return
    log.warn('binary input blocks omitted from text-only grok prompt', {
      sessionKey: this.opts.sessionKey,
      omitted,
    })
    const text = `${BINARY_BLOCK_OMITTED_NOTICE}\n\n`
    const segment: SegmentRecord = {
      index: ctx.assistantSegments.length,
      text,
      ts: Date.now(),
      eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
    }
    ctx.assistantSegments.push(segment)
    ctx.assistantText += text
    // lastContentKind 保持不变(null):模型首段 text 仍会新开自己的 segment。
    const messageIdBase = ctx.params.assistantMessageId
    ctx.params.onEvent({
      kind: 'block',
      block: {
        kind: 'text',
        text,
        ...(messageIdBase ? { messageId: `${messageIdBase}-s${segment.index}` } : {}),
      },
    })
  }

  private async composePrompt(
    params: TurnParams,
    repoSnapshot: ReturnType<NonNullable<EngineCreateOpts['getRepoSnapshot']>> | null,
    availableMcpTools: string[],
  ): Promise<string> {
    const input = promptText(params.input)
    try {
      const platform = await buildPromptContext({
        agentId: this.opts.agentId,
        sessionKey: this.opts.sessionKey,
        persona: this.opts.persona,
        provider: 'grok',
        model: this.currentModel,
        repoSnapshot: repoSnapshot ?? undefined,
        availableMcpTools,
        skillEvalExclude: this.opts.skillEvalExclude,
        skillEvalDraft: this.opts.skillEvalDraft,
        sessionId: typeof this.opts.sessionId === 'string' ? this.opts.sessionId : undefined,
        projectId: this.opts.projectId,
      })
      const cwdDecision = decideEngineCwd({
        agentBaseDir: this.opts.agentBaseDir,
        repoSnapshot,
        projectBound: Boolean(this.opts.projectId),
      })
      await persistRunContextSnapshot({
        descriptor: this.opts.runContext,
        applied: platform.applied,
        promptContentSha256: platform.contentSha256,
        frozen: platform.frozenProjectContext,
        cwd: cwdDecision.cwd,
        cwdSource: cwdDecision.source,
        sessionRepoOverlay: cwdDecision.sessionRepoOverlay,
      })
      log.info('prompt_context_built', {
        sessionKey: this.opts.sessionKey,
        agentId: this.opts.agentId,
        backend: 'grok',
        prompt_bytes: Buffer.byteLength(platform.content || '', 'utf8'),
        prompt_sha256: createHash('sha256').update(platform.content || '', 'utf8').digest('hex').slice(0, 12),
        board_project_id: this.opts.runContext?.boardProjectId ?? this.opts.projectId ?? null,
      })
      const body = platform.content ? `${platform.content}\n\n${input}` : input
      return `${GROK_PREAMBLE}\n${body}`
    } catch {
      let persona = ''
      if (this.opts.persona) {
        try { persona = readFileSync(this.opts.persona, 'utf8').trim() } catch { persona = '' }
      }
      const fallback = persona ? `${persona}\n\n${input}` : input
      return `${GROK_PREAMBLE}\n${fallback}`
    }
  }

  private handleLine(ctx: GrokTurnContext, line: string): void {
    let event: GrokEvent
    try {
      event = JSON.parse(line) as GrokEvent
    } catch (err) {
      this.emit('parse_error', { line, err })
      return
    }
    const type = event.type
    if (type === 'text') {
      const text = asText(event.data)
      if (!text) return
      if (ctx.lastContentKind !== 'text') {
        ctx.assistantSegments.push({ index: ctx.assistantSegments.length, text: '', ts: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() })
      }
      ctx.lastContentKind = 'text'
      ctx.assistantText += text
      const segment = ctx.assistantSegments.at(-1)!
      segment.text += text
      const messageIdBase = ctx.params.assistantMessageId
      ctx.params.onEvent({
        kind: 'block',
        block: {
          kind: 'text',
          text,
          ...(messageIdBase ? { messageId: `${messageIdBase}-s${segment.index}` } : {}),
        },
      })
      return
    }
    if (type === 'thought') {
      const text = asText(event.data)
      if (!text) return
      if (ctx.lastContentKind !== 'thought') {
        ctx.thinkingSegments.push({ index: ctx.thinkingSegments.length, text: '', ts: Date.now(), eventOrdinal: ctx.params.nextDurableEventOrdinal?.() })
      }
      ctx.lastContentKind = 'thought'
      ctx.thinkingText += text
      const segment = ctx.thinkingSegments.at(-1)!
      segment.text += text
      const messageIdBase = ctx.params.thinkingMessageId
      ctx.params.onEvent({
        kind: 'block',
        block: {
          kind: 'thinking',
          text,
          ...(messageIdBase ? { messageId: `${messageIdBase}-s${segment.index}` } : {}),
        },
      })
      return
    }
    ctx.lastContentKind = null
    if (type === 'tool_call') {
      this.observeToolCall(ctx, event)
      return
    }
    if (type === 'tool_call_update') {
      this.observeToolUpdate(ctx, event)
      return
    }
    if (type === 'plan') {
      const entries = Array.isArray(event.entries) ? event.entries : []
      const steps = entries.map((entry) => {
        const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const status: 'completed' | 'inProgress' | 'pending' = raw.status === 'completed'
          ? 'completed'
          : raw.status === 'in_progress'
            ? 'inProgress'
            : 'pending'
        return { step: asText(raw.step || raw.title || raw.content), status }
      }).filter((entry) => entry.step)
      ctx.params.onEvent({ kind: 'block', block: { kind: 'plan', steps, partial: false } })
      return
    }
    if (type === 'usage') {
      ctx.lastUsage = grokUsage(event)
      ctx.params.onEvent({ kind: 'usage', usage: {
        totalTokens: ctx.lastUsage.totalTokens,
        inputTokens: ctx.lastUsage.inputTokens,
        outputTokens: ctx.lastUsage.outputTokens,
        cacheReadTokens: ctx.lastUsage.cacheReadTokens,
        cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
      } })
      return
    }
    if (type === 'error') {
      ctx.errorDetail = asText(event.message) || asText(event.data) || 'Grok CLI error'
      if (event.usage && typeof event.usage === 'object') ctx.lastUsage = grokUsage(event)
      return
    }
    if (type === 'end') {
      if (event.usage && typeof event.usage === 'object') ctx.lastUsage = grokUsage(event)
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : null
      if (sessionId) {
        this.nativeId = sessionId
        this.emit('session_id', sessionId)
      }
      this.finish(ctx, event)
    }
  }

  private observeToolCall(ctx: GrokTurnContext, event: GrokEvent): void {
    const id = typeof event.toolCallId === 'string' && event.toolCallId
      ? event.toolCallId
      : `grok-tool-${ctx.tools.size + 1}`
    const nativeName = grokNativeToolName(event)
    const inputJson = grokProductToolInput(nativeName, event.rawInput ?? null)
    const toolName = grokProductToolName(nativeName, event.rawInput ?? null)
    const tool: TurnToolEntry = {
      toolUseId: id,
      blockId: id,
      toolName,
      inputJson: structuredClone(inputJson),
      inputPreview: asText(inputJson).slice(0, 500),
      output: '',
      completed: false,
      isError: false,
      durationMs: 0,
      ts: Date.now(),
      arrivedAt: Date.now(),
      eventOrdinal: ctx.params.nextDurableEventOrdinal?.(),
    }
    ctx.tools.set(id, tool)
    ctx.toolStartedAt.set(id, Date.now())
    ctx.pendingToolIds.add(id)
    ctx.params.toolUseIdToName.set(id, toolName)
    const block: OutboundContentBlock = { kind: 'tool_use', blockId: id, toolName, inputJson: structuredClone(inputJson), inputPreview: tool.inputPreview, partial: true }
    ctx.params.onEvent({ kind: 'block', block })
    ctx.params.onEvent({ kind: 'tool_use_detected', tool: { name: toolName, id, input: inputJson && typeof inputJson === 'object' ? structuredClone(inputJson) as Record<string, any> : {} } })
  }

  private observeToolUpdate(ctx: GrokTurnContext, event: GrokEvent): void {
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : ''
    if (!id) return
    if (!ctx.tools.has(id)) this.observeToolCall(ctx, { ...event, type: 'tool_call' })
    const tool = ctx.tools.get(id)!
    if (event.rawInput !== undefined) {
      const nativeName = grokNativeToolName(event) || tool.toolName
      tool.toolName = grokProductToolName(nativeName, event.rawInput)
      tool.inputJson = structuredClone(grokProductToolInput(nativeName, event.rawInput))
      tool.inputPreview = asText(tool.inputJson).slice(0, 500)
      ctx.params.toolUseIdToName.set(id, tool.toolName)
      ctx.params.onEvent({ kind: 'block', block: { kind: 'tool_use', blockId: id, toolName: tool.toolName, inputJson: structuredClone(tool.inputJson), inputPreview: tool.inputPreview, partial: false } })
    }
    const status = asText(event.status).toLowerCase()
    if (!['completed', 'complete', 'failed', 'error'].includes(status) || ctx.finalizedToolIds.has(id)) return
    const outputJson = event.rawOutput ?? event.content ?? null
    const output = grokProductToolOutput(outputJson)
    const isError = status === 'failed' || status === 'error'
    tool.output = output
    tool.outputJson = structuredClone(outputJson)
    tool.completed = true
    tool.isError = isError
    tool.durationMs = Date.now() - (ctx.toolStartedAt.get(id) ?? Date.now())
    tool.ts = Date.now()
    ctx.finalizedToolIds.add(id)
    ctx.pendingToolIds.delete(id)
    ctx.params.onEvent({ kind: 'block', block: { kind: 'tool_result', toolUseBlockId: id, toolName: tool.toolName, isError, output, outputJson: structuredClone(outputJson), preview: output.slice(0, 500) } })
    ctx.params.onEvent({ kind: 'tool_result_detected', result: { toolUseId: id, toolName: tool.toolName, preview: output.slice(0, 500), isError, durationMs: tool.durationMs, inputPreview: tool.inputPreview } })
  }

  private emitBilling(ctx: GrokTurnContext, status: 'success' | 'error'): void {
    const requestId = ctx.params.requestId
    if (!requestId || !/^[0-9a-f]{32}$/.test(requestId)) return
    const usage = ctx.lastUsage
    // Grok's reasoning_tokens is a subset of output_tokens, while the legacy
    // billing wire expects disjoint output and reasoning counters and folds
    // them together on the commercial master.
    const nonReasoningOutputTokens = Math.max(0, usage.outputTokens - usage.reasoningTokens)
    const billing: EngineBillingEvent = {
      requestId,
      ...(ctx.params.turnKey && /^[0-9a-f]{64}$/.test(ctx.params.turnKey) ? { turnKey: ctx.params.turnKey } : {}),
      ...(ctx.params.usageAttribution?.parentTurnKey ? { parentTurnKey: ctx.params.usageAttribution.parentTurnKey } : {}),
      ...(ctx.params.usageAttribution?.parentSessionId ? { parentSessionId: ctx.params.usageAttribution.parentSessionId } : {}),
      ...(ctx.params.usageAttribution?.delegateAgentId ? { delegateAgentId: ctx.params.usageAttribution.delegateAgentId } : {}),
      engineSessionId: this.stableEngineSessionId,
      status,
      // P1-11 审计:'CODEX_ERROR' 是刻意保留的字面量,不是笔误。engine-reported
      // 计费帧的 terminalCode 联合类型由 protocol(losslessTurnTape.DurableCodexBilling
      // / frames.ts billing schema)锁定为 'USER_CANCELLED' | 'CODEX_ERROR',且
      // commercial userChatBridge 按字面量匹配、未知值会被强转回 'CODEX_ERROR'。
      // 语义 = "engine 非用户取消的终态错误";引入 'GROK_ERROR' 需要先动 wire 契约。
      ...(status === 'error' ? { terminalCode: ctx.interrupted ? 'USER_CANCELLED' : 'CODEX_ERROR' } : {}),
      durationMs: Date.now() - ctx.startedAt,
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: nonReasoningOutputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheWriteTokens,
        reasoning_output_tokens: usage.reasoningTokens,
      },
    }
    this.emit('billing', billing)
  }

  private finish(ctx: GrokTurnContext, end: GrokEvent | null): void {
    if (this.active === ctx) this.stopProcessKeepalive()
    if (ctx.terminal) return
    const upstreamStopReason = typeof end?.stopReason === 'string' ? end.stopReason : null
    if (upstreamStopReason === 'cancelled') ctx.interrupted = true
    if (ctx.interrupted && ctx.errorDetail === null) ctx.errorDetail = 'Grok turn cancelled'
    const stopReason = ctx.interrupted ? 'interrupted' : upstreamStopReason
    ctx.terminal = true
    const isError = ctx.errorDetail !== null
    ctx.params.sessionTotals.turns += 1
    this.emitBilling(ctx, isError ? 'error' : 'success')
    if (isError) ctx.params.onEvent({ kind: 'error', error: ctx.errorDetail! })
    ctx.params.onEvent({ kind: 'final', meta: {
      inputTokens: ctx.lastUsage.inputTokens,
      outputTokens: ctx.lastUsage.outputTokens,
      cacheReadTokens: ctx.lastUsage.cacheReadTokens,
      cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
      totalTokens: ctx.lastUsage.totalTokens,
      stopReason: stopReason ?? undefined,
      cost: 0,
    } })
    ctx.resolveSummary({
      usage: {
        cost: 0,
        inputTokens: ctx.lastUsage.inputTokens,
        outputTokens: ctx.lastUsage.outputTokens,
        cacheReadTokens: ctx.lastUsage.cacheReadTokens,
        cacheCreationTokens: ctx.lastUsage.cacheWriteTokens,
        totalTokens: ctx.lastUsage.totalTokens,
      },
      assistantText: ctx.assistantText,
      thinkingText: ctx.thinkingText,
      assistantSegments: ctx.assistantSegments.map((segment) => ({ ...segment })),
      thinkingSegments: ctx.thinkingSegments.map((segment) => ({ ...segment })),
      tools: [...ctx.tools.values()].map((tool) => structuredClone(tool)),
      runtimeEvents: [],
      stopReason,
      numTurns: typeof end?.num_turns === 'number' && Number.isFinite(end.num_turns) && end.num_turns >= 0
        ? Math.floor(end.num_turns)
        : 1,
      isError,
      ...(isError ? { errorKind: authError(ctx.errorDetail!) ? 'auth' as const : 'other' as const, errorDetail: ctx.errorDetail! } : {}),
      staleResumeId: false,
      phantomSignals: { ...EMPTY_SIGNALS },
    })
  }

  private finishError(ctx: GrokTurnContext, detail: string): void {
    if (ctx.terminal) return
    ctx.errorDetail = detail
    this.finish(ctx, null)
  }

  private forceEnd(ctx: GrokTurnContext): void {
    if (this.active === ctx) this.stopProcessKeepalive()
    if (ctx.terminal) return
    ctx.terminal = true
    ctx.resolveSummary(null)
  }

  private stopProcessKeepalive(): void {
    if (!this.processKeepaliveTimer) return
    clearInterval(this.processKeepaliveTimer)
    this.processKeepaliveTimer = null
  }

  private ensureProcessKeepalive(): void {
    if (this.processKeepaliveTimer) return
    const ctx = this.active
    if (!ctx || ctx.terminal || ctx.abandoned || !ctx.proc) return
    const intervalMs = resolvedProcessKeepaliveIntervalMs()
    if (intervalMs <= 0) return
    this.processKeepaliveTimer = setInterval(() => { this.tickProcessKeepalive() }, intervalMs)
    this.processKeepaliveTimer.unref()
  }

  private tickProcessKeepalive(): void {
    try {
      const ctx = this.active
      const pid = ctx?.proc?.pid
      if (!ctx || ctx.terminal || ctx.abandoned || !isPidAlive(pid)) {
        this.stopProcessKeepalive()
        return
      }
      // Official Grok can think or wait on the first API round-trip for minutes
      // with no stdout. Cursor already keeps lastActivityAt fresh while the
      // parent PID is alive; without that, grok-build dies at the 15-minute
      // idle watchdog and then auto-recovers into a thinking-forever loop.
      // The 12h logical-turn cap still bounds a genuinely stuck CLI.
      this.lastActivityAt = Date.now()
      this.emit('activity')
    } catch {
      // Keepalive must never throw into the interval.
    }
  }

  interrupt(): boolean {
    const ctx = this.active
    if (!ctx?.proc || ctx.proc.killed) return false
    ctx.interrupted = true
    killProcessGroup(ctx.proc, 'SIGINT')
    return true
  }

  /** Stop has to reach a terminal state even when a tool descendant escapes
   * the CLI's process group and keeps this turn's stdout open. Escalate to a
   * process-group SIGKILL, then put a deadline on the close barrier: an
   * unbounded wait leaves the turn without a terminal event and the client
   * stuck in "stopping" indefinitely. */
  async shutdown(): Promise<void> {
    const ctx = this.active
    if (!ctx) return
    if (ctx.procClosed) {
      await this.waitForOutputDrain()
      return
    }
    const grace = shutdownTimeoutMs(
      'OPENCLAUDE_GROK_SHUTDOWN_GRACE_MS',
      GROK_SHUTDOWN_GRACE_DEFAULT_MS,
    )
    const closeBarrier = this.drain
    let proc = ctx.proc
    if (!proc) {
      // Stop can land while submitTurn() is still composing the prompt. There
      // is nothing to signal yet and the barrier only resolves through a child
      // that does not exist, so give the spawn a bounded chance to appear
      // instead of either blocking Stop or stranding a CLI we could have
      // killed a moment later.
      if (await waitForCloseWithin(closeBarrier, grace)) return
      proc = ctx.proc
      if (!proc) {
        log.error('grok turn never spawned a child before shutdown', {
          sessionKey: this.opts.sessionKey,
        })
        this.abandonTurn(ctx, null, 'grok never started')
        return
      }
    }
    killProcessGroup(proc, 'SIGTERM')
    let closed = await waitForCloseWithin(closeBarrier, grace)
    if (!closed) {
      killProcessGroup(proc, 'SIGKILL')
      closed = await waitForCloseWithin(
        closeBarrier,
        shutdownTimeoutMs(
          'OPENCLAUDE_GROK_SHUTDOWN_FINAL_DRAIN_MS',
          GROK_SHUTDOWN_FINAL_DRAIN_DEFAULT_MS,
        ),
      )
    }
    if (closed) return
    log.error('grok stdout never closed after process-group SIGKILL', {
      sessionKey: this.opts.sessionKey,
      pid: proc.pid,
    })
    this.abandonTurn(ctx, proc, 'grok did not exit after SIGKILL')
  }
  /** Finish a turn we can no longer reach, in full, right here.
   *
   * Leaving any of it to 'close' is what makes an escaped descendant
   * dangerous: it can hold the pipe for hours, and by then the barrier and
   * `active` belong to a later turn that a stale handler would resolve and
   * terminate early. */
  private abandonTurn(
    ctx: GrokTurnContext,
    proc: ChildProcessByStdio<null, Readable, Readable> | null,
    detail: string,
  ): void {
    if (this.active === ctx) this.stopProcessKeepalive()
    cleanupPromptDir(ctx)
    ctx.abandoned = true
    if (proc) detachChildStdio(proc)
    if (!ctx.terminal) this.finishError(ctx, detail)
    ctx.resolveDrain?.()
    ctx.resolveDrain = null
    if (this.active === ctx) this.active = null
    if (proc) {
      try { proc.unref() } catch { /* already detached */ }
    }
  }

  waitForOutputDrain(): Promise<void> { return this.drain }
  readCompactionHandoffSince(compactStartedAt: number): Promise<NativeModelHandoffArtifact> {
    if (!this.nativeId) return Promise.reject(new Error('GROK_COMPACTION_SESSION_NOT_READY'))
    return readLatestGrokNativeHandoff(prepareGrokHome(), this.nativeId, compactStartedAt)
  }

  get nativeSessionId(): string | null { return this.nativeId }
  clearSessionId(): void { this.nativeId = null }
  setModel(model: string | undefined): void { this.currentModel = model }
  get model(): string | undefined { return this.currentModel }
  setEffortLevel(level: string | undefined): void { this.currentEffort = level }
  get effortLevel(): string | undefined { return this.currentEffort }
  setTraceId(traceId: string | undefined): void { this.traceId = traceId }
  setGoalState(_goal: GoalStateSnapshot | null): Promise<void> { return Promise.resolve() }
  updateConfig(config: OpenClaudeConfig): void { this.opts.config = config }
  setToolsets(toolsets: string[] | undefined): void { this.currentToolsets = toolsets }
  get toolsets(): string[] | undefined { return this.currentToolsets }
  setExecutionTarget(target: ExecutionTarget): void {
    if (target.kind !== 'local') throw new Error('Grok engine supports local execution only')
    this.currentTarget = target
  }
  get executionTarget(): ExecutionTarget { return this.currentTarget }
  sendPermissionResponse(_requestId: string, _response: unknown): boolean { return false }
  getPartialSnapshot(): PartialSnapshot { return snapshotOf(this.active) }
  get pendingToolCalls(): number { return this.active?.pendingToolIds.size ?? 0 }
  get isRunning(): boolean { return !!this.active?.proc && !this.active.proc.killed && !this.active.terminal }
  getBoundRepoBinding(): { selectionVersion: number; workspaceDir: string } | null { return null }
}

export const _internals = {
  promptText,
  PROCESS_KEEPALIVE_INTERVAL_DEFAULT_MS,
  PROCESS_KEEPALIVE_INTERVAL_MIN_MS,
  PROCESS_KEEPALIVE_INTERVAL_MAX_MS,
  setProcessKeepaliveTestHooks(hooks: GrokProcessKeepaliveTestHooks | null): void {
    processKeepaliveTestHooks = hooks
  },
}

registerEngine('grok', (opts) => new GrokAdapter(opts))
