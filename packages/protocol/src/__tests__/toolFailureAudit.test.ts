import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { classifyToolFailureError, isToolFailureErrorClass } from '../toolFailureAudit.js'

describe('classifyToolFailureError', () => {
  test('maps representative runtime errors to bounded categories', () => {
    assert.equal(
      classifyToolFailureError('Unknown skill: macro-investment-framework'),
      'unknown_skill',
    )
    assert.equal(classifyToolFailureError('/bin/sh: file: command not found'), 'command_not_found')
    assert.equal(classifyToolFailureError('spawn /vendor/ripgrep/rg ENOENT'), 'file_not_found')
    assert.equal(classifyToolFailureError('request timed out after 30s'), 'timeout')
    assert.equal(classifyToolFailureError('HTTP 503 Service Unavailable'), 'service_unavailable')
    assert.equal(classifyToolFailureError('Authorization: Bearer secret-token'), 'other')
    assert.equal(classifyToolFailureError(undefined), 'other')
  })
})

describe('isToolFailureErrorClass', () => {
  test('accepts only the bounded public category enum', () => {
    assert.equal(isToolFailureErrorClass('timeout'), true)
    assert.equal(isToolFailureErrorClass('raw private error'), false)
    assert.equal(isToolFailureErrorClass(null), false)
  })
})
