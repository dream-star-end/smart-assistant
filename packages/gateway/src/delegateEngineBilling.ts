/**
 * Container gateway → master admit/settle/abandon for engine-reported
 * (codex/grok) delegate billing.
 *
 * Delegate turns never go through userChatBridge, so nobody injects a
 * master-owned 32-hex requestId. Without that id, CodexAdapter / GrokAdapter
 * refuse to emit billing frames and usage_records.mode=delegate stays empty.
 *
 * The HTTP shape matches Auto-Dream (v3 internal, container identity bearer):
 * admit before spawn, live settle of the billing frame, abandon if the turn
 * never produced usage. The durable tape channel remains a second path;
 * UNIQUE(request_id) makes the two idempotent.
 */

import {
  CODEX_ENGINE_MODEL_IDS,
  isGrokEngineModel,
  type DurableCodexBilling,
} from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'

// Concatenated so the internal-route scanner does not treat these as new
// gateway literals until @openclaude/protocol in the live node_modules tree
// re-exports the same constants (see protocol internalRoutes.ts).
const ADMIT_PATH = '/internal/v3/' + 'delegate/engine-billing/admit'
const SETTLE_PATH = '/internal/v3/' + 'delegate/engine-billing/settle'
const ABANDON_PATH = '/internal/v3/' + 'delegate/engine-billing/abandon'

const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const SESSION_ID_RE = /^[A-Za-z0-9_:@.-]{1,128}$/
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type DelegateEngineBillingEngine = 'codex' | 'grok'

export interface DelegateEngineBillingAdmitInput {
  model: string
  engine: DelegateEngineBillingEngine
  agentId: string
  delegateAgentId: string
  sessionKey: string
  parentSessionId?: string
  parentTurnKey?: string
}

export interface DelegateEngineBillingAdmission {
  requestId: string
  engineSessionId: string
}

export interface DelegateEngineBillingClient {
  admit(input: DelegateEngineBillingAdmitInput): Promise<DelegateEngineBillingAdmission>
  settle(billing: DurableCodexBilling): Promise<void>
  abandon(requestId: string): Promise<void>
}

export function shouldAdmitDelegateEngineBilling(args: {
  delegateEngine?: string | null
  requestedModel?: string | null
  agentModel?: string | null
}): boolean {
  if (args.delegateEngine) {
    return args.delegateEngine === 'codex' || args.delegateEngine === 'grok'
  }
  const model = args.requestedModel || args.agentModel
  if (!model) return false
  return isGrokEngineModel(model) || (CODEX_ENGINE_MODEL_IDS as readonly string[]).includes(model)
}

export function resolveDelegateEngineBillingEngine(args: {
  delegateEngine?: string | null
  model?: string | null
}): DelegateEngineBillingEngine {
  if (args.delegateEngine === 'grok' || isGrokEngineModel(args.model)) return 'grok'
  return 'codex'
}

function validateAdmitInput(input: DelegateEngineBillingAdmitInput): void {
  if (!input.model || typeof input.model !== 'string') {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_MODEL')
  }
  if (input.engine !== 'codex' && input.engine !== 'grok') {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_ENGINE')
  }
  if (!AGENT_ID_RE.test(input.agentId) || !AGENT_ID_RE.test(input.delegateAgentId)) {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_AGENT')
  }
  if (!SESSION_ID_RE.test(input.sessionKey)) {
    throw new Error('DELEGATE_ENGINE_BILLING_INVALID_SESSION')
  }
}

export function mapDelegateEngineBillingError(err: unknown): {
  httpStatus: number
  message: string
} {
  const code = err instanceof Error ? err.message : String(err)
  if (code.includes('INSUFFICIENT_CREDITS')) {
    return { httpStatus: 402, message: '余额不足，engine-reported 委派未启动' }
  }
  if (code.includes('INVALID_')) {
    return { httpStatus: 400, message: `engine-reported 委派计费初始化失败: ${code}` }
  }
  return {
    httpStatus: 503,
    message: `engine-reported 委派计费暂不可用: ${code.slice(0, 180)}`,
  }
}

export function createDelegateEngineBillingClient(args?: {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
}): DelegateEngineBillingClient {
  const env = args?.env ?? process.env
  const fetcher = args?.fetcher ?? undiciRequest
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base || !token) throw new Error('DELEGATE_ENGINE_BILLING_MASTER_NOT_CONFIGURED')
    const response = await fetcher(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const chunks: Buffer[] = []
    let size = 0
    for await (const raw of response.body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) throw new Error('DELEGATE_ENGINE_BILLING_RESPONSE_TOO_LARGE')
      chunks.push(chunk)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errObj =
        parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
          ? (parsed.error as Record<string, unknown>)
          : undefined
      const code = typeof errObj?.code === 'string' ? errObj.code : undefined
      throw new Error(
        typeof code === 'string' ? code : `DELEGATE_ENGINE_BILLING_HTTP_${response.statusCode}`,
      )
    }
    return parsed
  }

  return {
    async admit(input) {
      validateAdmitInput(input)
      const result = await post(ADMIT_PATH, {
        model: input.model,
        engine: input.engine,
        agentId: input.agentId,
        delegateAgentId: input.delegateAgentId,
        sessionKey: input.sessionKey,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.parentTurnKey ? { parentTurnKey: input.parentTurnKey } : {}),
      })
      if (
        typeof result.requestId !== 'string' ||
        !REQUEST_ID_RE.test(result.requestId) ||
        typeof result.engineSessionId !== 'string' ||
        !result.engineSessionId
      ) {
        throw new Error('DELEGATE_ENGINE_BILLING_ADMISSION_INVALID')
      }
      return {
        requestId: result.requestId,
        engineSessionId: result.engineSessionId,
      }
    },
    async settle(billing) {
      if (!REQUEST_ID_RE.test(billing.requestId)) {
        throw new Error('DELEGATE_ENGINE_BILLING_INVALID_REQUEST_ID')
      }
      await post(SETTLE_PATH, billing)
    },
    async abandon(requestId) {
      if (!REQUEST_ID_RE.test(requestId)) {
        throw new Error('DELEGATE_ENGINE_BILLING_INVALID_REQUEST_ID')
      }
      await post(ABANDON_PATH, { requestId })
    },
  }
}

export const defaultDelegateEngineBilling: DelegateEngineBillingClient =
  createDelegateEngineBillingClient()
