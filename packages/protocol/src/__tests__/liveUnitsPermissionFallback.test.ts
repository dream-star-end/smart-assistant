import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type LiveFrameInput,
  assembleLiveUnitsPage,
  continueReduceLiveFrames,
  reduceLiveFrames,
} from '../liveUnits.js'

const META = {
  streamClientMessageIds: ['cm-1'],
  openDispatch: true,
  hasTapeProjection: false,
  tapeProjectionVersion: 0,
}

function messageFrame(recordId: string, frameSeq: number): LiveFrameInput {
  return {
    recordId,
    streamKey: 'dispatch:d1:1',
    clientMessageId: 'cm-1',
    payload: {
      type: 'outbound.message',
      sessionKey: 'agent:main:webchat:dm:s1',
      peer: { id: 's1', kind: 'dm' },
      clientMessageId: 'cm-1',
      frameSeq,
      blocks: [
        {
          kind: 'tool_use',
          blockId: 'tool-ask',
          toolName: 'AskUserQuestion',
          inputJson: { questions: [{ question: '继续吗？', options: [{ label: '继续' }] }] },
        },
      ],
    },
  }
}

function permissionFrame(
  recordId: string,
  frameSeq: number,
  type: 'outbound.permission_request' | 'outbound.permission_settled',
): LiveFrameInput {
  return {
    recordId,
    streamKey: 'dispatch:d1:1',
    clientMessageId: 'cm-1',
    payload: {
      type,
      sessionKey: 'agent:main:webchat:dm:s1',
      peer: { id: 's1', kind: 'dm' },
      clientMessageId: 'cm-1',
      requestId: 'req-ask-1',
      frameSeq,
      ...(type === 'outbound.permission_request'
        ? {
            toolName: 'AskUserQuestion',
            inputJson: { questions: [{ question: '继续吗？', options: [{ label: '继续' }] }] },
            expiresAt: Date.now() + 60_000,
          }
        : { behavior: 'allow', reason: 'remote', answers: { '继续吗？': '继续' } }),
    },
  }
}

describe('live units permission lifecycle fallback', () => {
  it('never mints a resume cursor past an unrepresented permission_request', () => {
    const page = assembleLiveUnitsPage(
      [messageFrame('30', 30), permissionFrame('31', 31, 'outbound.permission_request')],
      META,
    )

    assert.equal(page.degraded, 'fallback')
    assert.equal(page.resume, undefined)
    assert.equal(page.throughFrameSeq, undefined)
    assert.deepEqual(page.units, [])
  })

  it('also falls back when permission_settled arrives after a checkpoint', () => {
    const prefix = reduceLiveFrames([messageFrame('30', 30)])
    assert.equal(prefix.ok, true)
    if (!prefix.ok) return

    const continued = continueReduceLiveFrames(prefix.state, [
      permissionFrame('32', 32, 'outbound.permission_settled'),
    ])

    assert.equal(continued.ok, false)
    if (continued.ok) return
    assert.equal(continued.degraded, 'fallback')
  })
})
