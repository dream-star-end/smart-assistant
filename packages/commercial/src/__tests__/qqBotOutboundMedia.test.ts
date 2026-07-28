import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { MediaFileType } from '@tencent-connect/qqbot-nodejs'

import {
  QqOutboundMediaTooLargeError,
  makeQqOutboundMediaResolver,
  normalizeQqMediaKind,
  qqMediaFileType,
} from '../qqbot/outboundMedia.js'

describe('QQ outbound media contracts', () => {
  test('maps all four QQ media types to the Tencent SDK contract', () => {
    assert.equal(qqMediaFileType('image'), MediaFileType.IMAGE)
    assert.equal(qqMediaFileType('video'), MediaFileType.VIDEO)
    assert.equal(qqMediaFileType('voice'), MediaFileType.VOICE)
    assert.equal(qqMediaFileType('file'), MediaFileType.FILE)
  })

  test('only QQ-native wav/mp3/silk stay voice; other audio is sent as a file', () => {
    assert.equal(normalizeQqMediaKind('voice', 'answer.wav'), 'voice')
    assert.equal(normalizeQqMediaKind('voice', 'answer.MP3'), 'voice')
    assert.equal(normalizeQqMediaKind('voice', 'answer.silk'), 'voice')
    assert.equal(normalizeQqMediaKind('voice', 'answer.ogg'), 'file')
    assert.equal(normalizeQqMediaKind('voice', 'answer.oga'), 'file')
    assert.equal(normalizeQqMediaKind('voice', 'answer.amr'), 'file')
  })

  test('enforces the SDK image ceiling after resolving the current user file', async () => {
    const resolve = makeQqOutboundMediaResolver({
      resolveUserMediaDirs: async () => ({
        kind: 'fail',
        reason: 'remote-host',
        uid: 42,
        hostUuid: 'host-1',
        uploads: '/remote/uploads',
        generated: '/remote/generated',
        logCtx: {},
      }),
      pullRemoteHostMedia: async () => Buffer.alloc(30 * 1024 * 1024 + 1),
    })

    await assert.rejects(
      resolve({
        bindingUserId: '42',
        part: {
          type: 'image',
          containerPath: '/home/agent/.openclaude/generated/large.png',
          filename: 'large.png',
        },
      }),
      (err) => {
        assert.ok(err instanceof QqOutboundMediaTooLargeError)
        assert.match(err.userMessage, /QQ 图片 30 MB 上限/)
        return true
      },
    )
  })

  test('does not let WeChat media sniffing upgrade unsupported QQ audio to voice', async () => {
    const resolve = makeQqOutboundMediaResolver({
      resolveUserMediaDirs: async () => ({
        kind: 'fail',
        reason: 'remote-host',
        uid: 42,
        hostUuid: 'host-1',
        uploads: '/remote/uploads',
        generated: '/remote/generated',
        logCtx: {},
      }),
      pullRemoteHostMedia: async () => Buffer.from('OggS fake audio'),
    })

    const media = await resolve({
      bindingUserId: '42',
      part: {
        type: 'voice',
        containerPath: '/home/agent/.openclaude/generated/answer.ogg',
        filename: 'answer.ogg',
      },
    })
    assert.equal(media.kind, 'file')
  })
})
