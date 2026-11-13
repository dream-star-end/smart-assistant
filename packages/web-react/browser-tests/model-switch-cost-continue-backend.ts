/**
 * Node-side entry for the OCV5-742 browser case: the real backend quote service
 * (real reader, real exempt/risk decision, real HMAC quote/consent grants) over a
 * scripted Postgres surface.
 *
 * The scripted pool only answers the reader's queries. It does not invent a
 * quote: removing the failed-start fallback from the reader makes the "same
 * model continue" scenario return a risk quote again, which the browser test
 * then observes as a confirmation dialog.
 */
import type { Pool } from 'pg'
import type { ModelPricing, PricingCache } from '../../commercial/src/billing/pricing.js'
import { ModelSwitchCostService } from '../../commercial/src/billing/modelSwitchCost.js'

const UID = '742'
const SESSION = 's-crash'
const TAPE_ID = 'tape-1'
const FAILED_MESSAGE_ID = 'msg-1'
const SHA = 'b'.repeat(64)

const CRASH_USAGE = {
  model: 'cheap',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

const crashedTape = {
  tape_id: TAPE_ID,
  tape_sha256: SHA,
  agent_id: 'main',
  status: 'crashed',
  usage: CRASH_USAGE,
  created_at: '1',
  finalized_at: '2',
  client_message_id: FAILED_MESSAGE_ID,
}

// The failed turn left exactly its own user row and this tape's anchor row.
const failedRow = {
  dispatch_id: 'd-1',
  tape_sha256: SHA,
  model: 'cheap',
  agent_id: 'main',
  messages: JSON.stringify([
    { role: 'user', id: FAILED_MESSAGE_ID },
    { id: 'anchor', role: 'assistant', _source: 'server', _turnTapeId: TAPE_ID, _turnTapeSha256: SHA, _turnTapeComplete: true },
  ]),
}

function scriptedPool(): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('model-switch-failed-start')) return { rows: [failedRow] }
      if (sql.includes('model-switch-latest-tape'))
        return {
          rows: [
            {
              tape_id: crashedTape.tape_id,
              tape_sha256: crashedTape.tape_sha256,
              parent_turn_key: null,
              continuation_of_turn_key: null,
            },
          ],
        }
      if (sql.includes('model-switch-session-meta'))
        return {
          rows: [
            {
              history_revision: '3',
              timeline_generation: '1',
              has_content: true,
              deleted_at: null,
              archived: false,
            },
          ],
        }
      if (sql.includes('FROM client_session_turn_tapes')) return { rows: [crashedTape] }
      return { rows: [] }
    },
  } as unknown as Pool
}

const pricing = (model: string): ModelPricing =>
  ({
    model_id: model,
    display_name: model,
    input_per_mtok: model === 'cheap' ? 100n : 500n,
    output_per_mtok: model === 'cheap' ? 1000n : 3000n,
    cache_read_per_mtok: model === 'cheap' ? 10n : 50n,
    cache_write_per_mtok: 0n,
    multiplier: '1.000',
    enabled: true,
    sort_order: 0,
  }) as unknown as ModelPricing

export function createQuoteService(): ModelSwitchCostService {
  return new ModelSwitchCostService({
    pool: scriptedPool(),
    pricing: { get: (model: string) => pricing(model) } as unknown as PricingCache,
    secret: 'ocv5-742-browser-fixture',
    resolveTarget: async (_uid, model) => ({
      pricing: pricing(model),
      engine: 'ccb',
      contextWindow: 200000,
      canonicalize: (source: string) => source,
    }),
    sourceEngine: () => 'ccb',
    balance: async () => 10000n,
  })
}

export interface QuoteRequest {
  input: Record<string, unknown> & { requestId: string; targetModel: string }
  proof?: { quoteToken?: string; consent?: string }
}

/** Same dispatch the HTTP route performs: confirm when a quote token is presented. */
export async function handleQuote(
  service: ModelSwitchCostService,
  body: QuoteRequest,
): Promise<unknown> {
  const input = { ...body.input, agentId: body.input.agentId ?? 'main' }
  if (body.proof?.quoteToken)
    return service.confirm(UID, input as never, body.proof.quoteToken)
  return service.quote(UID, input as never, body.proof?.consent)
}

export const FIXTURE = { uid: UID, sessionId: SESSION, tapeId: TAPE_ID }
