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

        assert.match(result.content, /用户明确授权且当前环境正式接口已支持/)
        assert.match(result.content, /授权范围内完成验收/)
        assert.match(result.content, /oc-task ticket done/)
        assert.match(result.content, /expectedVersion.*reason.*evidence/)
        assert.match(result.content, /写入审计/)
        assert.match(result.content, /取消与重开仍由人/)
        assert.match(result.content, /仍需用户本人批准.*present_task_approval/)
        assert.match(result.content, /调用后立刻结束本回合/)
        assert.doesNotMatch(result.content, /done[^\n]*永远不属于 AI/)
      })
    }
  }
})
