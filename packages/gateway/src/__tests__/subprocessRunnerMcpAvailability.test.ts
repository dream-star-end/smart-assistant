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

import {
  CCB_SKILL_EVAL_HIDDEN_PLATFORM_TOOLS,
  projectCcbMcpAvailability,
} from '../ccbMcpAvailability.js'
import { inspectCcbPromptContextAvailability } from '../ccbMcpAvailabilitySourceContract.js'
import {
  buildPromptContext,
  PLATFORM_MCP_TOOL_NAMES,
  sanitizeUnavailableMcpClaims,
} from '../promptSlots.js'

const LAUNCH = { command: 'node', args: ['mcp'] }
const UNREGISTERED = '\uFF08\u5F53\u524D\u672A\u6CE8\u518C\uFF09'

function parseQuotedNames(source: string, exportName: string): string[] {
  const re = new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const`)
  const block = source.match(re)
  assert.ok(block, `${exportName} array not found`)
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('subprocessRunner MCP availability wiring', () => {
  test('PLATFORM_MCP_TOOL_NAMES is exported and includes the CCB platform tools', () => {
    const names: readonly string[] = PLATFORM_MCP_TOOL_NAMES
    for (const name of ['delegate_task', 'delegate_tasks', 'send_to_agent', 'skill_search']) {
      assert.ok(names.includes(name), name)
    }
  })

  test('CCB prompt path registers platform MCP tools before buildPromptContext', () => {
    const configured = ['browser', 'search']
    assert.deepEqual(
      projectCcbMcpAvailability({ configuredTools: configured, mcpLaunch: null }),
      configured,
    )
    assert.equal(
      projectCcbMcpAvailability({ configuredTools: configured, mcpLaunch: null }).includes(
        'delegate_task',
      ),
      false,
    )

    const withLaunch = projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: LAUNCH })
    for (const name of PLATFORM_MCP_TOOL_NAMES) {
      assert.ok(withLaunch.includes(name), name)
    }

    const evalNames = projectCcbMcpAvailability({
      configuredTools: [],
      mcpLaunch: LAUNCH,
      skillEvalMode: true,
    })
    for (const name of ['delegate_task', 'skill_save', 'task_create']) {
      assert.equal(evalNames.includes(name), false, name)
    }
    for (const name of ['skill_search', 'skill_view', 'skill_list', 'list_reminders']) {
      assert.ok(evalNames.includes(name), name)
    }

    const trainNames = projectCcbMcpAvailability({
      configuredTools: [],
      mcpLaunch: LAUNCH,
      skillTrainRunId: 'run-1',
    })
    assert.equal(trainNames.includes('skill_save'), false)
    assert.equal(trainNames.includes('skill_delete'), false)
    assert.ok(trainNames.includes('delegate_task'))
    assert.equal(trainNames.includes('skill_propose'), false)

    const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')
    const promptIdx = src.indexOf('buildPromptContext(')
    assert.ok(promptIdx >= 0, 'buildPromptContext( call site not found')
    const before = src.slice(0, promptIdx)
    assert.ok(
      before.includes('projectCcbMcpAvailability('),
      'projectCcbMcpAvailability( must appear before buildPromptContext(',
    )
    assert.equal(
      src.includes('if (mcpLaunch) addAvailableTools('),
      false,
      'inverted if (mcpLaunch) addAvailableTools( must not exist',
    )
    const launchIdx = before.indexOf('resolveMcpMemoryLaunch(')
    assert.ok(launchIdx >= 0, 'resolveMcpMemoryLaunch( must appear before buildPromptContext(')
    const launchCalls = src.match(/resolveMcpMemoryLaunch\(/g) ?? []
    assert.equal(
      launchCalls.length,
      1,
      `resolveMcpMemoryLaunch( must be called once and reused (got ${launchCalls.length})`,
    )
    const tryWindow = src.slice(Math.max(0, launchIdx - 200), launchIdx)
    assert.ok(tryWindow.includes('try {'), 'resolveMcpMemoryLaunch( must be wrapped in try {')
  })

  test('buildPromptContext consumes projectedMcpTools from projectCcbMcpAvailability', () => {
    const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')
    const binding = inspectCcbPromptContextAvailability(src)
    assert.equal(binding.projectionDeclared, true, 'projectionDeclared')
    assert.equal(
      binding.consumesProjection,
      true,
      `buildPromptContext must consume projectedMcpTools (availableMcpTools initializer: ${binding.availableMcpToolsInitializer})`,
    )
  })

  test('inspectCcbPromptContextAvailability ignores comment bait and missing call sites', () => {
    const correct = [
      'const projectedMcpTools = projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: null })',
      'void buildPromptContext({ availableMcpTools: projectedMcpTools })',
    ].join('\n')
    const correctBinding = inspectCcbPromptContextAvailability(correct)
    assert.equal(correctBinding.projectionDeclared, true)
    assert.equal(correctBinding.consumesProjection, true)
    assert.equal(correctBinding.availableMcpToolsInitializer, 'projectedMcpTools')

    const commentBait = [
      'const projectedMcpTools = projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: null })',
      'void buildPromptContext({ availableMcpTools: [...availableMcpTools] }) // availableMcpTools: projectedMcpTools',
    ].join('\n')
    const baitBinding = inspectCcbPromptContextAvailability(commentBait)
    assert.equal(baitBinding.consumesProjection, false)
    assert.equal(baitBinding.availableMcpToolsInitializer, '[...availableMcpTools]')

    const missing = 'const projectedMcpTools = projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: null })'
    const missingBinding = inspectCcbPromptContextAvailability(missing)
    assert.equal(missingBinding.availableMcpToolsInitializer, null)
    assert.equal(missingBinding.consumesProjection, false)
  })

  test('skill-eval filtering does not drop same-named configured tools', () => {
    const names = projectCcbMcpAvailability({
      configuredTools: ['skill_save', 'browser'],
      mcpLaunch: {},
      skillEvalMode: true,
    })
    assert.ok(names.includes('skill_save'), 'configured skill_save must be kept')
    assert.ok(names.includes('browser'), 'configured browser must be kept')
    assert.equal(names.includes('delegate_task'), false, 'platform delegate_task must stay hidden')
  })

  test('advertising the full platform MCP set does not redact tools as unregistered', async () => {
    const result = await buildPromptContext({
      agentId: 'main',
      provider: 'anthropic',
      availableMcpTools: [...PLATFORM_MCP_TOOL_NAMES],
    })
    assert.equal(result.content.includes(UNREGISTERED), false)
  })

  test('projection to sanitizer redacts delegate_task only when launch is null', () => {
    const sample = '走 MCP delegate_task/delegate_tasks'
    const redacted = sanitizeUnavailableMcpClaims(
      sample,
      projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: null }),
    )
    assert.ok(redacted.includes(UNREGISTERED), redacted)
    assert.equal(redacted.includes('delegate_task'), false)
    assert.equal(
      sanitizeUnavailableMcpClaims(
        sample,
        projectCcbMcpAvailability({ configuredTools: [], mcpLaunch: LAUNCH }),
      ),
      sample,
    )
  })

  test('CCB_SKILL_EVAL_HIDDEN_PLATFORM_TOOLS matches mcp-memory skill-eval policy', () => {
    const policy = readFileSync(
      new URL('../../../mcp-memory/src/skillEvalToolPolicy.ts', import.meta.url),
      'utf8',
    )
    assert.deepEqual(
      [...CCB_SKILL_EVAL_HIDDEN_PLATFORM_TOOLS],
      parseQuotedNames(policy, 'SKILL_EVAL_BLOCKED_TOOL_NAMES'),
    )
  })
})
