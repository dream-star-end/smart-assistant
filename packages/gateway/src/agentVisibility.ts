export const HIDDEN_SYSTEM_AGENT_IDS = new Set<string>(['hidden-reviewer'])

export function isHiddenSystemAgentId(agentId: string): boolean {
  return HIDDEN_SYSTEM_AGENT_IDS.has(agentId)
}

export function filterUserVisibleAgentsForManagement<T extends { id?: unknown }>(
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => typeof agent.id !== 'string' || !isHiddenSystemAgentId(agent.id))
}

export function filterUserVisibleRoutesForManagement<T extends { agent?: unknown }>(
  routes: readonly T[],
): T[] {
  return routes.filter((route) => typeof route.agent !== 'string' || !isHiddenSystemAgentId(route.agent))
}

export function userVisibleDefaultAgentId(defaultAgentId: unknown): string {
  return typeof defaultAgentId === 'string' && !isHiddenSystemAgentId(defaultAgentId)
    ? defaultAgentId
    : 'main'
}
