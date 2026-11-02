import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { Tool, ToolUseContext } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
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
  test('per-tool cancellation during dispatch blocks validation while the session remains live', async () => {
    const entered = gate()
    const release = gate()
    let validations = 0
    let effects = 0
    const child = new AbortController()
    let dispatchedSignal: AbortSignal | undefined
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
        beforeExecution: async (_request, signal) => {
          dispatchedSignal = signal
          entered.release()
          await release.promise
        },
      },
    )
    const context = f.session.getContext()
    const { blocks, assistant } = requestBlocks(['Fixture'])
    const { runToolUse } = await import('../toolExecution.js')
    const reading = collect(
      runToolUse(
        blocks[0]!,
        assistant,
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
        { ...context, abortController: child },
      ),
    )
    await entered.promise
    child.abort('sibling_error')
    expect(context.abortController.signal.aborted).toBe(false)
    release.release()
    const updates = await reading
    expect(
      updates.some(
        (update) =>
          update.message?.type === 'user' &&
          JSON.stringify(update.message.message?.content).includes('native-session-aborted'),
      ),
    ).toBe(true)
    expect(dispatchedSignal).toBe(child.signal)
    expect(validations).toBe(0)
    expect(effects).toBe(0)
    await f.session.dispose()
  })
  test('streaming child cancellation during the final gate prevents an effect with a live session', async () => {
    const entered = gate()
    const release = gate()
    let effects = 0
    let child: AbortController | undefined
    let checkedSignal: AbortSignal | undefined
    const f = setup(
      fixtureTool(async () => {
        effects++
        return { data: {} }
      }),
      {
        canUseTool: async (_tool, input, context) => {
          child = context.abortController
          return { behavior: 'allow', updatedInput: input }
        },
        beforeToolCall: async (_request, signal) => {
          checkedSignal = signal
          entered.release()
          await release.promise
        },
      },
    )
    const context = f.session.getContext()
    const executor = new StreamingToolExecutor(
      context.options.tools,
      async (_tool, input, toolContext) => {
        child = toolContext.abortController
        return { behavior: 'allow', updatedInput: input }
      },
      context,
    )
    const { blocks, assistant } = requestBlocks(['Fixture'])
    executor.addTool(blocks[0]!, assistant)
    const reading = collect(executor.getRemainingResults())
    await entered.promise
    expect(child).toBeDefined()
    expect(child).not.toBe(context.abortController)
    child!.abort('sibling_error')
    expect(context.abortController.signal.aborted).toBe(false)
    release.release()
    const updates = await reading
    await executor.drain()
    expect(effects).toBe(0)
    expect(checkedSignal).toBe(child!.signal)
    expect(updates.some((update) => update.message?.type === 'user')).toBe(true)
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

// These exercise the actual native schedulers with a transport port. They do
// not claim network authentication or real Host admission is implemented.
const { runTools } = await import('../toolOrchestration.js')
const { StreamingToolExecutor } = await import('../StreamingToolExecutor.js')
type HostRoute = Extract<import('../nativeToolRouting.js').NativeToolRoute, { owner: 'host' }>
function remoteRoute(execute: HostRoute['execute'], safe = true): HostRoute {
  return { owner: 'host', isConcurrencySafe: safe, interruptBehavior: 'cancel', execute }
}
function requestBlocks(names: string[]) {
  const blocks = names.map((name, i) => ({
    type: 'tool_use' as const,
    caller: { type: 'direct' as const },
    id: `toolu_route_${i}`,
    name,
    input: { value: String(i) },
  }))
  return { blocks, assistant: createAssistantMessage({ content: blocks }) }
}
function terminal(block: { id: string }, assistant: AssistantMessage) {
  return {
    message: createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: block.id, content: 'fixture-result' }],
      sourceToolAssistantUUID: assistant.uuid,
    }),
  }
}
async function collect<T>(stream: AsyncIterable<T>) {
  const updates: T[] = []
  for await (const update of stream) updates.push(update)
  return updates
}
describe('native routing in actual schedulers', () => {
  test('redirects before any Worker schema/classification/validation/permission/effect; Host runs full pipeline', async () => {
    const order: string[] = []
    const worker = setup(
      fixtureTool(
        async () => {
          throw Error('worker-effect')
        },
        {
          inputSchema: {
            safeParse: () => {
              throw Error('worker-schema')
            },
          } as never,
          isConcurrencySafe: () => {
            throw Error('worker-classify')
          },
          validateInput: async () => {
            throw Error('worker-validation')
          },
        },
      ),
    )
    const host = setup(
      fixtureTool(
        async () => {
          order.push('host-effect')
          return { data: { ok: true } }
        },
        {
          validateInput: async () => {
            order.push('host-validation')
            return { result: true }
          },
        },
      ),
      {
        canUseTool: async (_tool, input) => {
          order.push('host-permission')
          return { behavior: 'allow', updatedInput: input }
        },
      },
    )
    const ctx = worker.session.getContext()
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async () =>
        remoteRoute(async function* ({ block, assistantMessage }) {
          const batch = host.session.executeBatch([block], [assistantMessage], [assistantMessage])
          for await (const message of batch.stream) yield { message }
          await batch.done
        }),
    }
    const { blocks, assistant } = requestBlocks(['Fixture'])
    const updates = await collect(
      runTools(
        blocks,
        [assistant],
        async () => {
          throw Error('worker-permission')
        },
        ctx,
      ),
    )
    expect(order).toEqual(['host-validation', 'host-permission', 'host-effect'])
    expect(updates.some((u) => u.message?.type === 'user')).toBe(true)
    expect(host.recorded.some((u: any) => u.message?.type === 'user')).toBe(true)
    await host.session.dispose()
    await worker.session.dispose()
  })
  test('classification failure returns an explicit error with zero local fallback', async () => {
    let effects = 0
    const f = setup(
      fixtureTool(async () => {
        effects++
        return { data: {} }
      }),
    )
    const ctx = f.session.getContext()
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async () => {
        throw Error('offline')
      },
    }
    const { blocks, assistant } = requestBlocks(['Fixture'])
    const updates = await collect(
      runTools(
        blocks,
        [assistant],
        async () => {
          throw Error('worker-permission')
        },
        ctx,
      ),
    )
    expect(effects).toBe(0)
    expect(JSON.stringify(updates)).toContain('Remote tool classification unavailable')
    await f.session.dispose()
  })
  test('serial context modifiers precede classification of following tools', async () => {
    const f = setup(
      fixtureTool(
        async () => ({
          data: {},
          contextModifier: (context) => ({
            ...context,
            options: { ...context.options, mainLoopModel: 'after-control' },
          }),
        }),
        { isConcurrencySafe: () => false },
      ),
    )
    const ctx = f.session.getContext()
    const seen: string[] = []
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async (block, context) => {
        if (block.name === 'Fixture') return { owner: 'worker' }
        seen.push(context.options.mainLoopModel)
        return remoteRoute(async function* ({ block, assistantMessage }) {
          yield terminal(block, assistantMessage)
        })
      },
    }
    const { blocks, assistant } = requestBlocks(['Fixture', 'Remote'])
    await collect(
      runTools(
        blocks,
        [assistant],
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
        ctx,
      ),
    )
    expect(seen).toEqual(['after-control'])
    await f.session.dispose()
  })
  test('pending classification blocks later effects and waits without starving timers', async () => {
    const first = gate()
    const entered = gate()
    const release = gate()
    const f = setup(fixtureTool(async () => ({ data: {} })))
    const ctx = f.session.getContext()
    let calls = 0
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async (block) => {
        if ((block.input as { value: string }).value === '0') await first.promise
        return remoteRoute(async function* ({ block, assistantMessage }) {
          calls++
          if (calls === 2) entered.release()
          await release.promise
          yield terminal(block, assistantMessage)
        })
      },
    }
    const { blocks, assistant } = requestBlocks(['Remote', 'Remote'])
    const executor = new StreamingToolExecutor(
      [],
      async () => {
        throw Error('local-permission')
      },
      ctx,
    )
    for (const block of blocks) executor.addTool(block, assistant)
    const done = collect(executor.getRemainingResults())
    await Bun.sleep(10)
    expect(calls).toBe(0)
    first.release()
    await entered.promise
    expect(calls).toBe(2)
    release.release()
    expect((await done).filter((u) => u.message?.type === 'user')).toHaveLength(2)
    await executor.drain()
    await f.session.dispose()
  })
  test('streaming preserves concurrent reads, exclusive barriers and remote interrupt behavior', async () => {
    const entered = gate()
    const release = gate()
    const exclusive = gate()
    const releaseExclusive = gate()
    const f = setup(fixtureTool(async () => ({ data: {} })))
    const ctx = f.session.getContext()
    const calls: string[] = []
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async (block) =>
        remoteRoute(async function* ({ block, assistantMessage }) {
          calls.push((block.input as { value: string }).value)
          if (calls.length === 2) entered.release()
          if (
            (block.input as { value: string }).value === '0' ||
            (block.input as { value: string }).value === '1'
          )
            await release.promise
          if (block.name === 'Exclusive') {
            exclusive.release()
            await releaseExclusive.promise
          }
          yield terminal(block, assistantMessage)
        }, block.name !== 'Exclusive'),
    }
    const { blocks, assistant } = requestBlocks(['Remote', 'Remote', 'Exclusive', 'Remote'])
    const executor = new StreamingToolExecutor(
      [],
      async () => {
        throw Error('local')
      },
      ctx,
    )
    for (const block of blocks) executor.addTool(block, assistant)
    const done = collect(executor.getRemainingResults())
    await entered.promise
    expect(calls).toEqual(['0', '1'])
    expect(f.session.state.view().interruptible).toBe(true)
    release.release()
    await exclusive.promise
    expect(calls).toEqual(['0', '1', '2'])
    releaseExclusive.release()
    await done
    expect(calls).toEqual(['0', '1', '2', '3'])
    await executor.drain()
    await f.session.dispose()
  })
  test('discard keeps in-flight work in drain and late classification cannot restart', async () => {
    const classify = gate()
    const entered = gate()
    const release = gate()
    const f = setup(fixtureTool(async () => ({ data: {} })))
    const ctx = f.session.getContext()
    let calls = 0
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async (block) => {
        if ((block.input as { value: string }).value === '1') await classify.promise
        return remoteRoute(async function* ({ block, assistantMessage }) {
          calls++
          entered.release()
          await release.promise
          yield terminal(block, assistantMessage)
        })
      },
    }
    const { blocks, assistant } = requestBlocks(['Remote', 'Remote'])
    const executor = new StreamingToolExecutor(
      [],
      async () => {
        throw Error('local')
      },
      ctx,
    )
    for (const block of blocks) executor.addTool(block, assistant)
    await entered.promise
    executor.discard()
    let drained = false
    const draining = executor.drain().then(() => {
      drained = true
    })
    classify.release()
    await Bun.sleep(10)
    expect(calls).toBe(1)
    expect(drained).toBe(false)
    release.release()
    await draining
    expect(calls).toBe(1)
    await f.session.dispose()
  })
  test('dispatch unknown rejects the model-facing stream instead of fabricating a retryable tool result', async () => {
    const f = setup(fixtureTool(async () => ({ data: {} })))
    const ctx = f.session.getContext()
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async () =>
        remoteRoute(async function* () {
          yield await Promise.reject(Error('native-operation-unknown'))
        }),
    }
    const { blocks, assistant } = requestBlocks(['Remote'])
    await expect(
      collect(
        runTools(
          blocks,
          [assistant],
          async () => {
            throw Error('local')
          },
          ctx,
        ),
      ),
    ).rejects.toThrow('native-operation-unknown')
    const executor = new StreamingToolExecutor(
      [],
      async () => {
        throw Error('local')
      },
      ctx,
    )
    executor.addTool(blocks[0]!, assistant)
    await expect(collect(executor.getRemainingResults())).rejects.toThrow(
      'native-operation-unknown',
    )
    await expect(executor.drain()).rejects.toThrow('native-operation-unknown')
    await f.session.dispose()
  })
})

describe('streaming context revision barriers', () => {
  test('reclassifies tools queued before a serial control modifier completes', async () => {
    const entered = gate()
    const release = gate()
    const f = setup(
      fixtureTool(
        async () => {
          entered.release()
          await release.promise
          return {
            data: {},
            contextModifier: (context) => {
              const getAppState = context.getAppState
              return {
                ...context,
                options: { ...context.options, mainLoopModel: 'after-control' },
                // Same fresh-object getter pattern as Skill allowedTools/effort.
                getAppState: () => ({ ...getAppState(), effortValue: 'high' }),
              }
            },
          }
        },
        { isConcurrencySafe: () => false },
      ),
    )
    const ctx = f.session.getContext()
    const seen: string[] = []
    ctx.nativeToolRouting = {
      getContextRevision: (context) =>
        `${context.options.mainLoopModel}:${context.getAppState().effortValue ?? 'none'}`,
      prepare: async (block, context) => {
        if (block.name === 'Fixture') return { owner: 'worker' }
        const model = context.options.mainLoopModel
        seen.push(model)
        return remoteRoute(async function* ({ block, assistantMessage, context }) {
          expect(context.options.mainLoopModel).toBe(model)
          yield terminal(block, assistantMessage)
        })
      },
    }
    const { blocks, assistant } = requestBlocks(['Fixture', 'Remote'])
    const executor = new StreamingToolExecutor(
      ctx.options.tools,
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      ctx,
    )
    for (const block of blocks) executor.addTool(block, assistant)
    const done = collect(executor.getRemainingResults())
    await entered.promise
    expect(seen).toEqual(['fixture'])
    release.release()
    await done
    expect(seen).toEqual(['fixture', 'after-control'])
    const current = executor.getUpdatedContext()
    expect(current.getAppState()).not.toBe(current.getAppState())
    expect(current.getAppState().effortValue).toBe('high')
    await executor.drain()
    await f.session.dispose()
  })
})
