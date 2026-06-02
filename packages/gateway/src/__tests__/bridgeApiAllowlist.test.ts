import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchBridgeApiAllowlist, matchCommercialContainerApiProxy } from '../bridgeApiAllowlist.js'

describe('bridge API allowlist', () => {
  it('keeps legacy file/media bypass but excludes it from commercial API proxy', () => {
    assert.equal(matchBridgeApiAllowlist('/api/file', 'GET')?.label, '/api/file')
    assert.equal(matchBridgeApiAllowlist('/api/media/foo.png', 'HEAD')?.label, '/api/media/:file')
    assert.equal(matchCommercialContainerApiProxy('/api/file', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/media/foo.png', 'GET'), null)
  })

  it('allows only selected per-container management routes for commercial proxy', () => {
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main', 'PUT')?.label,
      '/api/agents/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/persona', 'PUT')?.label,
      '/api/agents/:id/persona',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/memory/user', 'GET')?.label,
      '/api/agents/:id/memory/:target',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/skills/foo', 'DELETE')?.label,
      '/api/agents/:id/skills/:name',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/skills/foo', 'PUT')?.label,
      '/api/agents/:id/skills/:name',
    )
    assert.equal(matchCommercialContainerApiProxy('/api/cron', 'POST')?.label, '/api/cron')
    assert.equal(
      matchCommercialContainerApiProxy('/api/cron/job-1', 'DELETE')?.label,
      '/api/cron/:id',
    )
    assert.equal(matchCommercialContainerApiProxy('/api/tasks', 'POST')?.label, '/api/tasks')
    assert.equal(
      matchCommercialContainerApiProxy('/api/tasks/task_1', 'POST')?.label,
      '/api/tasks/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/tasks-executions', 'GET')?.label,
      '/api/tasks-executions',
    )
  })

  it('rejects host-sensitive endpoints and unused methods', () => {
    assert.equal(matchCommercialContainerApiProxy('/api/config', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/search', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/v1/chat/completions', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/metrics', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/tasks-executions', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/memory/archival', 'GET'), null)
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/skills/foo/bar', 'DELETE'),
      null,
    )
  })
})
