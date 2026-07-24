import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DEFAULT_AUTO_DREAM_MODEL,
  isAutoDreamOptimizerModel,
} from '../billing/autoDreamModels.js'

describe('isAutoDreamOptimizerModel', () => {
  test('defaults Auto-Dream V2 to DeepSeek V4 Flash', () => {
    assert.equal(DEFAULT_AUTO_DREAM_MODEL, 'deepseek-v4-flash')
  })

  test('accepts only the rollback-compatible Terra/Codex and DeepSeek/CCB pairs', () => {
    assert.equal(isAutoDreamOptimizerModel('gpt-5.6-terra', 'gpt-5.6-terra', 'codex'), true)
    assert.equal(isAutoDreamOptimizerModel('deepseek-v4-flash', 'deepseek-v4-flash', 'ccb'), true)
    assert.equal(isAutoDreamOptimizerModel('gpt-5.6-terra', 'gpt-5.6-terra', 'ccb'), false)
    assert.equal(
      isAutoDreamOptimizerModel('deepseek-v4-flash', 'deepseek-v4-flash', 'codex'),
      false,
    )
    assert.equal(isAutoDreamOptimizerModel('deepseek-v4-pro', 'deepseek-v4-pro', 'ccb'), false)
    assert.equal(isAutoDreamOptimizerModel('deepseek-v4-flash', 'deepseek-v4-pro', 'ccb'), false)
  })
})
