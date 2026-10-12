import { afterEach, describe, expect, test } from 'bun:test'
import {
  OPENCLAUDE_SESSION_CONTEXT_MARKER,
  appendSystemPromptFor,
  getOpenClaudeStaticPrompt,
  registerOpenClaudeAppendPrompt,
} from '../openclaudePromptLayout.js'

const SEP = '\n\n---\n\n'
const file = `STATIC A${SEP}STATIC B${SEP}${OPENCLAUDE_SESSION_CONTEXT_MARKER}${SEP}uid=3${SEP}memory index`
const flag = { OPENCLAUDE_PROMPT_LAYOUT: '2' }

afterEach(() => registerOpenClaudeAppendPrompt(undefined, {}))

describe('OpenClaude static-first append prompt (OCV5-383)', () => {
  test('the default prompt carries the static half and keeps only the dynamic half appended', () => {
    registerOpenClaudeAppendPrompt(file, flag)
    const staticHalf = getOpenClaudeStaticPrompt()
    expect(staticHalf).toBe(`STATIC A${SEP}STATIC B\n\n${OPENCLAUDE_SESSION_CONTEXT_MARKER}`)
    expect(appendSystemPromptFor(['intro', staticHalf!, 'env'], file)).toBe(
      `uid=3${SEP}memory index`,
    )
  })

  test('a custom prompt or agent that replaces the default keeps the whole file', () => {
    registerOpenClaudeAppendPrompt(file, flag)
    expect(appendSystemPromptFor(['custom agent prompt'], file)).toBe(file)
  })

  test('without the flag or the marker nothing changes', () => {
    registerOpenClaudeAppendPrompt(file, {})
    expect(getOpenClaudeStaticPrompt()).toBeNull()
    expect(appendSystemPromptFor(['intro'], file)).toBe(file)
    registerOpenClaudeAppendPrompt('no marker', flag)
    expect(getOpenClaudeStaticPrompt()).toBeNull()
    expect(appendSystemPromptFor(['intro'], 'no marker')).toBe('no marker')
  })

  test('an empty per-session half appends nothing next to the default prompt', () => {
    registerOpenClaudeAppendPrompt(`STATIC${SEP}${OPENCLAUDE_SESSION_CONTEXT_MARKER}`, flag)
    const staticHalf = getOpenClaudeStaticPrompt()!
    expect(appendSystemPromptFor([staticHalf], 'whatever')).toBeUndefined()
  })
})
