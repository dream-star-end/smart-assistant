import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  classifyToolFailure,
  classifyToolFailureError,
  isToolExitCode,
  isToolFailureErrorClass,
  isToolFailureKind,
  isToolTerminationReason,
} from '../toolFailureAudit.js'

describe('classifyToolFailureError', () => {
  test('maps representative runtime errors to bounded categories', () => {
    assert.equal(
      classifyToolFailureError('Unknown skill: macro-investment-framework'),
      'unknown_skill',
    )
    assert.equal(classifyToolFailureError('/bin/sh: file: command not found'), 'command_not_found')
    assert.equal(classifyToolFailureError('spawn /vendor/ripgrep/rg ENOENT'), 'file_not_found')
    assert.equal(classifyToolFailureError('old_string was not found in the file'), 'edit_conflict')
    assert.equal(classifyToolFailureError('request timed out after 30s'), 'timeout')
    assert.equal(classifyToolFailureError('HTTP 503 Service Unavailable'), 'service_unavailable')
    assert.equal(classifyToolFailureError('Authorization: Bearer secret-token'), 'other')
    assert.equal(classifyToolFailureError(undefined), 'other')
  })
})

describe('classifyToolFailure', () => {
  test('trusts structured termination before exit code and text', () => {
    assert.deepEqual(
      classifyToolFailure({
        outputPreview: 'command not found',
        exitCode: 127,
        terminationReason: 'timeout',
      }),
      { errorClass: 'timeout', failureKind: 'timeout' },
    )
    assert.deepEqual(classifyToolFailure({ exitCode: 127, terminationReason: 'exit_code' }), {
      errorClass: 'command_not_found',
      failureKind: 'process_exit',
    })
    assert.deepEqual(classifyToolFailure({ exitCode: 126, terminationReason: 'exit_code' }), {
      errorClass: 'not_executable',
      failureKind: 'process_exit',
    })
    assert.deepEqual(classifyToolFailure({ exitCode: 2, terminationReason: 'exit_code' }), {
      errorClass: 'process_exit',
      failureKind: 'process_exit',
    })
    assert.deepEqual(classifyToolFailure({ terminationReason: 'signal' }), {
      errorClass: 'process_exit',
      failureKind: 'process_exit',
    })
    assert.deepEqual(classifyToolFailure({ terminationReason: 'exit_code' }), {
      errorClass: 'process_exit',
      failureKind: 'process_exit',
    })
    assert.deepEqual(
      classifyToolFailure({
        outputPreview: 'HTTP 503 Service Unavailable',
        terminationReason: 'tool_error',
      }),
      { errorClass: 'service_unavailable', failureKind: 'tool_error' },
    )
    assert.deepEqual(
      classifyToolFailure({
        outputPreview: 'bad request: invalid input',
        terminationReason: 'unknown',
      }),
      { errorClass: 'validation_error', failureKind: 'unknown' },
    )
  })

  test('maps regex-only classes to bounded kinds without inventing engine metadata', () => {
    assert.deepEqual(classifyToolFailure({ outputPreview: 'HTTP 503 Service Unavailable' }), {
      errorClass: 'service_unavailable',
      failureKind: 'external',
    })
    assert.deepEqual(classifyToolFailure({ outputPreview: 'bad request: invalid input' }), {
      errorClass: 'validation_error',
      failureKind: 'tool_error',
    })
    assert.deepEqual(classifyToolFailure({ outputPreview: 'opaque failure' }), {
      errorClass: 'other',
      failureKind: 'unknown',
    })
  })
})

describe('isToolFailureErrorClass', () => {
  test('accepts only the bounded public category enum', () => {
    assert.equal(isToolFailureErrorClass('timeout'), true)
    assert.equal(isToolFailureErrorClass('raw private error'), false)
    assert.equal(isToolFailureErrorClass(null), false)
    assert.equal(isToolFailureKind('external'), true)
    assert.equal(isToolFailureKind('platform'), false)
    assert.equal(isToolTerminationReason('exit_code'), true)
    assert.equal(isToolTerminationReason('oom'), false)
    assert.equal(isToolExitCode(127), true)
    assert.equal(isToolExitCode(256), false)
    assert.equal(isToolExitCode(1.5), false)
  })
})
