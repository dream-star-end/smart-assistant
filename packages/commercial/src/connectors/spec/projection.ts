/** 只投影签名 ExecContract 中可公开的人向字段；绝不读取 raw spec/作者 proposed decision。 */
export function projectSignedConnectorContract(contract: unknown): {
  authMode: string
  approvedOrigins: string[]
  actions: Array<{ id: string; effect: string }>
} | null {
  if (!contract || typeof contract !== 'object') return null
  const c = contract as {
    authMode?: unknown
    credentialAudiencePolicy?: {
      apiOrigins?: unknown
      tokenOrigins?: unknown
      authorizationOrigins?: unknown
      unauthenticatedUploadOrigins?: unknown
    }
    actions?: unknown
  }
  if (typeof c.authMode !== 'string' || !Array.isArray(c.actions)) return null
  const origins = new Set<string>()
  const audience = c.credentialAudiencePolicy
  for (const list of [
    audience?.apiOrigins,
    audience?.tokenOrigins,
    audience?.authorizationOrigins,
    audience?.unauthenticatedUploadOrigins,
  ]) {
    if (Array.isArray(list))
      for (const origin of list) if (typeof origin === 'string') origins.add(origin)
  }
  const actions = c.actions.flatMap((a) => {
    if (!a || typeof a !== 'object') return []
    const item = a as { id?: unknown; effect?: unknown }
    return typeof item.id === 'string' && typeof item.effect === 'string'
      ? [{ id: item.id, effect: item.effect }]
      : []
  })
  return { authMode: c.authMode, approvedOrigins: [...origins], actions }
}
