/**
 * Product WebContentsView keeps the access JWT in renderer memory.
 * Refresh is the same cookie path as web-react `POST /api/auth/refresh`
 * (HttpOnly __Host-* cookie on the product partition).
 */
export function createSessionCookieFetch(electronSession) {
  if (!electronSession || typeof electronSession.fetch !== 'function') {
    return globalThis.fetch.bind(globalThis)
  }
  return (url, init = {}) => electronSession.fetch(url, { ...init, credentials: 'include' })
}

export async function refreshProductAccessToken({
  publicOrigin,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = String(publicOrigin || '').replace(/\/$/, '')
  if (!origin) return { ok: false, error: 'publicOrigin required' }
  const response = await fetchImpl(`${origin}/api/auth/refresh`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    return { ok: false, status: response.status }
  }
  let body
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: 'invalid-json' }
  }
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    return { ok: false, error: 'missing-token' }
  }
  return {
    ok: true,
    accessToken: body.access_token,
    accessExp: typeof body.access_exp === 'number' ? body.access_exp : undefined,
  }
}
