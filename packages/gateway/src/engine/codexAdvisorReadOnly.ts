/** Codex >= 0.159.2: environments:[] removes shell and apply_patch from
 * the native registry (both require has_environment in tools/spec_plan.rs).
 * These feature switches also remove tools that can mutate external state
 * without using that execution environment. Keep this independent of prompt
 * construction so even a legacy launch without platform context is restricted. */
import { ADVISOR_READ_ONLY_MCP_TOOLS } from '@openclaude/protocol'

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
