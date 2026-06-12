import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RunLog } from '../runLog.js'

describe('RunLog', () => {
  it('stores outputPreview and supports direct id lookup', () => {
    const log = new RunLog()
    const entry = log.start({
      agentId: 'main',
      sessionKey: 'agent:main:delegate:test:1',
      taskType: 'delegate',
    })

    log.complete(entry, {
      status: 'completed',
      outputPreview: 'changed skill foo',
    })

    assert.equal(log.get(entry.id), entry)
    assert.equal(log.get(entry.id)?.outputPreview, 'changed skill foo')
    assert.equal(log.recent(1)[0]?.id, entry.id)
  })
})
