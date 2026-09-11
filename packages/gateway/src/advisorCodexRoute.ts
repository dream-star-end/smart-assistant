/**
 * Parse master-owned advisor admit route metadata.
 * Gateway later fills loopback using this process's listen port.
 */

const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type AdvisorAdmitRouteOk =
  | { kind: 'official_oauth'; groupId?: string }
  | {
      kind: 'api_relay'
      token: string
      modelProvider: string
      providerName?: string | null
      wireApi?: 'responses' | 'chat' | null
      preferredAuthMethod?: 'apikey' | 'chatgpt' | null
      disableResponseStorage?: boolean | null
    }

export type ParseAdvisorAdmitRoute =
  | { ok: true; route: AdvisorAdmitRouteOk }
  | { ok: false; reason: 'missing' | 'unavailable' | 'invalid' }

export function parseAdvisorAdmitRoute(raw: unknown): ParseAdvisorAdmitRoute {
  if (raw === undefined || raw === null) return { ok: false, reason: 'missing' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'invalid' }
  const r = raw as Record<string, unknown>
  if (r.kind === 'unavailable') return { ok: false, reason: 'unavailable' }
  if (r.kind === 'official_oauth') {
    const keys = Object.keys(r)
    if (keys.some((k) => k !== 'kind' && k !== 'groupId')) return { ok: false, reason: 'invalid' }
    if (r.groupId !== undefined && (typeof r.groupId !== 'string' || r.groupId.length > 20)) {
      return { ok: false, reason: 'invalid' }
    }
    return {
      ok: true,
      route: {
        kind: 'official_oauth',
        ...(typeof r.groupId === 'string' ? { groupId: r.groupId } : {}),
      },
    }
  }
  if (r.kind === 'api_relay') {
    // Master must not send a client-controllable or hardcoded baseUrl.
    if ('baseUrl' in r) return { ok: false, reason: 'invalid' }
    if (typeof r.token !== 'string' || !ROUTE_TOKEN_RE.test(r.token)) return { ok: false, reason: 'invalid' }
    if (typeof r.modelProvider !== 'string' || !PROVIDER_ID_RE.test(r.modelProvider)) {
      return { ok: false, reason: 'invalid' }
    }
    return {
      ok: true,
      route: {
        kind: 'api_relay',
        token: r.token,
        modelProvider: r.modelProvider,
        providerName: typeof r.providerName === 'string' ? r.providerName : null,
        wireApi: r.wireApi === 'responses' || r.wireApi === 'chat' ? r.wireApi : null,
        preferredAuthMethod:
          r.preferredAuthMethod === 'apikey' || r.preferredAuthMethod === 'chatgpt'
            ? r.preferredAuthMethod
            : null,
        disableResponseStorage:
          typeof r.disableResponseStorage === 'boolean' ? r.disableResponseStorage : null,
      },
    }
  }
  return { ok: false, reason: 'invalid' }
}
