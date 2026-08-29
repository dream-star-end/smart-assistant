import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  TOOL_FAILED_EMPTY_SENTINEL,
  TOOL_FAILED_REDACTED_SENTINEL,
  classifyToolFailure,
  classifyToolFailureError,
  codePointLength,
  isLegacyToolFailureErrorClass,
  isToolExitCode,
  isToolFailureErrorClass,
  isToolFailureKind,
  isToolTerminationReason,
  projectClassToLegacy,
  sanitizeToolFailureErrorMsg,
  synthesizeEmptyFailedToolPreview,
  truncateCodePoints,
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
    assert.equal(classifyToolFailureError(undefined), 'empty_output')
    assert.equal(classifyToolFailureError(''), 'empty_output')
    assert.equal(classifyToolFailureError('No task found with ID: abc'), 'task_not_found')
    assert.equal(classifyToolFailureError('task 455287 already killed'), 'task_dead')
    assert.equal(
      classifyToolFailureError(
        'TaskOutput: empty failed output task_id=455287 engine=cursor status=failed',
      ),
      'empty_output',
    )
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
    assert.deepEqual(classifyToolFailure({ outputPreview: '' }), {
      errorClass: 'empty_output',
      failureKind: 'unknown',
    })
    assert.deepEqual(
      classifyToolFailure({
        outputPreview: 'TaskOutput: empty failed output task_id=x engine=grok status=failed',
        terminationReason: 'tool_error',
      }),
      { errorClass: 'empty_output', failureKind: 'unknown' },
    )
    assert.deepEqual(classifyToolFailure({ outputPreview: 'No task found with ID: xyz' }), {
      errorClass: 'task_not_found',
      failureKind: 'tool_error',
    })
    assert.deepEqual(classifyToolFailure({ outputPreview: 'task xyz already killed' }), {
      errorClass: 'task_dead',
      failureKind: 'tool_error',
    })
  })
})

describe('isToolFailureErrorClass', () => {
  test('accepts only the bounded public category enum', () => {
    assert.equal(isToolFailureErrorClass('timeout'), true)
    assert.equal(isToolFailureErrorClass('empty_output'), true)
    assert.equal(isToolFailureErrorClass('task_not_found'), true)
    assert.equal(isToolFailureErrorClass('task_dead'), true)
    assert.equal(isToolFailureErrorClass('raw private error'), false)
    assert.equal(isToolFailureErrorClass('invented_fourth'), false)
    assert.equal(isToolFailureErrorClass(null), false)
    assert.equal(isLegacyToolFailureErrorClass('timeout'), true)
    assert.equal(isLegacyToolFailureErrorClass('empty_output'), false)
    assert.equal(isToolFailureKind('external'), true)
    assert.equal(isToolFailureKind('platform'), false)
    assert.equal(isToolTerminationReason('exit_code'), true)
    assert.equal(isToolTerminationReason('oom'), false)
    assert.equal(isToolExitCode(127), true)
    assert.equal(isToolExitCode(256), false)
    assert.equal(isToolExitCode(1.5), false)
    assert.equal(projectClassToLegacy('empty_output'), 'other')
    assert.equal(projectClassToLegacy('task_not_found'), 'other')
    assert.equal(projectClassToLegacy('task_dead'), 'other')
    assert.equal(projectClassToLegacy('timeout'), 'timeout')
  })
})

describe('sanitizeToolFailureErrorMsg', () => {
  test('empty input becomes empty_output sentinel', () => {
    assert.deepEqual(sanitizeToolFailureErrorMsg(undefined), {
      errorMsg: TOOL_FAILED_EMPTY_SENTINEL,
      redactedReason: 'empty',
    })
    assert.deepEqual(sanitizeToolFailureErrorMsg('   '), {
      errorMsg: TOOL_FAILED_EMPTY_SENTINEL,
      redactedReason: 'empty',
    })
  })

  test('allowlist command-not-found passes without redacted_reason', () => {
    const result = sanitizeToolFailureErrorMsg('/bin/sh: file: command not found')
    assert.equal(result.errorMsg.includes('command not found'), true)
    assert.equal(result.redactedReason, undefined)
  })

  test('truncated PEM without END is fully redacted and never stores key material', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC' + 'A'.repeat(80)
    const result = sanitizeToolFailureErrorMsg(pem)
    assert.equal(result.errorMsg, TOOL_FAILED_REDACTED_SENTINEL)
    assert.ok(result.redactedReason === 'secret_pattern' || result.redactedReason === 'unmatched_template')
    assert.equal(result.errorMsg.includes('BEGIN'), false)
    assert.equal(result.errorMsg.includes('MIIE'), false)
    assert.equal(result.errorMsg.includes('PRIVATE KEY'), false)
  })

  test('Authorization Bearer does not leave the secret', () => {
    const result = sanitizeToolFailureErrorMsg('Authorization: Bearer super-secret-token-value')
    assert.equal(result.errorMsg.includes('super-secret-token-value'), false)
    assert.equal(result.errorMsg, TOOL_FAILED_REDACTED_SENTINEL)
    assert.ok(result.redactedReason === 'secret_pattern' || result.redactedReason === 'unmatched_template')
  })

  test('JWT, password=, and unmatched dumps become redacted_output', () => {
    const jwt = sanitizeToolFailureErrorMsg(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturexx',
    )
    assert.equal(jwt.errorMsg, TOOL_FAILED_REDACTED_SENTINEL)
    assert.equal(jwt.errorMsg.includes('eyJ'), false)

    const password = sanitizeToolFailureErrorMsg('login failed password=hunter2 extra')
    assert.equal(password.errorMsg, TOOL_FAILED_REDACTED_SENTINEL)
    assert.equal(password.errorMsg.includes('hunter2'), false)

    const dump = sanitizeToolFailureErrorMsg('random dump from a core file with no known template')
    assert.equal(dump.errorMsg, TOOL_FAILED_REDACTED_SENTINEL)
    assert.equal(dump.redactedReason, 'unmatched_template')
    assert.equal(dump.errorMsg.includes('core file'), false)
  })

  test('home paths are always redacted', () => {
    const result = sanitizeToolFailureErrorMsg('command not found /home/alice/.ssh/id_rsa')
    assert.equal(result.errorMsg.includes('/home/alice'), false)
    assert.match(result.errorMsg, /\/home\/\[user\]/)
  })

  test('counts length in Unicode code points; 120/121 emoji do not truncate, 241 does', () => {
    const emoji = '😀'
    assert.equal(codePointLength(emoji), 1)
    assert.equal(emoji.length, 2)
    assert.equal(truncateCodePoints(emoji.repeat(120), 240), emoji.repeat(120))
    assert.equal(truncateCodePoints(emoji.repeat(121), 240), emoji.repeat(121))
    const truncated = truncateCodePoints(emoji.repeat(241), 240)
    assert.equal(codePointLength(truncated), 240)
    assert.ok(truncated.endsWith('…[truncated]'))

    const longAllowlist = `command not found ${emoji.repeat(250)}`
    const sanitized = sanitizeToolFailureErrorMsg(longAllowlist)
    assert.equal(codePointLength(sanitized.errorMsg), 240)
    assert.ok(sanitized.errorMsg.endsWith('…[truncated]'))
    assert.equal(sanitized.errorMsg.includes('command not found'), true)
  })

  test('synthesized TaskOutput empty-failed preview stays empty_output, not task_dead', () => {
    const preview = synthesizeEmptyFailedToolPreview({
      toolName: 'TaskOutput',
      engine: 'cursor',
      taskId: 'abc',
      status: 'failed',
    })
    assert.equal(
      preview,
      'TaskOutput: empty failed output task_id=abc engine=cursor status=failed',
    )
    assert.equal(preview.includes('no structured terminal'), false)
    assert.equal(preview.includes('not across turns'), false)
    assert.equal(classifyToolFailureError(preview), 'empty_output')
    const sanitized = sanitizeToolFailureErrorMsg(preview)
    assert.equal(sanitized.errorMsg, preview)
    assert.equal(sanitized.redactedReason, undefined)
  })
})
