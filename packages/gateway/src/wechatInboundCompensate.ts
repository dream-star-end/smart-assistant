/**
 * WeChat inbound compensation request validation and WeChat start outcome
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-533); server.ts re-exports
 * these names, so importers are unchanged.
 */


export type WechatStartOutcome = {
  accepted?: boolean
  started: boolean
  completed?: boolean
  traceId?: string
  sessionKey?: string
  peerId?: string
  agentId?: string
}

// ── v3 WeChat broker inbound-compensate payload validation ──
// Pure validator used by handleWechatInboundCompensate (line ~2399). Exposed
// for unit testing without standing up a full Gateway. Returns either the
// typed payload or the 400-error string the route surfaces back to the
// broker dispatcher.

/** Shape of `/internal/v3/wechat-inbound-compensate` JSON body after validation. */
export interface WechatInboundCompensatePayload {
  /** `wsess-[0-9a-f]{16}` — broker-owned client_sessions row id from Step 2a write. */
  sessionId: string
  /** Decimal string of `wechat_bindings.user_id`. Container derives `c:<id>` for tenant scope. */
  bindingUserId: string
  /** Which dispatcher step failed; reason gets logged but doesn't affect deletion semantics. */
  reason: 'step2a_failed' | 'step2b_failed'
  /** Optional broker-side trace id (≤64 chars). */
  traceId?: string
}

export type WechatInboundCompensateValidation =
  | { ok: true; payload: WechatInboundCompensatePayload }
  | { ok: false; error: string }

export const COMPENSATE_SESSION_ID_RE = /^wsess-[0-9a-f]{16}$/

export const COMPENSATE_BINDING_USER_ID_RE = /^[1-9][0-9]{0,18}$/

export const COMPENSATE_TRACE_ID_MAX_LEN = 64

export function validateWechatInboundCompensateBody(
  parsed: unknown,
): WechatInboundCompensateValidation {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = parsed as Record<string, unknown>
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !COMPENSATE_SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: 'sessionId must match wsess-[0-9a-f]{16}' }
  }
  const bindingUserId = body.bindingUserId
  if (typeof bindingUserId !== 'string' || !COMPENSATE_BINDING_USER_ID_RE.test(bindingUserId)) {
    return { ok: false, error: 'bindingUserId must be a positive integer string' }
  }
  const reason = body.reason
  if (reason !== 'step2a_failed' && reason !== 'step2b_failed') {
    return { ok: false, error: "reason must be 'step2a_failed' or 'step2b_failed'" }
  }
  // traceId 可选;cap 64 chars 防 log 注入膨胀
  const traceId = body.traceId
  if (traceId !== undefined && (typeof traceId !== 'string' || traceId.length > COMPENSATE_TRACE_ID_MAX_LEN)) {
    return { ok: false, error: 'traceId must be string ≤64' }
  }
  return {
    ok: true,
    payload: {
      sessionId,
      bindingUserId,
      reason,
      ...(traceId !== undefined ? { traceId: traceId as string } : {}),
    },
  }
}
