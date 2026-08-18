/**
 * Pure single-flight tests for AskUserWaiter.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/askUserWaiter.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ASK_USER_WAIT_MS_MAX,
  AskUserWaiter,
  askUserHttpUnwritable,
  askUserHttpWriteSucceeded,
  resolveAskUserWaitMs,
} from '../askUserWaiter.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('resolveAskUserWaitMs', () => {
  it('omitting waitMs (legacy clients) yields 0; only explicit numbers enter the window', () => {
    assert.equal(resolveAskUserWaitMs(undefined), 0)
    assert.equal(resolveAskUserWaitMs(null), 0)
    assert.equal(resolveAskUserWaitMs(''), 0)
    assert.equal(resolveAskUserWaitMs('nope'), 0)
    assert.equal(resolveAskUserWaitMs(Number.NaN), 0)
    assert.equal(resolveAskUserWaitMs(-10), 0)
    assert.equal(resolveAskUserWaitMs(0), 0)
    assert.equal(resolveAskUserWaitMs(1_000), 1_000)
    assert.equal(resolveAskUserWaitMs('1000'), 1_000)
    assert.equal(resolveAskUserWaitMs(120_000), ASK_USER_WAIT_MS_MAX)
    assert.equal(resolveAskUserWaitMs(55_000.9), 55_000)
    assert.equal(resolveAskUserWaitMs(55_000), ASK_USER_WAIT_MS_MAX)
  })
})

describe('AskUserWaiter single-flight', () => {
  it('tryAnswer wins: later tryRelease is a no-op', async () => {
    const waiter = new AskUserWaiter()
    assert.equal(waiter.tryAnswer({ behavior: 'allow', answers: { q: 'Vim' }, answerText: 'Vim' }), true)
    assert.equal(waiter.tryRelease(), false)
    assert.equal(waiter.getPhase(), 'answered_in_window')
    const result = await waiter.wait()
    assert.equal(result.status, 'answered')
    if (result.status === 'answered') {
      assert.equal(result.answer.answers?.q, 'Vim')
    }
  })

  it('tryRelease wins: later tryAnswer is a no-op (answer is not consumed in-window)', async () => {
    const waiter = new AskUserWaiter()
    assert.equal(waiter.tryRelease(), true)
    assert.equal(waiter.tryAnswer({ behavior: 'allow', answers: { q: 'Vim' } }), false)
    assert.equal(waiter.getPhase(), 'released_to_detached')
    const result = await waiter.wait()
    assert.equal(result.status, 'posted')
  })

  it('boundary race: answer and timeout in the same tick — exactly one winner, no loss', async () => {
    const waiter = new AskUserWaiter()
    let answerWon = false
    let releaseWon = false
    await Promise.all([
      Promise.resolve().then(() => {
        answerWon = waiter.tryAnswer({ behavior: 'allow', answers: { q: 'Vim' } })
      }),
      Promise.resolve().then(() => {
        releaseWon = waiter.tryRelease()
      }),
    ])
    assert.equal(answerWon || releaseWon, true, 'someone must win')
    assert.equal(answerWon && releaseWon, false, 'both must not win')
    const result = await waiter.wait()
    if (answerWon) {
      assert.equal(result.status, 'answered')
      assert.equal(waiter.getPhase(), 'answered_in_window')
      assert.equal(waiter.tryRelease(), false)
      assert.equal(waiter.tryAnswer({ behavior: 'allow' }), false)
    } else {
      assert.equal(result.status, 'posted')
      assert.equal(waiter.getPhase(), 'released_to_detached')
      assert.equal(waiter.tryAnswer({ behavior: 'allow' }), false)
      assert.equal(waiter.tryRelease(), false)
    }
  })

  it('reversed microtask order still has exactly one winner', async () => {
    const waiter = new AskUserWaiter()
    let answerWon = false
    let releaseWon = false
    await Promise.all([
      Promise.resolve().then(() => {
        releaseWon = waiter.tryRelease()
      }),
      Promise.resolve().then(() => {
        answerWon = waiter.tryAnswer({ behavior: 'deny' })
      }),
    ])
    assert.equal(Number(answerWon) + Number(releaseWon), 1)
    const result = await waiter.wait()
    assert.equal(result.status, answerWon ? 'answered' : 'posted')
  })

  it('timer release cannot steal an already-claimed answer', async () => {
    const waiter = new AskUserWaiter()
    waiter.startTimer(20)
    assert.equal(waiter.tryAnswer({ behavior: 'allow', answers: { q: 'Emacs' } }), true)
    const result = await waiter.wait()
    assert.equal(result.status, 'answered')
    await delay(40)
    assert.equal(waiter.getPhase(), 'answered_in_window')
    assert.equal(waiter.tryRelease(), false)
  })

  it('timer fires posted when nobody answers', async () => {
    const waiter = new AskUserWaiter()
    const started = Date.now()
    waiter.startTimer(25)
    const result = await waiter.wait()
    const elapsed = Date.now() - started
    assert.equal(result.status, 'posted')
    assert.equal(waiter.getPhase(), 'released_to_detached')
    assert.ok(elapsed < 200, `timer should not hang; elapsed=${elapsed}`)
    assert.equal(waiter.tryAnswer({ behavior: 'allow' }), false)
  })

  it('startTimer(0) releases immediately', async () => {
    const waiter = new AskUserWaiter()
    waiter.startTimer(0)
    const result = await waiter.wait()
    assert.equal(result.status, 'posted')
  })

  it('startTimer is a no-op after the waiter is already terminal', async () => {
    const waiter = new AskUserWaiter()
    waiter.tryAnswer({ behavior: 'deny' })
    waiter.startTimer(5)
    await delay(20)
    assert.equal(waiter.getPhase(), 'answered_in_window')
    const result = await waiter.wait()
    assert.equal(result.status, 'answered')
  })
})

describe('AskUserWaiter tryClaimDelivery', () => {
  it('is a one-shot that only succeeds after answered_in_window', () => {
    const waiter = new AskUserWaiter()
    assert.equal(waiter.tryClaimDelivery(), false)
    assert.equal(waiter.tryAnswer({ behavior: 'allow', answerText: 'Vim', answers: { q: 'Vim' } }), true)
    assert.equal(waiter.tryClaimDelivery(), true)
    assert.equal(waiter.tryClaimDelivery(), false)
    assert.equal(waiter.tryClaimDelivery(), false)
  })

  it('does not claim after release (detached path owns later answers)', () => {
    const waiter = new AskUserWaiter()
    assert.equal(waiter.tryRelease(), true)
    assert.equal(waiter.tryClaimDelivery(), false)
    assert.equal(waiter.getAnswer(), null)
  })
})

describe('askUserHttpUnwritable / askUserHttpWriteSucceeded', () => {
  it('treats aborted, destroyed, and already-ended responses as unwritable', () => {
    const idleReq = {}
    const idleRes = {}
    assert.equal(askUserHttpUnwritable(idleReq, idleRes), false)
    assert.equal(askUserHttpUnwritable({ aborted: true }, idleRes), true)
    assert.equal(askUserHttpUnwritable({ destroyed: true }, idleRes), true)
    assert.equal(askUserHttpUnwritable({ socket: { destroyed: true } }, idleRes), true)
    assert.equal(askUserHttpUnwritable(idleReq, { headersSent: true }), true)
    assert.equal(askUserHttpUnwritable(idleReq, { writableEnded: true }), true)
    assert.equal(askUserHttpUnwritable(idleReq, { destroyed: true }), true)
    assert.equal(askUserHttpUnwritable(idleReq, { writable: false }), true)
    assert.equal(askUserHttpUnwritable(idleReq, { socket: { destroyed: true } }), true)
  })

  it('treats a completed undestroyed write as success', () => {
    assert.equal(askUserHttpWriteSucceeded({ headersSent: true, writableEnded: true }), true)
    assert.equal(askUserHttpWriteSucceeded({ headersSent: true, writableEnded: true, destroyed: true }), false)
    assert.equal(askUserHttpWriteSucceeded({ headersSent: true, writableEnded: false }), false)
    assert.equal(askUserHttpWriteSucceeded({ headersSent: false, writableEnded: false }), false)
  })
})
