import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getAgentModel } from '../agent'

/**
 * `CLAUDE_CODE_SUBAGENT_MODEL` is the platform's default pin for subagents (the
 * gateway sets it to a model inside the turn's allow-set). An explicit, non-alias
 * `Agent(model: "...")` must be able to override it; bare aliases must not (they
 * would resolve to models outside the allow-set and 403).
 */
describe('getAgentModel — CLAUDE_CODE_SUBAGENT_MODEL pin vs explicit tool model', () => {
  const PARENT = 'cursor-fable-5.1-high'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    else process.env.CLAUDE_CODE_SUBAGENT_MODEL = saved
  })

  test('pin + no tool model → pin', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.3-zai'
    expect(getAgentModel(undefined, PARENT)).toBe('glm-5.3-zai')
    expect(getAgentModel('inherit', PARENT)).toBe('glm-5.3-zai')
  })

  test('pin + explicit non-alias tool model → explicit wins', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.3-zai'
    expect(getAgentModel(undefined, PARENT, 'deepseek-v4-flash')).toBe(
      'deepseek-v4-flash',
    )
    expect(getAgentModel('haiku', PARENT, 'glm-5.3-zai')).toBe('glm-5.3-zai')
  })

  test('pin + bare alias tool model → still pinned', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.3-zai'
    expect(getAgentModel(undefined, PARENT, 'haiku')).toBe('glm-5.3-zai')
    expect(getAgentModel(undefined, PARENT, 'sonnet')).toBe('glm-5.3-zai')
    expect(getAgentModel(undefined, PARENT, 'opus')).toBe('glm-5.3-zai')
  })

  test('pin + empty-string tool model → pinned (empty is not an override)', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.3-zai'
    expect(getAgentModel(undefined, PARENT, '')).toBe('glm-5.3-zai')
  })

  test('pin + agent-definition model (frontmatter, not tool arg) → still pinned', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'glm-5.3-zai'
    expect(getAgentModel('deepseek-v4-flash', PARENT)).toBe('glm-5.3-zai')
  })

  test('no pin + explicit non-alias tool model → explicit', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(getAgentModel(undefined, PARENT, 'deepseek-v4-flash')).toBe(
      'deepseek-v4-flash',
    )
  })

  test('no pin + no tool model + inherit → parent', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    expect(getAgentModel(undefined, PARENT)).toBe(PARENT)
    expect(getAgentModel('inherit', PARENT)).toBe(PARENT)
  })
})
