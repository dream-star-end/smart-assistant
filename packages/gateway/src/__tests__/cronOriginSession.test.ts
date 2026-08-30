import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildCronContinuationEnvelope,
  buildCronOriginResumeText,
  cronOriginClientMessageId,
  cronOriginIdempotencyKey,
  isCronIsolatedSessionKey,
  parseOriginWebchatSessionKey,
  resolveCronOriginInjectPayload,
} from '../cronOriginSession.js'

describe('parseOriginWebchatSessionKey', () => {
  it('accepts webchat dm keys and keeps peerId', () => {
    const key = 'agent:main:webchat:dm:webmt3uvt2lh1ex2t'
    assert.deepEqual(parseOriginWebchatSessionKey(key), {
      sessionKey: key,
      agentId: 'main',
      channel: 'webchat',
      peerKind: 'dm',
      peerId: 'webmt3uvt2lh1ex2t',
    })
  })

  it('rejects cron isolated keys, groups, main, and garbage', () => {
    assert.equal(
      parseOriginWebchatSessionKey('agent:main:cron:dm:remind-1:abc'),
      null,
    )
    assert.equal(parseOriginWebchatSessionKey('agent:main:wechat:dm:sess-1'), null)
    assert.equal(parseOriginWebchatSessionKey('agent:main:webchat:group:g1'), null)
    assert.equal(parseOriginWebchatSessionKey('agent:main:main'), null)
    assert.equal(parseOriginWebchatSessionKey('not-a-key'), null)
    assert.equal(parseOriginWebchatSessionKey(''), null)
  })
})

describe('isCronIsolatedSessionKey', () => {
  it('detects the isolated cron execution key shape', () => {
    assert.equal(isCronIsolatedSessionKey('agent:main:cron:dm:remind-x:deliv'), true)
    assert.equal(isCronIsolatedSessionKey('agent:main:webchat:dm:sess'), false)
  })
})

describe('buildCronOriginResumeText', () => {
  it('includes the original prompt and a continue instruction', () => {
    const text = buildCronOriginResumeText({
      label: '升级插件',
      prompt: '确认发布完成后升级插件并短文配图',
    })
    assert.match(text, /定时续跑「升级插件」/)
    assert.match(text, /确认发布完成后升级插件并短文配图/)
    assert.match(text, /带着本对话已有上下文/)
  })
})

describe('cron continuation envelope', () => {
  it('keeps full prompt and stamps user/project fields', () => {
    const prompt = `${'B'.repeat(9000)}TAIL`
    const envelope = buildCronContinuationEnvelope(
      {
        id: 'remind-1',
        prompt,
        label: '长任务',
        sourceUserId: 'uid-3',
        sourceSessionKey: 'agent:main:webchat:dm:p1',
        projectMode: 'follow_session',
      },
      { mode: 'fixed', boardProjectId: 'board-9' },
    )
    assert.ok(envelope.resumeText.includes('TAIL'))
    assert.ok(envelope.resumeText.length > 8_000)
    assert.equal(envelope.sourceUserId, 'uid-3')
    assert.equal(envelope.projectMode, 'fixed')
    assert.equal(envelope.boardProjectId, 'board-9')
    assert.equal(envelope.cronJobId, 'remind-1')
  })

  it('resolveCronOriginInjectPayload uses dlgcb id and untruncated text', () => {
    const resumeText = `${'C'.repeat(8010)}UNIQUE_SUFFIX`
    const payload = resolveCronOriginInjectPayload({
      jobId: 'dlgjob-x',
      state: 'completed',
      parentSessionKey: 'agent:main:webchat:dm:p1',
      parentEngine: 'cursor',
      callback: 'cron-origin-inject',
      callbackEpoch: 1,
      parallelPolicy: 'all',
      agentId: 'main',
      resultRef: resumeText.slice(0, 8_000),
      callbackOriginUserId: 'uid-3',
      cronContinuation: {
        resumeText,
        sourceUserId: 'uid-3',
        projectMode: 'fixed',
        boardProjectId: 'board-9',
        cronJobId: 'remind-1',
        sourceSessionKey: 'agent:main:webchat:dm:p1',
      },
    })
    assert.ok(payload)
    assert.equal(payload.override.clientMessageId, 'dlgcb.dlgjob-x.1')
    assert.ok(payload.override.text.endsWith('UNIQUE_SUFFIX'))
    assert.equal(payload.job.sourceUserId, 'uid-3')
    assert.equal(payload.job.projectMode, 'fixed')
    assert.equal(payload.job.boardProjectId, 'board-9')
  })
})

describe('cron origin ids', () => {
  it('are stable per job+delivery', () => {
    assert.equal(
      cronOriginIdempotencyKey('remind-a', 'del-1'),
      'cron-origin:remind-a:del-1',
    )
    assert.equal(
      cronOriginClientMessageId('cron.abc-def'),
      cronOriginClientMessageId('cron.abc-def'),
    )
  })

  it('clientMessageId satisfies the browser id contract', () => {
    const id = cronOriginClientMessageId('cron.remind-a.123')
    assert.match(id, /^cron-origin-[A-Za-z0-9_-]+$/)
    assert.ok(id.length <= 128)
  })

  it('separator-only differences no longer collide across jobs', () => {
    // 旧实现剥掉 `.` 后这两个 deliveryId 同串,跨 job 互相幂等吞掉。
    assert.notEqual(
      cronOriginClientMessageId('cron.remind-a.123'),
      cronOriginClientMessageId('cron.remind-a1.23'),
    )
  })
})
