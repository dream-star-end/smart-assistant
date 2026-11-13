import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildPromptContext } from '../promptSlots.js'

describe('taskboard acceptance instructions (OCV5-446)', () => {
  for (const provider of ['ccb', 'codex', 'cursor']) {
    for (const cacheLayout of ['legacy', 'static-first'] as const) {
      it(`${provider}/${cacheLayout}: permits scoped acceptance with audit without removing human approval`, async () => {
        const result = await buildPromptContext({
          agentId: 'nonexistent-agent-for-taskboard-test',
          provider,
          cacheLayout,
          sessionKey: 'agent:nonexistent-agent-for-taskboard-test:webchat:dm:rules',
          delegateModelCatalog: false,
          availableMcpTools: ['present_task_approval', 'task_get', 'task_approve'],
        })

        // OCV5-759: retain each authorization/evidence boundary, not the retired long wording.
        assert.match(result.content, /用户明确授权且接口支持时,Agent 可用/)
        assert.match(result.content, /先读任务及评论并核真实交付证据/)
        assert.match(result.content, /oc-task ticket done/)
        assert.match(result.content, /expectedVersion.*reason.*evidence/)
        assert.match(result.content, /写后回读状态与审计/)
        assert.match(result.content, /取消与重开由人操作/)
        assert.match(result.content, /仍需用户本人批准.*present_task_approval/)
        assert.match(result.content, /贴审批卡并立刻结束本回合/)
        assert.doesNotMatch(result.content, /done[^\n]*永远不属于 AI/)
      })
    }
  }
})
