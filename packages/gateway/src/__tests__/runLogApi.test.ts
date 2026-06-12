import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RunLog } from '../runLog.js'
import { selectRunLogResponse } from '../runLogApi.js'

function makeLog() {
  const log = new RunLog()
  const first = log.start({ agentId: 'main', sessionKey: 'same-session', taskType: 'delegate' })
  const second = log.start({ agentId: 'main', sessionKey: 'same-session', taskType: 'delegate' })
  const third = log.start({ agentId: 'main', sessionKey: 'other-session', taskType: 'delegate' })
  return { log, first, second, third }
}

describe('selectRunLogResponse', () => {
  it('returns an exact runId match', () => {
    const { log, first } = makeLog()
    const res = selectRunLogResponse(log, new URLSearchParams({ runId: first.id }))

    assert.equal(res.status, 200)
    assert.equal((res.body as any).run.id, first.id)
  })

  it('returns 404 for an unknown runId', () => {
    const { log } = makeLog()
    const res = selectRunLogResponse(log, new URLSearchParams({ runId: 'missing' }))

    assert.equal(res.status, 404)
    assert.deepEqual(res.body, { error: 'run not found' })
  })

  it('clamps list limit to 1..200', () => {
    const { log } = makeLog()

    const low = selectRunLogResponse(log, new URLSearchParams({ limit: '0' }))
    const high = selectRunLogResponse(log, new URLSearchParams({ limit: '999' }))

    assert.equal(low.status, 200)
    assert.equal((low.body as any).runs.length, 1)
    assert.equal(high.status, 200)
    assert.equal((high.body as any).runs.length, 3)
  })

  it('returns the newest matching run for a duplicated sessionKey', () => {
    const { log, second } = makeLog()
    const res = selectRunLogResponse(log, new URLSearchParams({ sessionKey: 'same-session' }))

    assert.equal(res.status, 200)
    assert.equal((res.body as any).run.id, second.id)
  })
})
