import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildHermeticDenial,
  HERMETIC_EXECUTION_DENY,
  isHermeticControlMethod,
} from '../engine/codexHermeticPolicy.js'

describe('codexHermeticPolicy', () => {
  it('denies command/file/permissions/MCP/user-input before any accept payload', () => {
    for (const method of HERMETIC_EXECUTION_DENY) {
      const denial = buildHermeticDenial(method)
      assert.ok(denial, method)
      const json = JSON.stringify(denial)
      assert.equal(json.includes('accept'), false, method)
      assert.equal(json.includes('acceptForSession'), false, method)
      assert.equal(json.includes('approved_for_session'), false, method)
    }
    assert.equal(isHermeticControlMethod('account/chatgptAuthTokens/refresh'), true)
    assert.equal(buildHermeticDenial('account/chatgptAuthTokens/refresh'), null)
    assert.equal(buildHermeticDenial('thread/start'), null)
  })
})
