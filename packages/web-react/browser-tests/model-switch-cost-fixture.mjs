// Test-only authoritative quote for short fixture histories. Expensive/unknown
// consent is exercised separately by model-switch-cost.node-test.mjs.
export const fixtureExecutionModel = (frame) =>
  frame?.agentId === 'main' && frame?.teamMode ? 'gpt-6-astra' : (frame?.model ?? null)
export function fixtureSwitchQuote(input, options = {}) {
  const targetModel = fixtureExecutionModel({
    agentId: input.agentId,
    teamMode: input.teamMode,
    model: input.targetModel,
  })
  const sourceModel = options.empty ? null : (options.sourceModel ?? 'glm-5.2')
  const exempt = options.empty || sourceModel === targetModel
  return {
    mode: exempt ? 'exempt' : 'estimate',
    requestId: input.requestId,
    targetModel,
    targetName: targetModel,
    sourceModel,
    sourceName: sourceModel,
    contextSource: options.empty ? 'empty' : exempt ? 'unchanged' : 'last-call',
    contextTokens: exempt ? null : 1000,
    outputTokens: exempt ? null : 8,
    sampleCount: exempt ? 0 : 5,
    targetCost: exempt ? null : { lowCredits: '1', expectedCredits: '2', highCredits: '4' },
    currentCost: exempt ? null : { lowCredits: '1', expectedCredits: '1', highCredits: '2' },
    targetUnitPrice: exempt ? null : { input: '1', output: '1', cacheRead: '1', cacheWrite: '1' },
    balanceCredits: '1000',
    requiresConfirmation: false,
    canConfirm: true,
    expiresAt: Date.now() + 300000,
  }
}
