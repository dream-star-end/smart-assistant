/**
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerMcpAvailability.test.ts
 *
 * Pins the CCB extra-prompt path so built-in openclaude-memory tools are in
 * availableMcpTools before buildPromptContext. Empty availableMcpTools would
 * let sanitizeUnavailableMcpClaims redact delegate_task / skill_search / etc.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { buildPromptContext, PLATFORM_MCP_TOOL_NAMES } from '../promptSlots.js'

describe('subprocessRunner MCP availability wiring', () => {
  test('PLATFORM_MCP_TOOL_NAMES is exported and includes the CCB platform tools', () => {
    const names: readonly string[] = PLATFORM_MCP_TOOL_NAMES
    for (const name of ['delegate_task', 'delegate_tasks', 'send_to_agent', 'skill_search']) {
      assert.ok(names.includes(name), name)
    }
  })

  test('CCB prompt path registers platform MCP tools before buildPromptContext', () => {
    const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')
    const promptIdx = src.indexOf('buildPromptContext(')
    assert.ok(promptIdx >= 0, 'buildPromptContext( call site not found')
    const before = src.slice(0, promptIdx)
    assert.ok(
      before.includes('addAvailableTools(PLATFORM_MCP_TOOL_NAMES)'),
      'addAvailableTools(PLATFORM_MCP_TOOL_NAMES) must appear before buildPromptContext(',
    )
    const launchIdx = before.indexOf('resolveMcpMemoryLaunch(')
    assert.ok(launchIdx >= 0, 'resolveMcpMemoryLaunch( must appear before buildPromptContext(')
    const launchCalls = src.match(/resolveMcpMemoryLaunch\(/g) ?? []
    assert.equal(
      launchCalls.length,
      1,
      `resolveMcpMemoryLaunch( must be called once and reused (got ${launchCalls.length})`,
    )
  })

  test('advertising the full platform MCP set does not redact tools as unregistered', async () => {
    const result = await buildPromptContext({
      agentId: 'main',
      provider: 'anthropic',
      availableMcpTools: [...PLATFORM_MCP_TOOL_NAMES],
    })
    assert.equal(result.content.includes('\uFF08\u5F53\u524D\u672A\u6CE8\u518C\uFF09'), false)
  })
})
