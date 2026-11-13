/**
 * OCV5-477: the master forwards OC_ADVISOR_OPEN_ENGINES to user containers only for known advisor engines.
 * Run: npx tsx --test packages/commercial/src/__tests__/advisorOpenEnginesEnv.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { advisorOpenEnginesEnv } from '../agent-sandbox/v3supervisor.js'

describe('advisorOpenEnginesEnv', () => {
  test('unset or empty stays closed (no env injected)', () => {
    assert.equal(advisorOpenEnginesEnv(undefined), null)
    assert.equal(advisorOpenEnginesEnv(''), null)
    assert.equal(advisorOpenEnginesEnv(' , '), null)
  })

  test('codex is forwarded, deduplicated', () => {
    assert.equal(advisorOpenEnginesEnv('codex'), 'OC_ADVISOR_OPEN_ENGINES=codex')
    assert.equal(advisorOpenEnginesEnv(' codex,codex '), 'OC_ADVISOR_OPEN_ENGINES=codex')
  })

  test('any unknown engine refuses the whole value (ccb advisors are per-model proven, not opened)', () => {
    assert.equal(advisorOpenEnginesEnv('codex,ccb'), null)
    assert.equal(advisorOpenEnginesEnv('grok'), null)
  })
})
