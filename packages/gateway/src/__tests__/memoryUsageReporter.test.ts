import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { readMemoryUsageReportConfig, sendMemoryUsageBatch } from '../memoryUsageReporter.js'

const row = {
  eventId: 'memory-event-1',
  timestamp: Date.now(),
  timestampIso: new Date().toISOString(),
  agentId: 'main',
  sessionKey: 'agent:main:webchat:dm:private',
  sessionHash: 'a'.repeat(64),
  turnIndex: 1,
  operation: 'core_search' as const,
  memoryType: 'core' as const,
  outcome: 'hit' as const,
  policyReason: 'explicit_continuity',
  retrievalMode: 'lexical' as const,
  resultCount: 1,
  latencyMs: 42,
  queryHash: 'b'.repeat(64),
  queryChars: 4,
  topMatchHash: 'c'.repeat(64),
  freshnessGap: false,
}

describe('memory usage reporter', () => {
  test('is naturally disabled without the container identity channel', () => {
    assert.equal(readMemoryUsageReportConfig({}), null)
    assert.equal(
      readMemoryUsageReportConfig({
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'token',
        OC_MEMORY_USAGE_REPORTING: '0',
      }),
      null,
    )
  })

  test('reports only hashes and bounded metadata', async () => {
    let body = ''
    const result = await sendMemoryUsageBatch(
      [row],
      {
        masterBaseUrl: 'http://master',
        containerToken: 'token',
      },
      async (_input, init) => {
        body = String(init?.body ?? '')
        return new Response('{}', { status: 200 })
      },
    )
    assert.equal(result, 'sent')
    assert.doesNotMatch(body, /agent:main:webchat:dm:private/)
    assert.doesNotMatch(body, /queryText|memoryContent|inputPreview/)
    assert.match(body, /"sessionHash":"a{64}"/)
  })

  test('retries transient responses and drops permanent schema rejection', async () => {
    assert.equal(
      await sendMemoryUsageBatch(
        [row],
        {
          masterBaseUrl: 'http://master',
          containerToken: 'token',
        },
        async () => new Response('{}', { status: 503 }),
      ),
      'retry',
    )
    assert.equal(
      await sendMemoryUsageBatch(
        [row],
        {
          masterBaseUrl: 'http://master',
          containerToken: 'token',
        },
        async () => new Response('{}', { status: 400 }),
      ),
      'drop',
    )
  })
})
