/** Immutable, metadata-only provenance for a user retry. Never a result/ACK authority. */
export type DelegateRetrySource = Readonly<{
  version: 1
  userId: string
  parentSessionKey: string
  parentClientSessionId: string
  originSessionKey: string
  childSessionKey: string
  targetAgentId: string
  sourceAgentId: string
  depth: number
  model: string | null
}>

export function checkedDelegateRetrySource(value: DelegateRetrySource): DelegateRetrySource {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.depth) || value.depth < 0 || value.depth > 5) {
    throw new Error('invalid delegate retry source')
  }
  const keys = ['userId', 'parentSessionKey', 'parentClientSessionId', 'originSessionKey',
    'childSessionKey', 'targetAgentId', 'sourceAgentId'] as const
  for (const key of keys) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 1024) {
      throw new Error('invalid delegate retry source identity')
    }
  }
  if (value.model !== null && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200)) {
    throw new Error('invalid delegate retry source model')
  }
  // Project an exact field set: callers cannot persist goal/result/credential extras.
  return Object.freeze({ version: 1, userId: value.userId, parentSessionKey: value.parentSessionKey,
    parentClientSessionId: value.parentClientSessionId, originSessionKey: value.originSessionKey,
    childSessionKey: value.childSessionKey, targetAgentId: value.targetAgentId,
    sourceAgentId: value.sourceAgentId, depth: value.depth, model: value.model })
}
