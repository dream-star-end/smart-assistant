import { IdentityCompatError, parseIdentityCompatProjection } from '@openclaude/protocol'
import { buildAgentSkillStore, buildRunSkillStore, type SkillStore } from '@openclaude/storage'

/** Consume only the execution context derived by the gateway's authenticated gate.
 * This is NOT a registration source or a readiness cache. The projection wrapper
 * below reuses wire shape validation; no readiness decision is made by MCP.
 */
export function buildMcpSkillStore(env: NodeJS.ProcessEnv = process.env): SkillStore {
  const agentId = env.OPENCLAUDE_AGENT_ID ?? 'main'
  const raw = env.OC_IDENTITY_COMPAT_PROFILE
  let compat: Parameters<typeof buildAgentSkillStore>[1]
  if (raw !== undefined && raw !== '') {
    let profile: unknown
    try { profile = JSON.parse(raw) } catch {
      throw new IdentityCompatError('COMPAT_CONFIG_CONFLICT', 'invalid execution identity profile JSON')
    }
    const uid = env.OC_USER_ID ?? ''
    const parsed = parseIdentityCompatProjection({ schema: 1, userId: uid, profiles: [{ profile, readiness: 'ready' }] }, uid)
    const validated = parsed.profiles[0]!.profile
    if (validated.canonicalAgentId !== agentId) {
      throw new IdentityCompatError('COMPAT_CONFIG_CONFLICT', 'execution identity profile does not match MCP agent')
    }
    compat = { profile: validated }
  }
  const projectId = (env.OPENCLAUDE_PROJECT_ID ?? '').trim()
  return projectId ? buildRunSkillStore({ agentId, projectId, compat }) : buildAgentSkillStore(agentId, compat)
}
