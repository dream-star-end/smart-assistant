import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  classifyWeiboWriteLedgerFields,
  mapWeiboWorkerProtocolFailure,
  mapWeiboWorkerStage,
  persistWeiboWorkerLog,
  sanitizeWeiboWorkerLogLine,
  weiboWorkerDockerLogConfig,
} from './weiboWriteObservability.js'

describe('Weibo write failure mapping', () => {
  test('maps the four worker stage classes to distinct codes', () => {
    assert.equal(mapWeiboWorkerStage(new Error('media')), 'WEIBO_WRITE_MEDIA')
    assert.equal(mapWeiboWorkerStage(new Error('media-chooser')), 'WEIBO_WRITE_MEDIA_CHOOSER')
    assert.equal(mapWeiboWorkerStage(new Error('composer')), 'WEIBO_WRITE_COMPOSER')
    assert.equal(mapWeiboWorkerStage(new Error('composer-readback')), 'WEIBO_WRITE_COMPOSER_READBACK')
    assert.equal(mapWeiboWorkerStage(new Error('send')), 'WEIBO_WRITE_SEND')
    assert.equal(mapWeiboWorkerStage(new Error('send-button')), 'WEIBO_WRITE_SEND_BUTTON')
    assert.equal(mapWeiboWorkerStage(new Error('result')), 'WEIBO_WRITE_RESULT')
  })

  test('media worker error stays failed when dispatch was not armed', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: mapWeiboWorkerStage(new Error('media-upload')) },
      dispatchArmed: false,
    })
    assert.equal(outcome.errorCode, 'WEIBO_WRITE_MEDIA_UPLOAD')
    assert.equal(outcome.status, 'failed')
  })

  test('composer worker error stays failed when dispatch was not armed', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: mapWeiboWorkerStage(new Error('composer-editor')) },
      dispatchArmed: false,
    })
    assert.equal(outcome.errorCode, 'WEIBO_WRITE_COMPOSER_EDITOR')
    assert.equal(outcome.status, 'failed')
  })

  test('send worker error stays unknown after dispatch — status is not rewritten to failed', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: mapWeiboWorkerProtocolFailure('WEIBO_WRITE_SEND_CLICK') },
      dispatchArmed: true,
    })
    assert.equal(outcome.errorCode, 'WEIBO_WRITE_SEND_CLICK')
    assert.equal(outcome.status, 'unknown')
  })

  test('result worker error stays unknown after dispatch — status is not rewritten to failed', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: 'WEIBO_WRITE_RESULT' },
      dispatchArmed: true,
    })
    assert.equal(outcome.errorCode, 'WEIBO_WRITE_RESULT')
    assert.equal(outcome.status, 'unknown')
  })

  test('host early failure before dispatch maps to a distinct code and stays failed', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: 'WEIBO_WORKER_BUSY', message: 'worker key is already active' },
      dispatchArmed: false,
    })
    assert.equal(outcome.errorCode, 'WEIBO_WORKER_BUSY')
    assert.equal(outcome.status, 'failed')
  })

  test('host deadline after dispatch stays unknown', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: 'WEIBO_WORKER_DEADLINE', message: 'worker deadline' },
      dispatchArmed: true,
    })
    assert.equal(outcome.errorCode, 'WEIBO_WORKER_DEADLINE')
    assert.equal(outcome.status, 'unknown')
  })

  test('proven-not-started overrides an armed flag so status stays failed', () => {
    const outcome = classifyWeiboWriteLedgerFields({
      error: { code: 'PRECONDITION_CHANGED' },
      dispatchArmed: true,
      dispatchProvenNotStarted: true,
    })
    assert.equal(outcome.errorCode, 'PRECONDITION_CHANGED')
    assert.equal(outcome.status, 'failed')
  })

  test('generic worker protocol failure does not collapse send/result back to EXECUTION_FAILED', () => {
    assert.equal(mapWeiboWorkerProtocolFailure('WEIBO_WRITE_SEND_BUTTON'), 'WEIBO_WRITE_SEND_BUTTON')
    assert.equal(mapWeiboWorkerProtocolFailure('WEIBO_WRITE_RESULT'), 'WEIBO_WRITE_RESULT')
    assert.equal(mapWeiboWorkerProtocolFailure('WORKER_FAILED'), 'WEIBO_ACTION_FAILED')
    assert.equal(mapWeiboWorkerProtocolFailure('UPSTREAM_FAILED'), 'UPSTREAM_FAILED')
  })
})

describe('Weibo worker log sanitizer', () => {
  test('keeps docker log driver at none so stdout secrets are not persisted', () => {
    assert.deepEqual(weiboWorkerDockerLogConfig(), { Type: 'none', Config: {} })
  })

  test('drops cookies, tokens, HTML, and full post text', () => {
    assert.equal(
      sanitizeWeiboWorkerLogLine(
        JSON.stringify({
          step: 'action.failed',
          cookie: 'SUB=secret',
          token: 'abc',
          html: '<html>full page</html>',
          text: 'user post body that must not be stored',
          textLen: 12,
          textHash8: 'deadbeef',
        }),
      )?.text,
      undefined,
    )
    const kept = sanitizeWeiboWorkerLogLine(
      JSON.stringify({
        src: 'weibo-worker',
        step: 'media.chooser',
        textLen: 12,
        textHash8: 'deadbeef',
        code: 'WEIBO_WRITE_MEDIA_CHOOSER',
        branch: 'existing',
        hasImage: true,
        scopeImageInputs: 1,
        html: '<div>drop</div>',
        srcUrl: 'https://weibo.com/secret',
      }),
    )
    assert.deepEqual(kept, {
      src: 'weibo-worker',
      step: 'media.chooser',
      textLen: 12,
      textHash8: 'deadbeef',
      code: 'WEIBO_WRITE_MEDIA_CHOOSER',
      branch: 'existing',
      hasImage: true,
      scopeImageInputs: 1,
    })
    assert.equal(kept && 'html' in kept, false)
    assert.equal(kept && 'srcUrl' in kept, false)
  })

  test('persists only sanitized JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weibo-obs-'))
    try {
      await persistWeiboWorkerLog(dir, '11111111-2222-3333-4444-555555555555', {
        step: 'host.failed',
        code: 'WEIBO_WRITE_RESULT',
        cookie: 'must-drop',
      })
      const body = await readFile(join(dir, '11111111-2222-3333-4444-555555555555.jsonl'), 'utf8')
      assert.match(body, /WEIBO_WRITE_RESULT/)
      assert.doesNotMatch(body, /must-drop/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
