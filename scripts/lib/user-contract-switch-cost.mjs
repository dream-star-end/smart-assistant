const modes = new Set(['exempt', 'estimate', 'risk'])
const validProof = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.trim() === value

/** Explicit canary approval through the public API; never manufacture or log a grant. */
export async function authorizeContractModelSwitch(api, input) {
  const { sessionId, ...request } = input
  const path = `/api/me/sessions/${encodeURIComponent(sessionId)}/model-switch-estimate`
  const read = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.requestId !== request.requestId || value.targetModel !== request.targetModel ||
        !modes.has(value.mode) || typeof value.requiresConfirmation !== 'boolean' ||
        typeof value.canConfirm !== 'boolean' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now())
      throw new Error('Invalid model-switch quote')
    if (!value.canConfirm) throw new Error('Model-switch quote cannot be confirmed')
    return value
  }
  const post = body => api(path, { method: 'POST', body: JSON.stringify(body) })
  const quote = read(await post(request))
  if (!quote.requiresConfirmation) return { mode: quote.mode, confirmed: false }
  if (!validProof(quote.quoteToken)) throw new Error('Model-switch quote has no valid confirmation proof')
  const confirmed = read(await post({ ...request, quoteToken: quote.quoteToken }))
  if (confirmed.mode !== quote.mode || confirmed.requiresConfirmation || !validProof(confirmed.consent))
    throw new Error('Model-switch confirmation did not authorize the turn')
  return { mode: confirmed.mode, confirmed: true, consent: confirmed.consent }
}
