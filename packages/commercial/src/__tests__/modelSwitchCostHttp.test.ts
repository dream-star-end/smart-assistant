import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { signAccess } from '../auth/jwt.js'
import { ModelSwitchCostError } from '../billing/modelSwitchCost.js'
import { handleModelSwitchCost } from '../http/modelSwitchCost.js'
import type { CommercialHttpDeps } from '../http/handlers.js'
import { HttpError } from '../http/util.js'

test('cost API returns 503 for unavailable pricing and preserves user-action statuses', async () => {
  const jwtSecret = 'model-switch-http-test-secret-only-32-bytes'
  const { token } = await signAccess({ sub: '765', role: 'user' }, jwtSecret)
  for (const stage of ['validateTarget', 'quote', 'confirm', 'missing']) {
    for (const [code, status] of [
      ['MODEL_SWITCH_UNAVAILABLE', 503],
      ['MODEL_SWITCH_QUOTE_CHANGED', 409],
      ['MODEL_SWITCH_INSUFFICIENT_BALANCE', 409],
      ['MODEL_SWITCH_CONFIRMATION_REQUIRED', 409],
      ['UNAUTHORIZED_MODEL', 403],
      ['MODEL_NOT_AVAILABLE', 404],
    ] as const) {
      if (stage === 'missing' && status !== 503) continue
      const req = Readable.from([
        Buffer.from(
          JSON.stringify({
            requestId: 'm-http-cost',
            targetModel: 'gpt-6-astra',
            agentId: 'main',
            ...(stage === 'confirm' ? { quoteToken: 'fixture-quote' } : {}),
          }),
        ),
      ]) as IncomingMessage
      req.headers = { authorization: `Bearer ${token}` }
      req.url = '/api/me/sessions/own/model-switch-estimate'
      const service = {
        validateTarget: async () => {},
        quote: async () => {},
        confirm: async () => {},
        [stage]: async () => {
          throw new ModelSwitchCostError(code, 'fixture refusal')
        },
      }
      await assert.rejects(
        handleModelSwitchCost(
          req,
          {} as ServerResponse,
          {
            jwtSecret,
            modelSwitchCost: stage === 'missing' ? undefined : service,
          } as unknown as CommercialHttpDeps,
        ),
        (e) => e instanceof HttpError && e.status === status && e.code === code,
      )
    }
  }
})
