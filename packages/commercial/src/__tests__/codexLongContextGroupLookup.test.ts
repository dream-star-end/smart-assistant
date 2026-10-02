/**
 * Codex 1M twins are not account-group keys (0238/0288/0292). Group lookup
 * must use the standard transport id so a 1M turn still gets the
 * official_oauth route; otherwise Codex 0.159.2 spawns bare and fails with
 * "workspace routing discovery failed".
 *
 * Run: node --import tsx --test packages/commercial/src/__tests__/codexLongContextGroupLookup.test.ts
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { setPoolOverride, resetPool } from '../db/index.js'
import { groupLookupModelId, listEnabledGroupsForModel } from '../account-pool/groups.js'

const seen: unknown[][] = []
setPoolOverride({
  query: async (q: string, params: unknown[]) => {
    assert.ok(q.includes('gm.model_id = $1'))
    seen.push(params)
    return { rows: [] }
  },
  end: async () => {},
} as never)

after(async () => {
  await resetPool()
})

describe('codex 1M group lookup', () => {
  it('maps codex 1M twins to their standard group key', () => {
    assert.equal(groupLookupModelId('gpt-6.1-sol-1m', 'codex'), 'gpt-6.1-sol')
    assert.equal(groupLookupModelId('gpt-6-astra-1m', 'codex'), 'gpt-6-astra')
    assert.equal(groupLookupModelId('gpt-6-luna-1m', 'codex'), 'gpt-6-luna')
  })

  it('leaves standard ids and non-codex providers untouched', () => {
    assert.equal(groupLookupModelId('gpt-6.1-sol', 'codex'), 'gpt-6.1-sol')
    assert.equal(groupLookupModelId('gpt-6.1-sol-1m', 'grok'), 'gpt-6.1-sol-1m')
    assert.equal(groupLookupModelId('gpt-6.1-sol-1m'), 'gpt-6.1-sol-1m')
    assert.equal(groupLookupModelId('grok-build', 'codex'), 'grok-build')
  })

  it('listEnabledGroupsForModel queries the standard id for a 1M codex model', async () => {
    seen.length = 0
    await listEnabledGroupsForModel({ modelId: 'gpt-6.1-sol-1m', provider: 'codex' })
    await listEnabledGroupsForModel({ modelId: 'gpt-6.1-sol-1m', kind: 'api_relay', provider: 'codex' })
    assert.deepEqual(seen, [
      ['gpt-6.1-sol', 'codex'],
      ['gpt-6.1-sol', 'api_relay', 'codex'],
    ])
  })

  it('still rejects malformed model ids', () => {
    assert.throws(() => groupLookupModelId('bad id', 'codex'), /invalid_model_id/)
  })
})
