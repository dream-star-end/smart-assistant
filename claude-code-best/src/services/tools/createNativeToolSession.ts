/** Per-native-session execution state, without constructing QueryEngine/model loop.
 * The trusted bootstrap supplies real tools, policy and durable runtime callbacks.
 * This is not a network handler. No serialized AppState or function reducers.
 */
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { type ToolUseContext, findToolByName } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  type FileStateCache,
  READ_FILE_STATE_CACHE_SIZE,
  createFileStateCacheWithSizeLimit,
} from '../../utils/fileStateCache.js'
import { createDrainedToolStream } from './drainedToolStream.js'
import type { NativeToolInvocation, NativeToolLifecycle } from './nativeToolLifecycle.js'
import { type NativeToolView, createNativeToolState } from './nativeToolState.js'
import { type MessageUpdate, runTools } from './toolOrchestration.js'

export interface NativeToolSessionOptions {
  initialAppState: AppState
  initialMessages: Message[]
  options: ToolUseContext['options']
  readFileState?: FileStateCache
  canUseTool: CanUseToolFn
  handleElicitation: ToolUseContext['handleElicitation']
  onStateChange: (state: AppState, previous: AppState) => void
  onViewChange: (view: NativeToolView) => void
  ownsTool: (name: string) => boolean
  /** Admission only, not a claim that every tool in the batch has started. */
  authorizeBatch: (blocks: readonly ToolUseBlock[], signal: AbortSignal) => Promise<void>
  /** Durable per-tool dispatch/fence BEFORE validation, permission and hooks. */
  beforeExecution: (request: NativeToolInvocation, signal: AbortSignal) => Promise<void>
  /** Current fence, cancel, deadline and final input check immediately at call. */
  beforeToolCall: (request: NativeToolInvocation, signal: AbortSignal) => Promise<void>
  /** Persist results/progress before presenting them; transport ACK is separate. */
  recordUpdate: (update: MessageUpdate) => Promise<void>
  /** Failure must leave unresolved operations unknown, never eligible for replay. */
  recordFailure: (error: unknown) => Promise<void>
  installBackgroundListeners: (getContext: () => ToolUseContext) => () => void
  /** Stop registered tasks. This alone does NOT prove OS process-tree exit. */
  stopTasks: (getContext: () => ToolUseContext) => Promise<void>
  drainBackground: () => Promise<void>
  closeResources: () => Promise<void>
}
export function createNativeToolSession(config: NativeToolSessionOptions) {
  const state = createNativeToolState(
    config.initialAppState,
    config.onStateChange,
    config.onViewChange,
  )
  const pending = new Set<Promise<unknown>>()
  let closing = false
  let disposed = false
  let disposal: Promise<void> | undefined
  let batch: ReturnType<typeof createDrainedToolStream<Message>> | undefined
  const assertLive = (signal: AbortSignal) => {
    if (closing || context.abortController.signal.aborted || signal.aborted)
      throw new Error('native-session-aborted')
  }
  const lifecycle: NativeToolLifecycle = {
    track(request, signal, execute) {
      const execution = Promise.resolve().then(async () => {
        assertLive(signal)
        await config.beforeExecution(request, signal)
        assertLive(signal)
        return execute()
      })
      pending.add(execution)
      void execution.then(
        () => pending.delete(execution),
        () => pending.delete(execution),
      )
      return execution
    },
    async invoke(request, signal, call) {
      assertLive(signal)
      await config.beforeToolCall(request, signal)
      assertLive(signal)
      // No intervening Promise reaction between the last live check and effect.
      return call()
    },
  }
  const waitExecutions = async () => {
    while (pending.size) await Promise.allSettled([...pending])
  }
  let context: ToolUseContext = {
    options: config.options,
    abortController: new AbortController(),
    messages: config.initialMessages,
    readFileState:
      config.readFileState ?? createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    ...state,
    nativeToolLifecycle: lifecycle,
    handleElicitation: config.handleElicitation,
    loadedNestedMemoryPaths: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
  }
  const getContext = () => context
  const removeBackgroundListeners = config.installBackgroundListeners(getContext)
  return {
    state,
    getContext,
    /** Preserve native input-aware concurrency, barriers and modifier order.
     * A lost consumer only detaches its bounded view. The producer keeps
     * recording results and busy remains true until real pipelines drain.
     */
    executeBatch(
      blocks: ToolUseBlock[],
      assistantMessages: AssistantMessage[],
      messages: Message[],
    ) {
      if (closing) throw new Error('native-session-closed')
      if (batch) throw new Error('native-session-batch-busy')
      context = { ...context, messages }
      for (const block of blocks) {
        const tool = findToolByName(context.options.tools, block.name)
        if (!tool || !config.ownsTool(block.name) || !config.ownsTool(tool.name))
          throw new Error('native-tool-owner')
      }
      const current = createDrainedToolStream<Message>(
        async (emit) => {
          let failed = false
          let failure: unknown
          try {
            await config.authorizeBatch(blocks, context.abortController.signal)
            assertLive(context.abortController.signal)
            for await (const update of runTools(
              blocks,
              assistantMessages,
              config.canUseTool,
              context,
            )) {
              context = { ...update.newContext, nativeToolLifecycle: lifecycle }
              // Keep draining real execution even if disk/network recording fails.
              // The supervisor receives failure, aborts later effects, and retains
              // the unknown journal; it must not treat a UI close as a receipt.
              if (!failed)
                try {
                  await config.recordUpdate({ ...update, newContext: context })
                  if (update.message) await emit(update.message)
                } catch (error) {
                  failed = true
                  failure = error
                  context.abortController.abort('native-record-failed')
                }
            }
          } catch (error) {
            failed = true
            failure = error
            context.abortController.abort('native-batch-failed')
          } finally {
            await waitExecutions()
            if (failed) await config.recordFailure(failure)
          }
          if (failed) throw failure
        },
        (message) => Buffer.byteLength(JSON.stringify(message), 'utf8'),
      )
      batch = current
      const clear = () => {
        if (batch === current) batch = undefined
      }
      void current.done.then(clear, clear)
      return { ...current, getContext }
    },
    /** Keep cache, root store, memory dedup and background jobs across turns. */
    beginTurn(messages: Message[]) {
      if (closing || batch) throw new Error('native-session-batch-busy')
      context = {
        ...context,
        messages,
        abortController: new AbortController(),
        nestedMemoryAttachmentTriggers: new Set<string>(),
        dynamicSkillDirTriggers: new Set<string>(),
        discoveredSkillNames: new Set<string>(),
      }
    },
    abort(reason: string) {
      context.abortController.abort(reason)
    },
    dispose() {
      if (disposed) return Promise.resolve()
      if (disposal) return disposal
      closing = true
      context.abortController.abort('native-session-dispose')
      batch?.detach()
      disposal = (async () => {
        // Retry remains possible if stopTasks fails. Listeners stay installed
        // until task cleanup and foreground drain succeed.
        const stopped = Promise.resolve().then(() => config.stopTasks(getContext))
        const outcomes = await Promise.allSettled([stopped, batch?.done, waitExecutions()])
        const failed = outcomes.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        // Foreground cleanup can register a background task late. Sweep again,
        // then drain the actual completion handlers before closing resources.
        await config.stopTasks(getContext)
        await config.drainBackground()
        await config.closeResources()
        removeBackgroundListeners()
        disposed = true
      })().finally(() => {
        disposal = undefined
      })
      return disposal
    },
  }
}
