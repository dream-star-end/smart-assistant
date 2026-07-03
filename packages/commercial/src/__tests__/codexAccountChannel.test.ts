import * as assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { getCodexAccountRuntimeChannel } from '../codexAccountChannel.js'

const original = process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL

afterEach(() => {
  if (original === undefined) delete process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL
  else process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = original
})

describe('codex account runtime channel override', () => {
  it('defaults to v3 for existing commercial v3 deployments', () => {
    delete process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL
    assert.equal(getCodexAccountRuntimeChannel(), 'v3')
  })

  it('allows v3 master to consume the v5-owned codex account pool explicitly', () => {
    process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = ' v5 '
    assert.equal(getCodexAccountRuntimeChannel(), 'v5')
  })

  it('fail-closes invalid channel values', () => {
    process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = 'master'
    assert.throws(() => getCodexAccountRuntimeChannel(), /OC_CODEX_ACCOUNT_RUNTIME_CHANNEL/)
  })
})
