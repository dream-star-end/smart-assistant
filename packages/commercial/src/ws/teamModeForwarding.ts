import { DEFAULT_CODEX_ENGINE_MODEL } from '@openclaude/protocol'

/** Apply only after the bridge has resolved this turn as teamModeMain. */
export function applyTeamLeaderForwarding(frame: Record<string, unknown>): void {
  Object.assign(frame, {
    agentId: 'main',
    model: DEFAULT_CODEX_ENGINE_MODEL,
    effortLevel: 'high',
  })
}
