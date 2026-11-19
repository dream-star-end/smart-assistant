/** Codex >= 0.159.2: environments:[] removes shell and apply_patch from
 * the native registry (both require has_environment in tools/spec_plan.rs).
 * These feature switches also remove tools that can mutate external state
 * without using that execution environment. Keep this independent of prompt
 * construction so even a legacy launch without platform context is restricted. */
import {
  ADVISOR_READ_ONLY_MCP_TOOLS,
  CODEX_ULTRAFAST_SERVICE_TIER,
  type ServiceTier,
  codexTransportModelId,
  codexTurnServiceTierValue,
} from '@openclaude/protocol'
import { abortableDelay } from './codexLifecycle.js'
import { normalizeCodexReasoningEffort } from './codexShared.js'

const CODEX_DEFAULT_MODE_INSTRUCTIONS = [
  'You are in implementation mode, not plan-only mode.',
  'Decide autonomously whether the user request benefits from a visible plan/task list before or during execution.',
  'For multi-step, risky, ambiguous, or code-changing tasks, create and maintain a concise plan; keep exactly one active step when work is underway.',
  'For trivial one-step questions or tiny edits, skip the plan and answer or implement directly.',
  'Do not stop after planning unless the user explicitly asks for plan-only; after planning, continue execution in the same turn when execution is allowed.',
  'When creating or editing files, prefer native fileChange/apply_patch edits so the UI can render Write/Edit cards; avoid Bash heredocs solely for file writes unless the shell command also needs real shell-side effects such as batch scaffolding.',
].join(' ')

/** Keep ordinary, plan, hermetic and advisor policy construction together so
 * thread attach/recovery cannot omit an advisor restriction. */
export function buildCodexThreadPolicyParams(
  cwd: string,
  modelId: string | undefined,
  readOnly: boolean,
  config: Record<string, unknown> | undefined,
  hermeticNoTools = false,
): Record<string, unknown> {
  const model = codexTransportModelId(modelId)
  return {
    approvalPolicy: 'never',
    sandbox: hermeticNoTools || readOnly ? 'read-only' : 'danger-full-access',
    ...(readOnly ? { environments: [], config } : {}),
    cwd,
    ...(model ? { model } : {}),
  }
}

export function buildCodexTurnPolicyParams(prompt: string, threadId: string | null, opts: {
  model?: string
  effortLevel?: string
  serviceTier?: ServiceTier | null
  mode: 'default' | 'plan'
  hermeticNoTools?: boolean
  readOnly: boolean
  structuredOutputSchema?: Readonly<Record<string, unknown>>
}): Record<string, unknown> {
  const model = codexTransportModelId(opts.model)
  const reasoningEffort = normalizeCodexReasoningEffort(opts.model, opts.effortLevel) ?? undefined
  const params: Record<string, unknown> = {
    threadId,
    input: [{ type: 'text', text: prompt }],
    collaborationMode: {
      mode: opts.mode,
      settings: {
        model: model ?? '',
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        developer_instructions: opts.mode === 'default' ? CODEX_DEFAULT_MODE_INSTRUCTIONS : null,
      },
    },
    sandboxPolicy: opts.hermeticNoTools || opts.readOnly
      ? { type: 'readOnly', networkAccess: false }
      : opts.mode === 'plan'
        ? { type: 'readOnly', networkAccess: true }
        : { type: 'dangerFullAccess' },
  }
  if (model) params.model = model
  if (opts.readOnly) params.environments = []
  if (opts.structuredOutputSchema) params.outputSchema = opts.structuredOutputSchema
  // OCV5-798: local Codex GPT-6 turns carry explicit speed tier ('priority' / 'ultrafast' / 'default').
  // Read-only advisor turns always stay explicit Standard so background verification never burns 2x/6x.
  const wireServiceTier = codexTurnServiceTierValue(opts.model, opts.readOnly ? null : opts.serviceTier)
  if (wireServiceTier !== undefined) {
    params.serviceTierForTurn = wireServiceTier
  }
  return params
}

export async function readAdvisorReadOnlyConfig(
  readOnly: boolean,
  initialized: unknown,
  readConfig: () => Promise<unknown>,
  trustedPlatformMcp: boolean,
): Promise<Record<string, unknown> | undefined> {
  if (!readOnly) return undefined
  assertAdvisorReadOnlyRuntime(initialized)
  return advisorReadOnlyThreadConfig(await readConfig(), trustedPlatformMcp)
}

const DISABLED_FEATURES = [
    'shell_tool', 'unified_exec', 'shell_snapshot',
    'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use',
    'in_app_local_automation', 'image_generation', 'multi_agent', 'multi_agent_v2',
    'request_permissions_tool', 'hooks', 'memories', 'artifact', 'goals',
    'skill_mcp_dependency_install', 'workspace_dependencies', 'tool_suggest',
]

export function buildAdvisorReadOnlyArgs(): string[] {
  return ['-c', 'agents.enabled=false', ...DISABLED_FEATURES.flatMap(feature => ['-c', `features.${feature}=false`])]
}

/** Older binaries silently ignore unknown JSON fields. Refuse a restricted
 * turn before thread/turn start unless the binary reports a compatible build. */
export function assertAdvisorReadOnlyRuntime(initialized: unknown): void {
  const userAgent = initialized && typeof initialized === 'object'
    ? (initialized as Record<string, unknown>).userAgent : undefined
  const version = typeof userAgent === 'string' ? /\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(userAgent) : null
  if (version) {
    const [major, minor, patch] = version.slice(1).map(Number)
    if (major > 0 || minor > 159 || (minor === 159 && patch >= 2)) return
  }
  throw new Error('CODEX_ADVISOR_READ_ONLY_UNSUPPORTED: this Codex runtime cannot enforce a read-only advisor turn')
}

/** Empty TOML tables merge with inherited servers rather than deleting them.
 * Freeze explicit per-server disables from the effective project/user config. */
export function advisorReadOnlyThreadConfig(configuration: unknown, trustedPlatformMcp = false): Record<string, unknown> {
  const config = configuration && typeof configuration === 'object'
    ? (configuration as Record<string, unknown>).config : undefined
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('CODEX_ADVISOR_READ_ONLY_CONFIG_UNAVAILABLE')
  }
  const inherited = (config as Record<string, unknown>).mcp_servers
  if (inherited !== undefined && (!inherited || typeof inherited !== 'object' || Array.isArray(inherited))) {
    throw new Error('CODEX_ADVISOR_READ_ONLY_CONFIG_UNAVAILABLE')
  }
  const mcpServers = Object.fromEntries(Object.entries(inherited ?? {}).map(([name, server]) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error('CODEX_ADVISOR_READ_ONLY_CONFIG_UNAVAILABLE')
    }
    // config/read serializes optional defaults as null. JSON→TOML overrides
    // cannot represent null (it becomes an empty string), so omit those keys.
    const source = Object.fromEntries(Object.entries(server).filter(([, value]) => value !== null))
    return [name, trustedPlatformMcp && name === 'openclaude_memory'
      ? { ...source, enabled_tools: [...ADVISOR_READ_ONLY_MCP_TOOLS], env: {
        ...(source.env && typeof source.env === 'object' ? source.env : {}),
        OPENCLAUDE_ADVISOR_READ_ONLY: '1',
      } }
      : { ...source, enabled: false }]
  }))
  return {
    mcp_servers: mcpServers,
    // Resume can restore prior thread feature settings. Pin both the legacy
    // agent switch and feature gates in its thread-level overrides as well.
    agents: { enabled: false },
    features: Object.fromEntries(DISABLED_FEATURES.map(feature => [feature, false])),
  }
}

export const CODEX_ULTRAFAST_CHECK_TIMEOUT_MS = 10_000
export const CODEX_ULTRAFAST_UNAVAILABLE_CODE = 'CODEX_ULTRAFAST_UNAVAILABLE'
const CODEX_ULTRAFAST_RETRY_DELAY_MS = 250
const MAX_MODEL_LIST_PAGES = 10

let ultrafastCheckTimeoutOverrideMs: number | null = null

/** Test hook to override the Ultrafast `model/list` capability timeout without slowing CI. */
export function _setUltrafastCheckTimeoutForTests(ms: number | null): void {
  ultrafastCheckTimeoutOverrideMs = ms
}

function modelListAdvertisesTierOnPage(
  modelListRes: unknown,
  transportModel: string,
  wireTier: string,
): { foundModel: boolean; supported: boolean; nextCursor: string | null } {
  const obj = modelListRes && typeof modelListRes === 'object'
    ? (modelListRes as { data?: unknown; nextCursor?: unknown })
    : undefined
  const data = obj?.data
  const nextCursor = typeof obj?.nextCursor === 'string' && obj.nextCursor ? obj.nextCursor : null
  if (!Array.isArray(data)) return { foundModel: false, supported: false, nextCursor }
  const entry = data.find((item) => {
    if (!item || typeof item !== 'object') return false
    const rec = item as { id?: unknown; model?: unknown }
    return rec.id === transportModel || rec.model === transportModel
  }) as { serviceTiers?: unknown; additionalSpeedTiers?: unknown } | undefined
  if (!entry) return { foundModel: false, supported: false, nextCursor }
  const hasTierObj = Array.isArray(entry.serviceTiers) && entry.serviceTiers.some((t) =>
    typeof t === 'string'
      ? t === wireTier
      : Boolean(t && typeof t === 'object' && (t as { id?: unknown }).id === wireTier),
  )
  const hasAdditional = Array.isArray(entry.additionalSpeedTiers)
    && entry.additionalSpeedTiers.includes(wireTier)
  return { foundModel: true, supported: hasTierObj || hasAdditional, nextCursor }
}

/** Checks whether a Codex `model/list` response advertises `wireTier` for `transportModel`. */
export function modelListAdvertisesServiceTier(
  modelListRes: unknown,
  transportModel: string,
  wireTier: string,
): boolean {
  return modelListAdvertisesTierOnPage(modelListRes, transportModel, wireTier).supported
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error(`Codex Ultrafast check aborted${reason ? ` (${String(reason)})` : ''}`)
}

/**
 * Prevents silent 6x Ultrafast overbilling when Codex 0.170.0 cannot refresh `/models`
 * (or the bound account lacks entitlement / switches mid-session) by confirming via live
 * local `model/list` before native compaction and `turn/start`.
 */
export async function ensureCodexTurnServiceTierSupported(opts: {
  model?: string
  readOnly: boolean
  serviceTier?: ServiceTier | null
  remote?: boolean
  initialized: unknown
  signal?: AbortSignal
  timeoutMs?: number
  listModels: (cursor?: string, signal?: AbortSignal) => Promise<unknown>
  waitRetryMs?: (ms: number, signal?: AbortSignal) => Promise<void>
}): Promise<void> {
  const wireTier = codexTurnServiceTierValue(opts.model, opts.readOnly ? null : opts.serviceTier)
  const transportModel = codexTransportModelId(opts.model)
  if (opts.remote || wireTier !== CODEX_ULTRAFAST_SERVICE_TIER || !transportModel) return
  const userAgent = opts.initialized && typeof opts.initialized === 'object'
    ? (opts.initialized as { userAgent?: unknown }).userAgent
    : undefined
  // FakeCodexProc unit harnesses return `{}` without userAgent and do not implement `model/list`.
  if (typeof userAgent !== 'string' || !userAgent.trim()) return
  if (opts.signal?.aborted) throw toAbortError(opts.signal.reason)

  const checkController = new AbortController()
  let timedOut = false
  const onParentAbort = () => {
    checkController.abort(opts.signal?.reason)
  }
  opts.signal?.addEventListener('abort', onParentAbort, { once: true })

  const rawTimeout = opts.timeoutMs ?? ultrafastCheckTimeoutOverrideMs ?? CODEX_ULTRAFAST_CHECK_TIMEOUT_MS
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : CODEX_ULTRAFAST_CHECK_TIMEOUT_MS
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    checkController.abort('timeout')
  }, timeoutMs)

  const assertNotAborted = (): void => {
    if (opts.signal?.aborted) throw toAbortError(opts.signal.reason)
    if (timedOut) {
      throw new Error(
        `${CODEX_ULTRAFAST_UNAVAILABLE_CODE}: Codex model/list capability check timed out after ${timeoutMs}ms`,
      )
    }
    if (checkController.signal.aborted) throw toAbortError(checkController.signal.reason)
  }

  const checkOnce = async (): Promise<boolean> => {
    let cursor: string | undefined
    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page++) {
      assertNotAborted()
      const res = await opts.listModels(cursor, checkController.signal)
      assertNotAborted()
      const parsed = modelListAdvertisesTierOnPage(res, transportModel, CODEX_ULTRAFAST_SERVICE_TIER)
      if (parsed.foundModel) return parsed.supported
      if (!parsed.nextCursor) return false
      cursor = parsed.nextCursor
    }
    return false
  }

  try {
    if (await checkOnce()) return
    assertNotAborted()
    if (opts.waitRetryMs) {
      await opts.waitRetryMs(CODEX_ULTRAFAST_RETRY_DELAY_MS, checkController.signal)
    } else {
      await abortableDelay(CODEX_ULTRAFAST_RETRY_DELAY_MS, checkController.signal)
    }
    assertNotAborted()
    if (await checkOnce()) return
  } catch (err) {
    if (opts.signal?.aborted) throw toAbortError(opts.signal.reason)
    if (timedOut) {
      throw new Error(
        `${CODEX_ULTRAFAST_UNAVAILABLE_CODE}: Codex model/list capability check timed out after ${timeoutMs}ms`,
      )
    }
    throw err
  } finally {
    clearTimeout(timeoutTimer)
    opts.signal?.removeEventListener('abort', onParentAbort)
  }
  throw new Error(
    `${CODEX_ULTRAFAST_UNAVAILABLE_CODE}: Ultrafast speed tier is unavailable in Codex model catalog (/models unreachable or account lacks Ultrafast entitlement); refusing turn before execution to prevent 6x overbilling`,
  )
}
