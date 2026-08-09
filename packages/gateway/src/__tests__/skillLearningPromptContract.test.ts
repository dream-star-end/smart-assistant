import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { _internals as codexInternals } from '../codexLaunchOverrides.js'
import { buildToolsSlot } from '../promptSlots.js'

const ccbAgents = readFileSync(
  'packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md',
  'utf8',
)
const ccbClaude = readFileSync(
  'packages/commercial/agent-sandbox/ccb-baseline/CLAUDE.md',
  'utf8',
)
const codexBundle = readFileSync(
  'packages/commercial/agent-sandbox/platform-runtime/prompts/codex-preamble.md',
  'utf8',
)

describe('skill learning prompt contract', () => {
  it('does not turn tool count or task complexity into a post-task learning trigger', () => {
    const sources = {
      toolsSlot: buildToolsSlot().content,
      ccbAgents,
      ccbClaude,
      codexBundle,
      codexFallback: codexInternals.CODEX_PREAMBLE,
    }

    for (const [name, source] of Object.entries(sources)) {
      assert.doesNotMatch(source, /完成 3\+ 工具调用的复杂任务/, `${name} 仍含 3+ 工具触发器`)
      assert.doesNotMatch(
        source,
        /after a complex multi-step task, call\s+`skill_search`/,
        `${name} 仍含复杂任务触发器`,
      )
      assert.match(
        source,
        /(?:工具调用次数或任务复杂度本身不是触发条件|Tool count or task complexity alone is not a\s+trigger)/,
        `${name} 未明确排除复杂度触发`,
      )
      assert.match(
        source,
        /(?:没有新的?可复用结论就跳过|no new reusable conclusion, skip skill evaluation)/,
        `${name} 未要求无新结论时跳过`,
      )
      assert.match(
        source,
        /(?:先完成用户的主任务结果与必要验证|主任务结果与必要验证完成后|Finish the primary result and required verification first)/,
        `${name} 未把主任务交付置于技能沉淀之前`,
      )
    }
  })

  it('keeps evidence-based learning and task-start skill discovery', () => {
    const chineseSources = [buildToolsSlot().content, ccbAgents, ccbClaude]
    for (const source of chineseSources) {
      assert.match(source, /验证出可跨任务复用的新流程\/关键坑点/)
      assert.match(source, /修复了可复发问题/)
      assert.match(source, /已有 skill 缺少关键步骤/)
    }
    assert.match(codexBundle, /verified a new workflow or pitfall\s+that is reusable across tasks/)
    assert.match(codexBundle, /fixed a recurring problem/)
    assert.match(codexBundle, /material\s+gap in an existing skill/)

    assert.ok(
      ccbAgents.includes(
        '- 开始不熟悉的任务时,先用 `skill_search(query="关键词")` 找相关 skill,再 `skill_view(name)` 读取完整步骤。',
      ),
      '任务开始时的 skill discovery 契约不得改变',
    )
  })

  it('keeps the Codex bundle and fallback byte-identical', () => {
    assert.equal(codexBundle, codexInternals.CODEX_PREAMBLE)
  })
})
