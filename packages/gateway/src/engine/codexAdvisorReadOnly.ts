/** Codex >= 0.159.2: environments:[] removes shell and apply_patch from
 * the native registry (both require has_environment in tools/spec_plan.rs).
 * These feature switches also remove tools that can mutate external state
 * without using that execution environment. Keep this independent of prompt
 * construction so even a legacy launch without platform context is restricted. */
import {
  ADVISOR_READ_ONLY_MCP_TOOLS,
  CODEX_EXPLICIT_STANDARD_MODELS,
  CODEX_STANDARD_SERVICE_TIER,
  codexTransportModelId,
} from '@openclaude/protocol'
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
  // OCV5-434: no Fast on Codex (the backend ignores priority from our client; the user chose to
  // hide it rather than impersonate Codex CLI). GPT-6 turns state an explicit standard tier so
  // a catalog Fast default (GPT-6 Luna) never applies.
  if (CODEX_EXPLICIT_STANDARD_MODELS.has(opts.model ?? '')) {
    params.serviceTierForTurn = CODEX_STANDARD_SERVICE_TIER
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
