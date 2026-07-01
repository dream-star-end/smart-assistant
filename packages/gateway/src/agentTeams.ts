import type { AgentDef, AgentTeamDef, AgentTeamMemberDef, AgentTeamPolicy } from '@openclaude/storage'

export const MAX_AGENT_TEAMS = 16
export const MAX_TEAM_MEMBERS = 8
export const TEAM_MAX_PARALLEL_CAP = 2
export const TEAM_ID_RE = /^[a-zA-Z0-9_-]+$/

export function sanitizeTeamText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
  return text || undefined
}

export function sanitizeTeamPrompt(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen)
  return text || undefined
}

export function normalizeTeamPolicy(input: any, agentIds: Set<string>): AgentTeamPolicy | undefined {
  if (!input || typeof input !== 'object') return undefined
  const policy: AgentTeamPolicy = {}
  if (input.maxParallel !== undefined) {
    const n = Number(input.maxParallel)
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('policy.maxParallel must be an integer >= 1')
    }
    policy.maxParallel = Math.min(n, TEAM_MAX_PARALLEL_CAP)
  }
  if (input.requireReview !== undefined) policy.requireReview = Boolean(input.requireReview)
  const reviewAgentId = sanitizeTeamText(input.reviewAgentId, 48)
  if (reviewAgentId) {
    if (!TEAM_ID_RE.test(reviewAgentId)) throw new Error('policy.reviewAgentId is invalid')
    if (!agentIds.has(reviewAgentId)) throw new Error(`review agent "${reviewAgentId}" not found`)
    policy.reviewAgentId = reviewAgentId
  }
  // fail-closed：requireReview 必须配合法 reviewAgentId，否则复核门形同虚设（Codex 审）。
  if (policy.requireReview && !policy.reviewAgentId) {
    throw new Error('policy.requireReview requires a valid policy.reviewAgentId')
  }
  return Object.keys(policy).length ? policy : undefined
}

export function normalizeAgentTeamInput(
  input: any,
  agents: readonly AgentDef[],
  existingTeams: readonly AgentTeamDef[],
  opts: { currentId?: string } = {},
): AgentTeamDef {
  if (!input || typeof input !== 'object') throw new Error('team body required')
  const agentIds = new Set(agents.map((a) => a.id))

  const id = sanitizeTeamText(input.id ?? opts.currentId, 48)
  if (!id || !TEAM_ID_RE.test(id)) throw new Error('invalid team id (use only a-z 0-9 _ -)')
  if (opts.currentId && id !== opts.currentId) throw new Error('team id cannot be changed')
  if (!opts.currentId && existingTeams.length >= MAX_AGENT_TEAMS) {
    throw new Error(`too many teams (max ${MAX_AGENT_TEAMS})`)
  }
  const duplicate = existingTeams.find((t) => t.id === id)
  if (duplicate && duplicate.id !== opts.currentId) throw new Error('team already exists')

  const name = sanitizeTeamText(input.name, 80)
  if (!name) throw new Error('team name required')

  const leaderAgentId = sanitizeTeamText(input.leaderAgentId, 48)
  if (!leaderAgentId || !TEAM_ID_RE.test(leaderAgentId)) throw new Error('leaderAgentId is invalid')
  if (!agentIds.has(leaderAgentId)) throw new Error(`leader agent "${leaderAgentId}" not found`)

  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new Error('members must be a non-empty array')
  }
  if (input.members.length > MAX_TEAM_MEMBERS) {
    throw new Error(`too many members (max ${MAX_TEAM_MEMBERS})`)
  }
  const seenMembers = new Set<string>()
  const members: AgentTeamMemberDef[] = input.members.map((m: any) => {
    const agentId = sanitizeTeamText(m?.agentId, 48)
    if (!agentId || !TEAM_ID_RE.test(agentId)) throw new Error('member agentId is invalid')
    if (!agentIds.has(agentId)) throw new Error(`member agent "${agentId}" not found`)
    if (seenMembers.has(agentId)) throw new Error(`duplicate member "${agentId}"`)
    seenMembers.add(agentId)
    const member: AgentTeamMemberDef = { agentId }
    const role = sanitizeTeamText(m?.role, 40)
    const responsibility = sanitizeTeamText(m?.responsibility, 200)
    const rolePrompt = sanitizeTeamPrompt(m?.rolePrompt, 1200)
    if (role) member.role = role
    if (responsibility) member.responsibility = responsibility
    if (rolePrompt) member.rolePrompt = rolePrompt
    return member
  })

  const team: AgentTeamDef = {
    id,
    name,
    leaderAgentId,
    members,
    updatedAt: new Date().toISOString(),
  }
  const description = sanitizeTeamText(input.description, 300)
  if (description) team.description = description
  const leaderRole = sanitizeTeamText(input.leaderRole, 40)
  if (leaderRole) team.leaderRole = leaderRole
  const leaderPrompt = sanitizeTeamPrompt(input.leaderPrompt, 1200)
  if (leaderPrompt) team.leaderPrompt = leaderPrompt
  const policy = normalizeTeamPolicy(input.policy, agentIds)
  if (policy) team.policy = policy
  return team
}
