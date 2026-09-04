import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  classifyZhihuWriteLedgerFields,
  mapZhihuWorkerProtocolFailure,
  mapZhihuWorkerStage,
  persistZhihuWorkerLog,
  sanitizeZhihuWorkerLogLine,
  zhihuWorkerDockerLogConfig,
} from './zhihuWriteObservability.js'

describe('Zhihu write failure mapping', () => {
  test('maps worker stage classes to distinct codes', () => {
    assert.equal(mapZhihuWorkerStage(new Error('composer')), 'ZHIHU_WRITE_COMPOSER')
    assert.equal(mapZhihuWorkerStage(new Error('composer-editor')), 'ZHIHU_WRITE_COMPOSER_EDITOR')
    assert.equal(mapZhihuWorkerStage(new Error('composer-readback')), 'ZHIHU_WRITE_COMPOSER_READBACK')
    assert.equal(mapZhihuWorkerStage(new Error('send')), 'ZHIHU_WRITE_SEND')
    assert.equal(mapZhihuWorkerStage(new Error('send-button')), 'ZHIHU_WRITE_SEND_BUTTON')
    assert.equal(mapZhihuWorkerStage(new Error('result')), 'ZHIHU_WRITE_RESULT')
    assert.equal(mapZhihuWorkerStage(new Error('unsupported')), 'ZHIHU_WRITE_UNSUPPORTED')
  })

  test('composer worker error stays failed when dispatch was not armed', () => {
    const outcome = classifyZhihuWriteLedgerFields({
      error: { code: mapZhihuWorkerStage(new Error('composer-editor')) },
      dispatchArmed: false,
    })
    assert.equal(outcome.errorCode, 'ZHIHU_WRITE_COMPOSER_EDITOR')
    assert.equal(outcome.status, 'failed')
  })

  test('send worker error stays unknown after dispatch — status is not rewritten to failed', () => {
    const outcome = classifyZhihuWriteLedgerFields({
      error: { code: mapZhihuWorkerProtocolFailure('ZHIHU_WRITE_SEND_CLICK') },
      dispatchArmed: true,
    })
    assert.equal(outcome.errorCode, 'ZHIHU_WRITE_SEND_CLICK')
    assert.equal(outcome.status, 'unknown')
  })

  test('result worker error stays unknown after dispatch', () => {
    const outcome = classifyZhihuWriteLedgerFields({
      error: { code: 'ZHIHU_WRITE_RESULT' },
      dispatchArmed: true,
    })
    assert.equal(outcome.errorCode, 'ZHIHU_WRITE_RESULT')
    assert.equal(outcome.status, 'unknown')
  })

  test('host early failure before dispatch maps to a distinct code and stays failed', () => {
    const outcome = classifyZhihuWriteLedgerFields({
      error: { code: 'ZHIHU_WORKER_BUSY', message: 'worker key is already active' },
      dispatchArmed: false,
    })
    assert.equal(outcome.errorCode, 'ZHIHU_WORKER_BUSY')
    assert.equal(outcome.status, 'failed')
  })

  test('protocol WORKER_FAILED maps to ZHIHU_ACTION_FAILED', () => {
    assert.equal(mapZhihuWorkerProtocolFailure('WORKER_FAILED'), 'ZHIHU_ACTION_FAILED')
    assert.equal(mapZhihuWorkerProtocolFailure('LOGIN_EXPIRED'), 'LOGIN_EXPIRED_ACCOUNT')
    assert.equal(
      mapZhihuWorkerProtocolFailure('ZHIHU_UPSTREAM_CHALLENGE'),
      'ZHIHU_UPSTREAM_CHALLENGE',
    )
  })

  test('docker log config stays none so storageState never hits json-file', () => {
    assert.deepEqual(zhihuWorkerDockerLogConfig(), { Type: 'none', Config: {} })
  })

  test('sanitizes worker log lines and persists only allowlisted keys', async () => {
    assert.equal(sanitizeZhihuWorkerLogLine('not-json'), null)
    assert.deepEqual(sanitizeZhihuWorkerLogLine('{"step":"action.start","ok":true,"secret":"x"}'), {
      step: 'action.start',
      ok: true,
    })
    const dir = await mkdtemp(join(tmpdir(), 'zhihu-obs-'))
    try {
      await persistZhihuWorkerLog(dir, '12345678-aaaa-bbbb-cccc-1234567890ab', {
        step: 'host.ready',
      })
      const body = await readFile(join(dir, '12345678-aaaa-bbbb-cccc-1234567890ab.jsonl'), 'utf8')
      assert.match(body, /"step":"host.ready"/)
      assert.match(body, /"src":"zhihu-host"/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
