import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TOOLS } from '../toolDefs.js'
import {
  filterSkillEvalTools,
  isSkillEvalBlockedTool,
  SKILL_EVAL_BLOCKED_TOOL_NAMES,
} from '../skillEvalToolPolicy.js'

describe('skill-eval MCP tool policy', () => {
  it('keeps only read-only inspection tools visible in eval sessions', () => {
    assert.deepEqual(
      filterSkillEvalTools(TOOLS, true).map((tool) => tool.name),
      ['skill_list', 'skill_search', 'skill_view', 'list_reminders'],
    )
  })

  it('blocks every persistent or delegation escape tool from direct calls', () => {
    for (const name of SKILL_EVAL_BLOCKED_TOOL_NAMES) {
      assert.equal(isSkillEvalBlockedTool(name), true, name)
    }
    assert.equal(isSkillEvalBlockedTool('list_reminders'), false)
    assert.equal(isSkillEvalBlockedTool('unknown_tool'), false)
  })

  it('does not change the normal-session tool list', () => {
    assert.deepEqual(filterSkillEvalTools(TOOLS, false), TOOLS)
  })
})
