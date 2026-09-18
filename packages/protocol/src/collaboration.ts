/**
 * Main-agent collaboration mode (solo / advisor / team).
 *
 * Wire name is `collabMode`, never `collaborationMode`: Codex native runtime
 * payloads use that name and pgSessionsBackend strips it as a private field.
 */
export const COLLABORATION_MODES = ['solo', 'advisor', 'team'] as const
export type CollaborationMode = (typeof COLLABORATION_MODES)[number]

export const DEFAULT_ADVISOR_MODEL = 'gpt-6-astra'
export const ADVISOR_AGENT_ID = 'advisor'
export const HIDDEN_REVIEWER_AGENT_ID = 'hidden-reviewer'

export const CONSULT_INVOCATION_HEADER = 'x-openclaude-consult-invocation'

export function isCollaborationMode(value: unknown): value is CollaborationMode {
  return value === 'solo' || value === 'advisor' || value === 'team'
}

/**
 * Single priority: explicit collabMode wins. Legacy teamMode=true maps to team
 * only when collabMode is omitted. Conflicting teamMode is ignored.
 */
export function normalizeCollabMode(input: {
  collabMode?: unknown
  teamMode?: unknown
}): CollaborationMode {
  if (isCollaborationMode(input.collabMode)) return input.collabMode
  if (input.teamMode === true) return 'team'
  return 'solo'
}

export function collabModeToTeamMode(mode: CollaborationMode): boolean {
  return mode === 'team'
}

export function collabConfigVersionOf(input: {
  mode: CollaborationMode
  advisorModel?: string | null
}): string {
  const model = input.mode === 'advisor' ? (input.advisorModel ?? '').trim() : ''
  return `v1:${input.mode}:${model}`
}
