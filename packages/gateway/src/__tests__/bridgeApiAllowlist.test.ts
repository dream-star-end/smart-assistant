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
    assert.equal(matchCommercialContainerApiProxy('/api/agents', 'GET')?.label, '/api/agents')
    assert.equal(matchCommercialContainerApiProxy('/api/agents', 'POST')?.label, '/api/agents')
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
    // User-level shared skill library (agentId-less) — proxied into the user's container.
    assert.equal(matchCommercialContainerApiProxy('/api/skills', 'GET')?.label, '/api/skills')
    assert.equal(
      matchCommercialContainerApiProxy('/api/skills/foo', 'PUT')?.label,
      '/api/skills/:name',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skills/foo', 'DELETE')?.label,
      '/api/skills/:name',
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
    assert.equal(
      matchCommercialContainerApiProxy('/api/agent-teams', 'GET')?.label,
      '/api/agent-teams',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agent-teams', 'POST')?.label,
      '/api/agent-teams',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agent-teams/dev_team', 'PUT')?.label,
      '/api/agent-teams/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agent-teams/dev_team', 'DELETE')?.label,
      '/api/agent-teams/:id',
    )
    // team run：发起/观察/停止经容器代理放行（finalize 不放行——只容器内 leader MCP 调）。
    assert.equal(
      matchCommercialContainerApiProxy('/api/agent-teams/dev_team/runs', 'POST')?.label,
      '/api/agent-teams/:id/runs',
    )
    assert.equal(matchCommercialContainerApiProxy('/api/team-runs', 'GET')?.label, '/api/team-runs')
    assert.equal(
      matchCommercialContainerApiProxy('/api/team-runs/trun-abc123', 'GET')?.label,
      '/api/team-runs/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/team-runs/trun-abc123/stop', 'POST')?.label,
      '/api/team-runs/:id/stop',
    )
  })

  it('proxies SkillOpt training routes to the container with correct methods', () => {
    assert.equal(
      matchCommercialContainerApiProxy('/api/skills/deploy-flow/train', 'POST')?.label,
      '/api/skills/:name/train',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc123', 'GET')?.label,
      '/api/skill-training/:runId',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc123', 'DELETE')?.label,
      '/api/skill-training/:runId',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc123/drafts', 'GET')?.label,
      '/api/skill-training/:runId/drafts',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc/drafts/deploy-flow', 'PUT')
        ?.label,
      '/api/skill-training/:runId/drafts/:name',
    )
    assert.equal(
      matchCommercialContainerApiProxy(
        '/api/skill-training/train-abc/drafts/deploy-flow/comment',
        'POST',
      )?.label,
      '/api/skill-training/:runId/drafts/:name/comment',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc/merge', 'POST')?.label,
      '/api/skill-training/:runId/merge',
    )
    // Wrong methods / shapes are rejected.
    assert.equal(matchCommercialContainerApiProxy('/api/skills/deploy-flow/train', 'GET'), null)
    // Skill-name segment must match the container's [a-z0-9-]+ exactly — no encoded
    // slash/backslash, dots, uppercase, or extra path segments slip through the gate.
    assert.equal(matchCommercialContainerApiProxy('/api/skills/a%2Fb/train', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/skills/a%5Cb/train', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/skills/a.b/train', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/skills/Foo/train', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/skills/a/b/train', 'POST'), null)
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/run-1/drafts/a%2Fb', 'GET'),
      null,
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/run-1/drafts/Foo', 'PUT'),
      null,
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc/drafts', 'POST'),
      null,
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/skill-training/train-abc/merge', 'GET'),
      null,
    )
    assert.equal(matchCommercialContainerApiProxy('/api/skill-training/a%2Fb', 'GET'), null)
  })

  it('rejects host-sensitive endpoints and unused methods', () => {
    assert.equal(matchCommercialContainerApiProxy('/api/config', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/search', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/v1/chat/completions', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/metrics', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents', 'DELETE'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/message', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/delegate', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/anything', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agent-teams/dev_team/run', 'POST'), null)
    // finalize 不代理（只容器内 leader MCP 调；用户请求由 commercial block 表 403）。
    assert.equal(matchCommercialContainerApiProxy('/api/team-runs/trun-abc/finalize', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agent-teams/dev_team/x', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agent-teams/a%2Fb', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agent-teams/a%5Cb', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agent-teams/a.b', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agent-teams/a/b', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/tasks-executions', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/memory/archival', 'GET'), null)
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/skills/foo/bar', 'DELETE'),
      null,
    )
  })
})
