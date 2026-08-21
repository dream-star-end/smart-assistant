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
    // v5 纯市场:不允许经容器代理创建容器内 agent(其它 agent 一律走市场安装)。POST 被砍。
    assert.equal(matchCommercialContainerApiProxy('/api/agents', 'POST'), null)
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
    // memdir 单条记忆文件 CRUD — proxied into the user's container.
    for (const m of ['GET', 'PUT', 'DELETE'] as const) {
      assert.equal(
        matchCommercialContainerApiProxy('/api/agents/main/memory/files/user-radio.md', m)?.label,
        '/api/agents/:id/memory/files/:file',
        `memory files ${m} must be proxied`,
      )
    }
    // :file 段不得吞子路径(穿越防线由容器 handler 的 basename+MEMORY_FILE_RE 兜底,门这里也不放松)。
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/memory/files/a/b.md', 'GET'),
      null,
    )
    // 旧索引 target 仍只 GET/PUT,PUT 到 files 子树不匹配 :target 规则。
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/memory/memory', 'GET')?.label,
      '/api/agents/:id/memory/:target',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/memory/usage', 'GET')?.label,
      '/api/agents/:id/memory/usage',
    )
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/memory/usage', 'POST'), null)
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/auto-dream-report', 'GET')?.label,
      '/api/agents/:id/auto-dream-report',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/auto-dream-report', 'POST'),
      null,
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/auto-dream-optimizer', 'GET')?.label,
      '/api/agents/:id/auto-dream-optimizer',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/auto-dream-optimizer', 'POST')?.label,
      '/api/agents/:id/auto-dream-optimizer',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/auto-dream-optimizer/cancel', 'POST')
        ?.label,
      '/api/agents/:id/auto-dream-optimizer/cancel',
    )
    for (const action of ['apply', 'dismiss'] as const) {
      assert.equal(
        matchCommercialContainerApiProxy(
          `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(32)}/${action}`,
          'POST',
        )?.label,
        '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/:action',
      )
    }
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/skills/foo', 'DELETE')?.label,
      '/api/agents/:id/skills/:name',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/skills/foo', 'PUT')?.label,
      '/api/agents/:id/skills/:name',
    )
    // Cursor MCP ask_user — container agent → Web choice cards. POST only.
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/ask-user', 'POST')?.label,
      '/api/agents/:id/ask-user',
    )
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/ask-user', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/ask-user', 'PUT'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/a/ask-user', 'POST')?.label, '/api/agents/:id/ask-user')
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main./ask-user', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/ma%2Fin/ask-user', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/agents/main/ask-user/extra', 'POST'), null)
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
    // Taskboard `/api/board/*` —— 契约里每个端点都能被商业代理命中。
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/projects', 'GET')?.label,
      '/api/board/projects',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/projects', 'POST')?.label,
      '/api/board/projects',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/projects/OCV5', 'GET')?.label,
      '/api/board/projects/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/projects/OCV5', 'PATCH')?.label,
      '/api/board/projects/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/projects/OCV5', 'DELETE')?.label,
      '/api/board/projects/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/projects/OCV5/board', 'GET')?.label,
      '/api/board/projects/:id/board',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets', 'GET')?.label,
      '/api/board/tickets',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets', 'POST')?.label,
      '/api/board/tickets',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1', 'GET')?.label,
      '/api/board/tickets/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1', 'PATCH')?.label,
      '/api/board/tickets/:id',
    )
    for (const action of [
      'ready',
      'claim',
      'advance',
      'block',
      'approve',
      'reject',
      'done',
      'cancel',
      'comment',
      'patrol',
      'move',
    ]) {
      assert.equal(
        matchCommercialContainerApiProxy(`/api/board/tickets/OCV5-1/${action}`, 'POST')?.label,
        '/api/board/tickets/:id/:action',
        `board ticket action ${action} must be proxied`,
      )
    }
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1/runs', 'GET')?.label,
      '/api/board/tickets/:id/runs',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1/relations', 'GET')?.label,
      '/api/board/tickets/:id/relations',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1/relations', 'POST')?.label,
      '/api/board/tickets/:id/relations',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1/comments', 'GET')?.label,
      '/api/board/tickets/:id/comments',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1/activity', 'GET')?.label,
      '/api/board/tickets/:id/activity',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/tickets/OCV5-1/timeline', 'GET')?.label,
      '/api/board/tickets/:id/timeline',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/pipelines', 'GET')?.label,
      '/api/board/pipelines',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/pipelines', 'POST')?.label,
      '/api/board/pipelines',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/pipelines/pipe-1', 'GET')?.label,
      '/api/board/pipelines/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/pipelines/pipe-1', 'PATCH')?.label,
      '/api/board/pipelines/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/pipelines/pipe-1/stages', 'GET')?.label,
      '/api/board/pipelines/:id/stages',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/pipelines/pipe-1/stages', 'POST')?.label,
      '/api/board/pipelines/:id/stages',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/stages/stage-1', 'GET')?.label,
      '/api/board/stages/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/stages/stage-1', 'PATCH')?.label,
      '/api/board/stages/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/runs/run-1', 'GET')?.label,
      '/api/board/runs/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/relations/rel-1', 'DELETE')?.label,
      '/api/board/relations/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/agents', 'GET')?.label,
      '/api/board/agents',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/settings', 'GET')?.label,
      '/api/board/settings',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/settings', 'PATCH')?.label,
      '/api/board/settings',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/stats/cost', 'GET')?.label,
      '/api/board/stats/cost',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/templates', 'GET')?.label,
      '/api/board/templates',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/templates', 'POST')?.label,
      '/api/board/templates',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/templates/builtin:bug', 'GET')?.label,
      '/api/board/templates/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/templates/builtin:bug', 'DELETE')?.label,
      '/api/board/templates/:id',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/templates/builtin:bug/apply', 'POST')?.label,
      '/api/board/templates/:id/apply',
    )
    assert.equal(
      matchCommercialContainerApiProxy('/api/board/reports/weekly', 'GET')?.label,
      '/api/board/reports/weekly',
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
    // v5 轻量组队重构:旧「团队」重后端(/api/agent-teams、/api/team-runs*)已从产品面移除,
    // 从容器代理 allowlist 删除 → 浏览器→商业宿主→用户容器 这条唯一外部可达路径关闭(默认拒绝)。
    for (const [p, m] of [
      ['/api/agent-teams', 'GET'],
      ['/api/agent-teams', 'POST'],
      ['/api/agent-teams/dev_team', 'PUT'],
      ['/api/agent-teams/dev_team', 'DELETE'],
      ['/api/agent-teams/dev_team/runs', 'POST'],
      ['/api/team-runs', 'GET'],
      ['/api/team-runs/trun-abc123', 'GET'],
      ['/api/team-runs/trun-abc123/stop', 'POST'],
    ] as const) {
      assert.equal(
        matchCommercialContainerApiProxy(p, m),
        null,
        `retired team route must not be proxied: ${m} ${p}`,
      )
    }
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
    assert.equal(
      matchCommercialContainerApiProxy('/api/agents/main/auto-dream-report/extra', 'GET'),
      null,
    )
    for (const path of [
      '/api/agents/main/auto-dream-optimizer/cancel',
      `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(32)}/apply`,
    ]) {
      assert.equal(matchCommercialContainerApiProxy(path, 'GET'), null)
    }
    for (const path of [
      '/api/agents/main./auto-dream-optimizer',
      '/api/agents/ma%2Fin/auto-dream-optimizer',
      '/api/agents/ma%5Cin/auto-dream-optimizer',
      '/api/agents//auto-dream-optimizer',
      '/api/agents/main/extra/auto-dream-optimizer',
      `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(31)}/apply`,
      `/api/agents/main/auto-dream-optimizer/proposals/${'A'.repeat(32)}/apply`,
      `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(32)}/approve`,
      `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(32)}/apply/extra`,
    ]) {
      assert.equal(matchCommercialContainerApiProxy(path, 'POST'), null, path)
    }
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
