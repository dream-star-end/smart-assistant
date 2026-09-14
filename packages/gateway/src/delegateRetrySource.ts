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
  /** Captured from the trusted parent, never reconstructed from environment. */
  parentWorkspaceMode?: 'legacy' | 'isolated_v1'
}>

export type DelegateRetryActionKey = Readonly<{ userId: string; sourceJobId: string; generation: number; actionId: string }>
export type DelegateRetryAction = DelegateRetryActionKey & Readonly<{
  targetJobId: string
  state: 'accepted' | 'dispatched' | 'terminal' | 'source_deleted'
  createdAt: number
  dispatchedAt: number | null
  terminalCode: string | null
}>
/** Public retry errors are bounded codes, never native paths/result payloads. */
export class DelegateRetryUnavailable extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export function checkedDelegateRetryActionKey(key: DelegateRetryActionKey): DelegateRetryActionKey {
  if (!key || typeof key.userId !== 'string' || !key.userId.trim() || key.userId !== key.userId.trim() || key.userId.length > 1024 ||
      typeof key.sourceJobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.sourceJobId) || !Number.isSafeInteger(key.generation) || key.generation < 0 ||
      typeof key.actionId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(key.actionId)) throw new Error('invalid delegate retry action identity')
  return Object.freeze({ userId: key.userId, sourceJobId: key.sourceJobId, generation: key.generation, actionId: key.actionId })
}

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
  if (value.parentWorkspaceMode !== undefined && value.parentWorkspaceMode !== 'legacy' && value.parentWorkspaceMode !== 'isolated_v1') {
    throw new Error('invalid delegate retry parent workspace')
  }
  // Project an exact field set: callers cannot persist goal/result/credential extras.
  return Object.freeze({ version: 1, userId: value.userId, parentSessionKey: value.parentSessionKey,
    parentClientSessionId: value.parentClientSessionId, originSessionKey: value.originSessionKey,
    childSessionKey: value.childSessionKey, targetAgentId: value.targetAgentId,
    sourceAgentId: value.sourceAgentId, depth: value.depth, model: value.model,
    ...(value.parentWorkspaceMode === undefined ? {} : { parentWorkspaceMode: value.parentWorkspaceMode }) })
}

export type DelegateRetryAvailability = Readonly<{ available: boolean; reason: string | null }>
export type DelegateRetrySourceKey = Pick<DelegateRetryActionKey, 'userId' | 'sourceJobId' | 'generation'>
