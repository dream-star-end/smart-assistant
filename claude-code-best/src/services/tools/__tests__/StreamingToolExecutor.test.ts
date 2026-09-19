import { afterEach, describe, expect, test } from 'bun:test'
import { StreamingToolExecutor } from '../StreamingToolExecutor.js'
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

describe('StreamingToolExecutor.discard()', () => {
  test('clears the internal tools array', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    // Access internal state via reflection
    const toolsBefore = (executor as unknown as { tools: unknown[] }).tools
    expect(toolsBefore).toHaveLength(0)

    executor.discard()

    const toolsAfter = (executor as unknown as { tools: unknown[] }).tools
    expect(toolsAfter).toHaveLength(0)
  })

  test('aborts the sibling abort controller', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    const siblingController = (
      executor as unknown as { siblingAbortController: AbortController }
    ).siblingAbortController
    expect(siblingController.signal.aborted).toBe(false)

    executor.discard()

    expect(siblingController.signal.aborted).toBe(true)
  })

  test('sets discarded flag so getCompletedResults yields nothing', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const results = [...executor.getCompletedResults()]
    expect(results).toHaveLength(0)
  })

  test('sets discarded flag so getRemainingResults yields nothing', async () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const results: unknown[] = []
    for await (const update of executor.getRemainingResults()) {
      results.push(update)
    }
    expect(results).toHaveLength(0)
  })

  test('clears progressAvailableResolve', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    const resolve = (
      executor as unknown as { progressAvailableResolve?: () => void }
    ).progressAvailableResolve
    expect(resolve).toBeUndefined()
  })

  test('can be called multiple times without error', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    expect(() => {
      executor.discard()
      executor.discard()
      executor.discard()
    }).not.toThrow()
  })

  test('releases references to allow GC of discarded executor', () => {
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)

    executor.discard()

    // All internal references should be cleared/released
    const internals = executor as unknown as {
      tools: unknown[]
      progressAvailableResolve?: () => void
      turnSpan: unknown
    }
    expect(internals.tools).toHaveLength(0)
    expect(internals.progressAvailableResolve).toBeUndefined()
    expect(internals.turnSpan).toBeNull()
  })
})

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
    id: 'toolu_a5',
    name: 'Bash',
    input: { command: 'true' },
  }
}

describe('StreamingToolExecutor.addTool advisor hermetic vs empty tools', () => {
  const saved = process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC
    else process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC = saved
  })

  test('profile=true tools=[] aborts and does not queue unknown tool_result', () => {
    process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC = '1'
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)
    executor.addTool(makeToolUse() as any, makeAssistant())
    expect(ctx.abortController.signal.aborted).toBe(true)
    const queued = (executor as unknown as { tools: unknown[] }).tools
    expect(queued).toHaveLength(0)
  })

  test('profile=false tools=[] keeps unknown tool_result and does not abort', () => {
    delete process.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC
    const ctx = makeMinimalContext()
    const executor = new StreamingToolExecutor([], () => true as any, ctx)
    executor.addTool(makeToolUse() as any, makeAssistant())
    expect(ctx.abortController.signal.aborted).toBe(false)
    const queued = (executor as unknown as { tools: Array<{ results: unknown[] }> }).tools
    expect(queued).toHaveLength(1)
    expect(JSON.stringify(queued[0]?.results ?? [])).toContain('No such tool available: Bash')
  })
})
