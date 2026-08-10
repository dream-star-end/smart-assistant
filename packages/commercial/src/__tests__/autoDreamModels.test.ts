import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_AUTO_DREAM_MODEL,
  LEGACY_AUTO_DREAM_MODEL,
  isAutoDreamOptimizerModel,
} from '../billing/autoDreamModels.js'

describe('isAutoDreamOptimizerModel', () => {
  test('unifies the optimizer and legacy memory organizer on MiniMax M3', () => {
    assert.equal(DEFAULT_AUTO_DREAM_MODEL, 'MiniMax-M3')
    assert.equal(LEGACY_AUTO_DREAM_MODEL, 'MiniMax-M3')
  })

  test('accepts only the rollback-compatible Terra/Codex and static-provider/CCB pairs', () => {
    assert.equal(isAutoDreamOptimizerModel('gpt-5.6-terra', 'gpt-5.6-terra', 'codex'), true)
    assert.equal(isAutoDreamOptimizerModel('deepseek-v4-flash', 'deepseek-v4-flash', 'ccb'), true)
    assert.equal(isAutoDreamOptimizerModel('MiniMax-M3', 'MiniMax-M3', 'ccb'), true)
    assert.equal(isAutoDreamOptimizerModel('gpt-5.6-terra', 'gpt-5.6-terra', 'ccb'), false)
    assert.equal(
      isAutoDreamOptimizerModel('deepseek-v4-flash', 'deepseek-v4-flash', 'codex'),
      false,
    )
    assert.equal(isAutoDreamOptimizerModel('MiniMax-M3', 'MiniMax-M3', 'codex'), false)
    assert.equal(isAutoDreamOptimizerModel('minimax-m3', 'MiniMax-M3', 'ccb'), false)
    assert.equal(isAutoDreamOptimizerModel('deepseek-v4-pro', 'deepseek-v4-pro', 'ccb'), false)
    assert.equal(isAutoDreamOptimizerModel('deepseek-v4-flash', 'deepseek-v4-pro', 'ccb'), false)
  })
})
