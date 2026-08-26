import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildCronOriginResumeText,
  cronOriginClientMessageId,
  cronOriginIdempotencyKey,
  isCronIsolatedSessionKey,
  parseOriginWebchatSessionKey,
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
