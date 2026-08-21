import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DETACHED_ASK_USER_TTL_MS,
  buildDetachedAskUserPersistMessage,
  formatAskUserAnswerMessage,
  pendingFromDetachedAskUserMessage,
} from '../detachedAskUser.js'

const QUESTION = 'Which editor do you want?'

describe('detachedAskUser helpers', () => {
  it('formats question prompts with chosen labels', () => {
    const text = formatAskUserAnswerMessage(
      {
        questions: [
          { question: QUESTION, header: 'Editor' },
          { question: 'Dark mode?', options: [{ label: 'Yes' }] },
        ],
      },
      { [QUESTION]: 'Vim', 'Dark mode?': 'Yes' },
    )
    assert.match(text, /用户已回答提问/)
    assert.match(text, /【Editor】Which editor do you want/)
    assert.match(text, /选择：Vim/)
    assert.match(text, /Dark mode\?/)
    assert.match(text, /选择：Yes/)
  })

  it('rebuilds a pending entry from a persisted tape card', () => {
    const requestId = 'ask-user:deadbeef'
    const msg = buildDetachedAskUserPersistMessage({
      requestId,
      questions: [{ question: QUESTION, options: [{ label: 'Vim' }] }],
      sessionKey: 'agent:main:webchat:dm:wsess-1',
      userId: '3',
      channel: 'webchat',
      peer: { id: 'wsess-1', kind: 'dm' },
      expiresAt: Date.now() + DETACHED_ASK_USER_TTL_MS,
    })
    const pending = pendingFromDetachedAskUserMessage(msg, {
      userId: '3',
      channel: 'webchat',
      peer: { id: 'wsess-1', kind: 'dm' },
      peerKey: '3:webchat:wsess-1',
    })
    assert.ok(pending)
    assert.equal(pending!.detachedAskUser, true)
    assert.equal(pending!.sessionKey, 'agent:main:webchat:dm:wsess-1')
    assert.equal((pending!.input.questions as { question: string }[])[0]!.question, QUESTION)
  })

  it('rejects an already-resolved or expired tape card', () => {
    const base = buildDetachedAskUserPersistMessage({
      requestId: 'ask-user:old',
      questions: [{ question: QUESTION, options: [{ label: 'Vim' }] }],
      sessionKey: 'agent:main:webchat:dm:wsess-1',
      userId: '3',
      channel: 'webchat',
      peer: { id: 'wsess-1', kind: 'dm' },
      expiresAt: Date.now() - 1000,
    })
    const fallbacks = {
      userId: '3',
      channel: 'webchat',
      peer: { id: 'wsess-1' as const, kind: 'dm' as const },
      peerKey: '3:webchat:wsess-1',
    }
    assert.equal(pendingFromDetachedAskUserMessage(base, fallbacks), null)
    assert.equal(
      pendingFromDetachedAskUserMessage({ ...base, _askUserExpiresAt: Date.now() + 10000, _resolved: true }, fallbacks),
      null,
    )
  })
})
