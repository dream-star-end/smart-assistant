import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ccbDelegateMcpBudgetEnvironment,
  delegateMcpBudgetEnvironment,
  GROK_MCP_TOOL_TIMEOUT_SEC,
} from '../delegateMcpBudget.js'

const budget = (env: Record<string, string>) => Number(env.OPENCLAUDE_DELEGATE_MCP_BUDGET_MS)

describe('delegate MCP foreground budget', () => {
  it('lets a seven-minute Grok fan-out finish before its configured tools/call deadline', () => {
    const ms = budget(delegateMcpBudgetEnvironment(GROK_MCP_TOOL_TIMEOUT_SEC * 1000))
    assert.ok(ms > 7 * 60_000)
    assert.equal(ms, 585_000)
    assert.ok(ms < GROK_MCP_TOOL_TIMEOUT_SEC * 1000)
  })

  it('reserves a handoff/reply window for unknown and short configured clients', () => {
    assert.equal(budget(delegateMcpBudgetEnvironment()), 45_000)
    assert.equal(budget(delegateMcpBudgetEnvironment(60_000)), 45_000)
    assert.equal(budget(delegateMcpBudgetEnvironment(10_000)), 1)
  })

  it('respects CCB custom tool timeouts without changing its global timeout', () => {
    const env = { MCP_TOOL_TIMEOUT: '90000' }
    assert.equal(budget(ccbDelegateMcpBudgetEnvironment(env)), 75_000)
    assert.equal(env.MCP_TOOL_TIMEOUT, '90000')
    assert.equal(budget(ccbDelegateMcpBudgetEnvironment({})), 12 * 60 * 60_000 - 15_000)
    assert.equal(budget(ccbDelegateMcpBudgetEnvironment({ MCP_TOOL_TIMEOUT: 'invalid' })),
      budget(ccbDelegateMcpBudgetEnvironment({})))
  })
})
