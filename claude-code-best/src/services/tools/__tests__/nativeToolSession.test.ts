import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { NativeToolSessionOptions } from '../createNativeToolSession.js'
// Same unbundled runtime defaults as the source CLI. No real model provider.
if (typeof globalThis.MACRO === 'undefined')
  Object.assign(globalThis, {
    MACRO: {
      VERSION: 'fixture',
      BUILD_TIME: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
      NATIVE_PACKAGE_URL: '',
      PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
    },
  })
process.argv.push('--bare')
const { createNativeToolSession } = await import('../createNativeToolSession.js')
const { getDefaultAppState } = await import('../../../state/AppStateStore.js')
const { createAssistantMessage, createUserMessage } = await import('../../../utils/messages.js')
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function fixtureTool(call: Tool['call'], overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'Fixture',
    inputSchema: z.object({ value: z.string() }),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isEnabled: () => true,
    maxResultSizeChars: 10000,
    call,
    description: async () => '',
    prompt: async () => '',
    userFacingName: () => '',
    checkPermissions: async (input) => ({ behavior: 'allow', updatedInput: input }),
    mapToolResultToToolResultBlockParam: (output, id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: JSON.stringify(output),
    }),
    ...overrides,
  } as Tool
}
function setup(tool: Tool, overrides: Partial<NativeToolSessionOptions> = {}) {
  const recorded: unknown[] = []
  const options: ToolUseContext['options'] = {
    commands: [],
    debug: false,
    mainLoopModel: 'fixture',
    tools: [tool],
    verbose: false,
    thinkingConfig: { type: 'disabled' },
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: true,
    agentDefinitions: { activeAgents: [], allAgents: [] },
  }
  let current!: () => ToolUseContext
  const session = createNativeToolSession({
    initialAppState: getDefaultAppState(),
    initialMessages: [],
    options,
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    handleElicitation: undefined,
    onStateChange: () => {},
    onViewChange: () => {},
    ownsTool: (name) => name === tool.name || Boolean(tool.aliases?.includes(name)),
    authorizeBatch: async () => {},
    beforeExecution: async () => {},
    beforeToolCall: async () => {},
    recordUpdate: async (update) => {
      recorded.push(update)
    },
    recordFailure: async (error) => {
      recorded.push({ error })
    },
    installBackgroundListeners: (get) => {
      current = get
      return () => {}
    },
    stopTasks: async () => {},
    drainBackground: async () => {},
    closeResources: async () => {},
    ...overrides,
  })
  function batch(ids = ['toolu_one']) {
    const blocks = ids.map((id) => ({
      type: 'tool_use' as const,
      caller: { type: 'direct' as const },
      id,
      name: tool.name,
      input: { value: id },
    }))
    const assistant = createAssistantMessage({ content: blocks })
    return session.executeBatch(blocks, [assistant], [assistant])
  }
  return { session, batch, recorded, current: () => current() }
}
describe('native real runTools lifetime', () => {
  test('keeps native cache limits, root reducers and current listener context across turns', async () => {
    let changes = 0
    const f = setup(
      fixtureTool(async () => ({ data: { ok: true } })),
      {
        onStateChange: () => {
          changes++
        },
      },
    )
    const first = f.session.getContext()
    expect(first.readFileState.max).toBe(100)
    expect(first.readFileState.maxSize).toBe(25 * 1024 * 1024)
    first.loadedNestedMemoryPaths!.add('/fixture/CLAUDE.md')
    first.readFileState.set('/fixture/file', {
      content: 'one',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    first.updateFileHistoryState((state) => state)
    expect(changes).toBe(0)
    const message = createUserMessage({ content: 'second turn' })
    f.session.beginTurn([message])
    const second = f.current()
    expect(second.messages).toEqual([message])
    expect(second.readFileState).toBe(first.readFileState)
    expect(second.loadedNestedMemoryPaths).toBe(first.loadedNestedMemoryPaths)
    expect(second.nestedMemoryAttachmentTriggers).not.toBe(first.nestedMemoryAttachmentTriggers)
    second.abortController.abort('current-listener')
    expect(first.abortController.signal.aborted).toBe(false)
    expect(second.abortController.signal.aborted).toBe(true)
    await f.session.dispose()
  })
  test('detached concurrent progress stays busy; dispose waits actual calls and records both results', async () => {
    const entered = gate()
    const release = gate()
    let calls = 0
    let finished = 0
    let removed = 0
    let stops = 0
    let background = 0
    let resources = 0
    const f = setup(
      fixtureTool(async (_input, ctx, _can, _parent, progress) => {
        calls++
        if (calls === 2) entered.release()
        progress?.({
          toolUseID: ctx.toolUseId!,
          data: {
            type: 'bash_progress',
            output: 'fixture',
            fullOutput: 'fixture',
            elapsedTimeSeconds: 0,
            totalLines: 1,
          },
        } as never)
        await release.promise
        finished++
        return { data: { finished } }
      }),
      {
        installBackgroundListeners: () => () => {
          removed++
        },
        stopTasks: async () => {
          stops++
        },
        drainBackground: async () => {
          background++
        },
        closeResources: async () => {
          resources++
        },
      },
    )
    const batch = f.batch(['toolu_a', 'toolu_b'])
    await entered.promise
    expect((await batch.stream.next()).done).toBe(false)
    await batch.stream.return!()
    expect(() => f.session.beginTurn([])).toThrow('native-session-batch-busy')
    let disposed = false
    const closing = f.session.dispose().then(() => {
      disposed = true
    })
    await Bun.sleep(10)
    expect(disposed).toBe(false)
    expect(finished).toBe(0)
    expect(removed).toBe(0)
    release.release()
    await closing
    await batch.done
    expect(finished).toBe(2)
    expect(removed).toBe(1)
    expect(stops).toBe(2)
    expect(background).toBe(1)
    expect(resources).toBe(1)
    const terminal = f.recorded.filter((update: any) => update.message?.type === 'user')
    expect(terminal).toHaveLength(2)
    expect(f.session.state.view().inProgressToolUseIDs.size).toBe(0)
  }, 20000)
  test('rechecks the permission-modified input immediately before actual tool.call', async () => {
    const order: string[] = []
    const f = setup(
      fixtureTool(async (input) => {
        order.push(`call:${input.value}`)
        return { data: { ok: true } }
      }),
      {
        beforeExecution: async () => {
          order.push('dispatch')
        },
        canUseTool: async () => {
          order.push('permission')
          return { behavior: 'allow', updatedInput: { value: 'changed' } }
        },
        beforeToolCall: async (request) => {
          order.push(`guard:${(request.input as any).value}`)
        },
      },
    )
    const batch = f.batch()
    batch.detach()
    await batch.done
    expect(order).toEqual(['dispatch', 'permission', 'guard:changed', 'call:changed'])
    await f.session.dispose()
  })
  test('no microtask gap permits an effect to begin after the final live check was cancelled', async () => {
    const order: string[] = []
    let cancel: () => void = () => {
      throw Error('fixture-not-ready')
    }
    const f = setup(
      fixtureTool(async (_input, context) => {
        order.push(context.abortController.signal.aborted ? 'effect-after-abort' : 'effect-live')
        return { data: {} }
      }),
      {
        beforeToolCall: async () => {
          queueMicrotask(() =>
            queueMicrotask(() => {
              order.push('abort')
              cancel()
            }),
          )
        },
      },
    )
    cancel = () => f.session.abort('scheduled-cancel')
    const batch = f.batch()
    batch.detach()
    await batch.done
    expect(order).toEqual(['effect-live', 'abort'])
    await f.session.dispose()
  })
  test('a late dispatch grant after disposal cannot reach validation, permission or effect', async () => {
    const entered = gate()
    const release = gate()
    let effects = 0
    let validations = 0
    const f = setup(
      fixtureTool(
        async () => {
          effects++
          return { data: {} }
        },
        {
          validateInput: async () => {
            validations++
            return { result: true }
          },
        },
      ),
      {
        beforeExecution: async () => {
          entered.release()
          await release.promise
        },
      },
    )
    const batch = f.batch()
    batch.detach()
    await entered.promise
    const closing = f.session.dispose()
    release.release()
    await closing
    expect(effects).toBe(0)
    expect(validations).toBe(0)
  })
  test('failed task stop keeps listeners and permits cleanup retry while admission remains closed', async () => {
    let stops = 0
    let removed = 0
    const f = setup(
      fixtureTool(async () => ({ data: {} })),
      {
        stopTasks: async () => {
          if (++stops === 1) throw Error('stop-pending')
        },
        installBackgroundListeners: () => () => {
          removed++
        },
      },
    )
    await expect(f.session.dispose()).rejects.toThrow('stop-pending')
    expect(removed).toBe(0)
    expect(() => f.batch()).toThrow('native-session-closed')
    await f.session.dispose()
    expect(removed).toBe(1)
  })
  test('refuses undeclared legacy alias without reaching fallback tool lookup', async () => {
    const f = setup(fixtureTool(async () => ({ data: {} })))
    const block = {
      type: 'tool_use' as const,
      caller: { type: 'direct' as const },
      id: 'toolu_other',
      name: 'KillShell',
      input: {},
    }
    expect(() => f.session.executeBatch([block], [], [])).toThrow('native-tool-owner')
    await f.session.dispose()
  })
})
