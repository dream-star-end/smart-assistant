/**
 * OCV5-382: run in its own bun process by __tests__/openclaudePromptTrim.test.ts —
 * prompts.ts must not see module mocks other test files register.
 */
import { afterEach, describe, expect, test } from 'bun:test'

// Build-time define (see promptEngineeringAudit.runner.ts); bun test has none.
if (typeof (globalThis as Record<string, unknown>).MACRO === 'undefined') {
  ;(globalThis as Record<string, unknown>).MACRO = { ISSUES_EXPLAINER: '' }
}
import { registerOpenClaudeAppendPrompt } from '../utils/openclaudePromptLayout.js'
import { computeSimpleEnvInfo, getSimpleDoingTasksSection } from './prompts.js'

const saved = process.env.OPENCLAUDE_PROMPT_LAYOUT
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_PROMPT_LAYOUT')
  else process.env.OPENCLAUDE_PROMPT_LAYOUT = saved
  registerOpenClaudeAppendPrompt(undefined, {})
})

const stale = [
  'The most recent Claude model family',
  'Fast mode for Claude Code',
  'Claude Code is available as a CLI',
]

describe('OpenClaude runner drops upstream product text (OCV5-382)', () => {
  test('environment section keeps the model line but not stale family / Fast mode lines', async () => {
    process.env.OPENCLAUDE_PROMPT_LAYOUT = '2'
    const env = await computeSimpleEnvInfo('claude-haiku-4-5', [])
    for (const line of stale) expect(env.includes(line)).toBe(false)
    Reflect.deleteProperty(process.env, 'OPENCLAUDE_PROMPT_LAYOUT')
    const upstream = await computeSimpleEnvInfo('claude-haiku-4-5', [])
    for (const line of stale) expect(upstream.includes(line)).toBe(true)
  })

  test('doing-tasks has no /issue, /share, Slack channel or truncated feedback line', async () => {
    process.env.OPENCLAUDE_PROMPT_LAYOUT = '2'
    const text = getSimpleDoingTasksSection()
    for (const needle of ['/issue', 'C07VBSHV7EV', 'To give feedback, users should']) {
      expect(text.includes(needle)).toBe(false)
    }
    Reflect.deleteProperty(process.env, 'OPENCLAUDE_PROMPT_LAYOUT')
    const upstream = getSimpleDoingTasksSection()
    expect(upstream.includes('C07VBSHV7EV')).toBe(true)
  })
})
