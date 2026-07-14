import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AutoDreamPolicyClient, parseAutoDreamPolicy } from '../autoDreamPolicy.js'

describe('parseAutoDreamPolicy', () => {
  it('accepts a complete enabled policy', () => {
    assert.deepEqual(
      parseAutoDreamPolicy({
        enabled: true,
        modelId: 'deepseek-v4-flash',
        modelName: 'DeepSeek V4 Flash',
        minIntervalHours: 24,
        minNewSessions: 5,
      }),
      {
        enabled: true,
        modelId: 'deepseek-v4-flash',
        modelName: 'DeepSeek V4 Flash',
        minIntervalHours: 24,
        minNewSessions: 5,
      },
    )
  })

  it('fails closed for malformed, too-frequent, or partial policies', () => {
    for (const raw of [
      null,
      [],
      { enabled: true },
      { enabled: true, modelId: 'x', modelName: 'X', minIntervalHours: 23, minNewSessions: 5 },
      { enabled: true, modelId: 'x', modelName: 'X', minIntervalHours: 24, minNewSessions: 0 },
      { enabled: 'true', modelId: 'x', modelName: 'X', minIntervalHours: 24, minNewSessions: 5 },
    ]) {
      assert.deepEqual(parseAutoDreamPolicy(raw), { enabled: false })
    }
  })
})

describe('AutoDreamPolicyClient freshness', () => {
  const enabled = {
    enabled: true,
    modelId: 'deepseek-v4-flash',
    modelName: 'DeepSeek V4 Flash',
    minIntervalHours: 24,
    minNewSessions: 5,
  }

  function body(value: unknown) {
    return {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(value))
      },
    }
  }

  it('never reuses a positive policy across triggers', async () => {
    let calls = 0
    const client = new AutoDreamPolicyClient({
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'token',
      },
      fetcher: (async () => {
        calls++
        return { statusCode: 200, body: body(enabled) }
      }) as never,
    })
    assert.equal((await client.get()).enabled, true)
    assert.equal((await client.get()).enabled, true)
    assert.equal(calls, 2)
  })

  it('forced fresh read bypasses the fail-closed negative cache before claim', async () => {
    let calls = 0
    const client = new AutoDreamPolicyClient({
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'token',
      },
      fetcher: (async () => {
        calls++
        return { statusCode: 200, body: body(calls === 1 ? { enabled: false } : enabled) }
      }) as never,
    })
    assert.deepEqual(await client.get(), { enabled: false })
    assert.deepEqual(await client.get(), { enabled: false })
    assert.equal(calls, 1, 'ordinary fail-closed reads may reuse the short negative cache')
    assert.equal((await client.get({ fresh: true })).enabled, true)
    assert.equal(calls, 2)
  })
})
