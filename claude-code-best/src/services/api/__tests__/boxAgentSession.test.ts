import { afterEach, describe, expect, test } from 'bun:test'
import { getSessionId } from 'src/bootstrap/state.js'
import { runWithAgentContext } from 'src/utils/agentContext.js'
import { getAPIMetadata } from '../claude.js'

const SUB_RE = /^agent-[a-f0-9]{32}$/

// bun sets NODE_ENV=test. getAPIMetadata reads auth, and that path requires
// a key to be present. This placeholder is not a credential. It selects the
// external-key path so no OAuth account is loaded.
const placeholderKey = 'test-box-agent-session-not-a-real-key'
process.env.ANTHROPIC_API_KEY = placeholderKey

function sessionOf(metadata: { user_id: string }): string {
  const parsed = JSON.parse(metadata.user_id) as { session_id?: unknown }
  if (typeof parsed.session_id !== 'string') {
    throw new Error('session_id missing')
  }
  return parsed.session_id
}

const savedExtra = process.env.CLAUDE_CODE_EXTRA_METADATA
afterEach(() => {
  // Empty string is absent for getAPIMetadata. Assigning undefined would
  // stringify to "undefined" on process.env.
  process.env.CLAUDE_CODE_EXTRA_METADATA = savedExtra ?? ''
  process.env.ANTHROPIC_API_KEY = placeholderKey
})

describe('Box subagent session id', () => {
  test('a root request keeps the process session id', () => {
    expect(sessionOf(getAPIMetadata())).toBe(getSessionId())
  })

  test('an agent id gets a stable fingerprint-safe subsession', () => {
    const root = getSessionId()
    const first = sessionOf(getAPIMetadata('agent-a'))
    const again = sessionOf(getAPIMetadata('agent-a'))
    const other = sessionOf(getAPIMetadata('agent-b'))
    expect(first).toBe(again)
    expect(first).not.toBe(root)
    expect(other).not.toBe(first)
    expect(first).toMatch(SUB_RE)
    expect(other).toMatch(SUB_RE)
    expect(first).not.toContain(root)
    expect(sessionOf(getAPIMetadata())).toBe(root)
  })

  test('agent context uses the same subsession without an argument', () => {
    const fromArg = sessionOf(getAPIMetadata('agent-a'))
    const fromContext = runWithAgentContext(
      {
        agentId: 'agent-a',
        agentType: 'subagent',
        isBuiltIn: true,
        subagentName: 'general-purpose',
      },
      () => sessionOf(getAPIMetadata()),
    )
    expect(fromContext).toBe(fromArg)
    expect(fromContext).not.toBe(getSessionId())
  })

  test('nested agent context does not keep the outer agent session', () => {
    const outer = sessionOf(getAPIMetadata('outer-agent'))
    const inner = runWithAgentContext(
      { agentId: 'outer-agent', agentType: 'subagent' },
      () =>
        runWithAgentContext(
          { agentId: 'inner-agent', agentType: 'subagent' },
          () => sessionOf(getAPIMetadata()),
        ),
    )
    expect(inner).toBe(sessionOf(getAPIMetadata('inner-agent')))
    expect(inner).not.toBe(outer)
  })

  test('extra metadata cannot force the subagent onto the root session', () => {
    const root = getSessionId()
    process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({
      session_id: root,
      oc_turn_key: 'ab'.repeat(32),
      oc_mode: 'chat',
    })
    const metadata = getAPIMetadata('agent-a')
    const parsed = JSON.parse(metadata.user_id) as {
      session_id?: string
      oc_turn_key?: string
    }
    expect(parsed.session_id).toMatch(SUB_RE)
    expect(parsed.session_id).not.toBe(root)
    expect(parsed.oc_turn_key).toBe('ab'.repeat(32))
  })

  test('an agent id outside the fingerprint charset still hashes safely', () => {
    const id = sessionOf(getAPIMetadata('researcher@my-team'))
    expect(id).toMatch(SUB_RE)
    expect(id).not.toBe(getSessionId())
  })
})
