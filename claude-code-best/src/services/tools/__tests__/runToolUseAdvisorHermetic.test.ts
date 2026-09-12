import { afterEach, describe, expect, test } from 'bun:test'
import { runToolUse } from '../toolExecution.js'
import type { ToolUseContext } from '../../../Tool.js'

function makeMinimalContext(): ToolUseContext {
  const abortController = new AbortController()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { builtinAgents: [], customAgents: [] },
    },
    abortController,
    readFileState: {
      get: () => undefined,
      set: () => {},
      delete: () => false,
      has: () => false,
      clear: () => {},
    } as any,
    getAppState: () => ({}) as any,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function makeAssistant() {
  return {
    uuid: 'asst-a5',
    type: 'assistant',
    message: { id: 'msg-a5', role: 'assistant', content: [] },
    requestId: 'req-a5',
  } as any
}

function makeToolUse() {
  return {
    type: 'tool_use' as const,
    id: 'toolu_a5_rt',
    name: 'Bash',
    input: { command: 'true' },
  }
}

describe('runToolUse advisor hermetic vs empty tools', () => {
  const saved = process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC
    else process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC = saved
  })

  test('profile=true tools=[] aborts and yields no tool_result', async () => {
    process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC = '1'
    const ctx = makeMinimalContext()
    const yielded: unknown[] = []
    for await (const update of runToolUse(
      makeToolUse() as any,
      makeAssistant(),
      async () => ({ behavior: 'allow' }) as any,
      ctx,
    )) {
      yielded.push(update)
    }
    expect(ctx.abortController.signal.aborted).toBe(true)
    expect(yielded).toHaveLength(0)
  })

  test('profile=false tools=[] yields unknown tool_result and does not abort', async () => {
    delete process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC
    const ctx = makeMinimalContext()
    const yielded: unknown[] = []
    for await (const update of runToolUse(
      makeToolUse() as any,
      makeAssistant(),
      async () => ({ behavior: 'allow' }) as any,
      ctx,
    )) {
      yielded.push(update)
    }
    expect(ctx.abortController.signal.aborted).toBe(false)
    expect(JSON.stringify(yielded)).toContain('No such tool available: Bash')
  })
})
