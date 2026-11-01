import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { REJECT_MESSAGE, createUserMessage, withMemoryCorrectionHint } from 'src/utils/messages.js'
import { type ToolUseContext, type Tools, findToolByName } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { isOpenClaudeAdvisorHermetic } from '../../utils/envUtils.js'
import { createToolBatchSpan, endToolBatchSpan } from '../langfuse/index.js'
import type { LangfuseSpan } from '../langfuse/index.js'
import {
  type PreparedNativeToolRoute,
  getNativeToolContextRevision,
  isPreparedToolConcurrencySafe,
  prepareNativeToolRoute,
} from './nativeToolRouting.js'
import { runToolUse } from './toolExecution.js'

type MessageUpdate = {
  message?: Message
  newContext?: ToolUseContext
}

type ToolStatus = 'classifying' | 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  classification?: Promise<void>
  route?: PreparedNativeToolRoute
  preparedContext?: ToolUseContext
  preparedRevision?: string
  reclassify?: () => void
  results?: Message[]
  // Progress messages are stored separately and yielded immediately
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}

/**
 * Executes tools as they stream in with concurrency control.
 * - Concurrent-safe tools can execute in parallel with other concurrent-safe tools
 * - Non-concurrent tools must execute alone (exclusive access)
 * - Results are buffered and emitted in the order tools were received
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  private siblingAbortController: AbortController
  private discarded = false
  private progressAvailableResolve?: () => void
  private turnSpan: LangfuseSpan | null = null
  // Independent of the view array, which discard() is allowed to clear.
  private readonly inFlight = new Set<Promise<void>>()
  private executionFailed = false
  private executionFailure: unknown

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(toolUseContext.abortController)
  }

  /**
   * Discards all pending and in-progress tools. Called when streaming fallback
   * occurs and results from the failed attempt should be abandoned.
   * Queued tools won't start, and in-progress tools will receive synthetic errors.
   *
   * Releases all internal references (tools array, abort controller, context)
   * so that the discarded executor and its buffered results can be garbage-collected.
   * Without this, repeated API retries in NO_FLICKER mode accumulate leaked
   * TrackedTool objects (each holding assistantMessage, results, pendingProgress).
   */
  discard(): void {
    this.discarded = true
    // Abort running tool subprocesses (Bash spawns, etc.) so they don't
    // continue producing results after the executor is replaced.
    this.siblingAbortController.abort('streaming_fallback')
    // Release references to allow GC of tool blocks, messages, and promises.
    this.tools.length = 0
    this.wakeProgress()
    if (this.turnSpan) {
      endToolBatchSpan(this.turnSpan)
      this.turnSpan = null
    }
  }

  /**
   * Add a tool to the execution queue. Will start executing immediately if conditions allow.
   */
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    if (this.discarded || this.executionFailed) return
    if (isOpenClaudeAdvisorHermetic()) {
      console.error(
        `[openclaude-advisor-hermetic] OCV5-213-A5-HERMETIC addTool reject ${block.name} id=${block.id} file=${import.meta.url}`,
      )
      if (!this.toolUseContext.abortController.signal.aborted) {
        this.toolUseContext.abortController.abort('advisor_hermetic_no_tools')
      }
      return
    }
    // Create turn span on first tool — will be ended in getRemainingResults
    if (this.tools.length === 0 && this.turnSpan === null) {
      this.turnSpan = createToolBatchSpan(this.toolUseContext.langfuseTrace ?? null, {
        toolNames: [block.name],
        batchIndex: 0,
      })
      if (this.turnSpan) {
        this.toolUseContext = {
          ...this.toolUseContext,
          langfuseBatchSpan: this.turnSpan,
        }
      }
    }
    const tracked: TrackedTool = {
      id: block.id,
      block,
      assistantMessage,
      status: 'classifying',
      isConcurrencySafe: false,
      pendingProgress: [],
    }
    this.tools.push(tracked)
    const classify = () => {
      const preparedContext = this.toolUseContext
      const preparedRevision = getNativeToolContextRevision(preparedContext)
      tracked.status = 'classifying'
      const initialize = (route?: PreparedNativeToolRoute) => {
        if (this.discarded || this.executionFailed) return
        tracked.route = route
        tracked.preparedContext = preparedContext
        tracked.preparedRevision = preparedRevision
        if (
          route?.owner !== 'host' &&
          route?.owner !== 'unavailable' &&
          !findToolByName(this.toolDefinitions, block.name)
        ) {
          // Preserve the ordinary streaming unknown-tool behavior, including its
          // stricter alias lookup. Host manifests need no local Tool instance.
          tracked.status = 'completed'
          tracked.isConcurrencySafe = true
          tracked.results = [
            createUserMessage({
              content: [
                {
                  type: 'tool_result',
                  is_error: true,
                  tool_use_id: block.id,
                  content: `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
                },
              ],
              toolUseResult: `Error: No such tool available: ${block.name}`,
              sourceToolAssistantUUID: assistantMessage.uuid,
            }),
          ]
        } else {
          tracked.isConcurrencySafe = isPreparedToolConcurrencySafe(
            block,
            {
              ...preparedContext,
              options: {
                ...preparedContext.options,
                tools: this.toolDefinitions,
              },
            },
            route,
          )
          tracked.status = 'queued'
        }
        this.wakeProgress()
        void this.processQueue()
      }
      if (!this.toolUseContext.nativeToolRouting) {
        initialize()
      } else {
        // The original position is reserved before awaiting a remote response.
        // A later classified read must not overtake this unknown barrier.
        const classification = prepareNativeToolRoute(block, {
          ...preparedContext,
          abortController: this.siblingAbortController,
        }).then(initialize)
        tracked.classification = classification
        this.trackInFlight(classification)
      }
    }
    tracked.reclassify = classify
    classify()
  }

  private wakeProgress(): void {
    this.progressAvailableResolve?.()
    this.progressAvailableResolve = undefined
  }

  private trackInFlight(promise: Promise<void>): void {
    this.inFlight.add(promise)
    void promise.then(
      () => {
        this.inFlight.delete(promise)
        this.wakeProgress()
      },
      (error) => {
        this.inFlight.delete(promise)
        this.executionFailed = true
        this.executionFailure = error
        this.siblingAbortController.abort('tool-execution-unknown')
        this.wakeProgress()
      },
    )
  }

  /** Drain real classification/pipelines after discard; not OS tree proof. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
    if (this.executionFailed) throw this.executionFailure
  }

  /**
   * Check if a tool can execute based on current concurrency state
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter((t) => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every((t) => t.isConcurrencySafe))
    )
  }

  /**
   * Process the queue, starting tools when concurrency conditions allow
   */
  private async processQueue(): Promise<void> {
    if (this.discarded || this.executionFailed) return
    for (const tool of this.tools) {
      if (tool.status === 'classifying') break
      if (tool.status !== 'queued') continue
      if (
        this.toolUseContext.nativeToolRouting &&
        (tool.preparedContext !== this.toolUseContext ||
          tool.preparedRevision !== getNativeToolContextRevision(this.toolUseContext))
      ) {
        // A completed Skill/context modifier or policy update invalidates plans
        // prepared while that earlier serial operation was still running.
        tool.reclassify!()
        break
      }

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // Can't execute this tool yet, and since we need to maintain order for non-concurrent tools, stop here
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
    assistantMessage: AssistantMessage,
  ): Message {
    // For user interruptions (ESC to reject), use REJECT_MESSAGE so the UI shows
    // "User rejected edit" instead of "Error editing file"
    if (reason === 'user_interrupted') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withMemoryCorrectionHint(REJECT_MESSAGE),
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'User rejected tool use',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    if (reason === 'streaming_fallback') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content:
              '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>',
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'Streaming fallback - tool execution discarded',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'
    return createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>${msg}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        },
      ],
      toolUseResult: msg,
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
  }

  /**
   * Determine why a tool should be cancelled.
   */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) {
      return 'streaming_fallback'
    }
    if (this.hasErrored) {
      return 'sibling_error'
    }
    if (this.toolUseContext.abortController.signal.aborted) {
      // 'interrupt' means the user typed a new message while tools were
      // running. Only cancel tools whose interruptBehavior is 'cancel';
      // 'block' tools shouldn't reach here (abort isn't fired).
      if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
        return this.getToolInterruptBehavior(tool) === 'cancel' ? 'user_interrupted' : null
      }
      return 'user_interrupted'
    }
    return null
  }

  private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    if (tool.route?.owner === 'host') return tool.route.interruptBehavior
    const definition = findToolByName(this.toolDefinitions, tool.block.name)
    if (!definition?.interruptBehavior) return 'block'
    try {
      return definition.interruptBehavior()
    } catch {
      return 'block'
    }
  }

  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated = summary.length > 40 ? `${summary.slice(0, 40)}\u2026` : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

  private updateInterruptibleState(): void {
    const executing = this.tools.filter((t) => t.status === 'executing')
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 && executing.every((t) => this.getToolInterruptBehavior(t) === 'cancel'),
    )
  }

  /**
   * Execute a tool and collect its results
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'
    this.toolUseContext.setInProgressToolUseIDs((prev) => new Set(prev).add(tool.id))
    this.updateInterruptibleState()

    const messages: Message[] = []
    const contextModifiers: Array<(context: ToolUseContext) => ToolUseContext> = []

    const collectResults = async () => {
      // If already aborted (by error or user), generate synthetic error block instead of running the tool
      const initialAbortReason = this.getAbortReason(tool)
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(tool.id, initialAbortReason, tool.assistantMessage),
        )
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()
        return
      }

      // Per-tool child controller. Lets siblingAbortController kill running
      // subprocesses (Bash spawns listen to this signal) when a Bash error
      // cascades. Permission-dialog rejection also aborts this controller
      // (PermissionContext.ts cancelAndAbort) — that abort must bubble up to
      // the query controller so the query loop's post-tool abort check ends
      // the turn. Without bubble-up, ExitPlanMode "clear context + auto"
      // sends REJECT_MESSAGE to the model instead of aborting (#21056 regression).
      const toolAbortController = createChildAbortController(this.siblingAbortController)
      toolAbortController.signal.addEventListener(
        'abort',
        () => {
          if (
            toolAbortController.signal.reason !== 'sibling_error' &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(toolAbortController.signal.reason)
          }
        },
        { once: true },
      )

      const generator = runToolUse(
        tool.block,
        tool.assistantMessage,
        this.canUseTool,
        { ...this.toolUseContext, abortController: toolAbortController },
        tool.route,
      )

      // Track if this specific tool has produced an error result.
      // This prevents the tool from receiving a duplicate "sibling error"
      // message when it is the one that caused the error.
      let thisToolErrored = false

      for await (const update of generator) {
        // Check if we were aborted by a sibling tool error or user interruption.
        // Only add the synthetic error if THIS tool didn't produce the error.
        const abortReason = this.getAbortReason(tool)
        if (abortReason && !thisToolErrored) {
          messages.push(
            this.createSyntheticErrorMessage(tool.id, abortReason, tool.assistantMessage),
          )
          break
        }

        const isErrorResult =
          update.message.type === 'user' &&
          Array.isArray(update.message.message!.content) &&
          update.message.message!.content.some(
            (_) => _.type === 'tool_result' && _.is_error === true,
          )

        if (isErrorResult) {
          thisToolErrored = true
          // Only Bash errors cancel siblings. Bash commands often have implicit
          // dependency chains (e.g. mkdir fails → subsequent commands pointless).
          // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
          if (tool.block.name === BASH_TOOL_NAME) {
            this.hasErrored = true
            this.erroredToolDescription = this.getToolDescription(tool)
            this.siblingAbortController.abort('sibling_error')
          }
        }

        if (update.message) {
          // Progress messages go to pendingProgress for immediate yielding
          if (update.message.type === 'progress') {
            tool.pendingProgress.push(update.message)
            // Signal that progress is available
            if (this.progressAvailableResolve) {
              this.progressAvailableResolve()
              this.progressAvailableResolve = undefined
            }
          } else {
            messages.push(update.message)
          }
        }
        if (update.contextModifier) {
          contextModifiers.push(update.contextModifier.modifyContext)
        }
      }
      tool.results = messages
      tool.contextModifiers = contextModifiers
      tool.status = 'completed'
      this.updateInterruptibleState()

      // NOTE: we currently don't support context modifiers for concurrent
      //       tools. None are actively being used, but if we want to use
      //       them in concurrent tools, we need to support that here.
      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext)
        }
      }
    }

    const promise = collectResults()
    tool.promise = promise

    this.trackInFlight(promise)
    // Explicit rejection handler avoids an unobserved rejected finally Promise.
    void promise.then(
      () => {
        void this.processQueue()
      },
      () => {},
    )
  }

  /**
   * Get any completed results that haven't been yielded yet (non-blocking)
   * Maintains order where necessary
   * Also yields any pending progress messages immediately
   */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    if (this.executionFailed) throw this.executionFailure
    for (const tool of this.tools) {
      // Always yield pending progress messages immediately, regardless of tool status
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield { message: progressMessage, newContext: this.toolUseContext }
      }

      if (tool.status === 'yielded') {
        continue
      }

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'

        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext }
        }

        markToolUseAsComplete(this.toolUseContext, tool.id)
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  /**
   * Check if any tool has pending progress messages
   */
  private hasPendingProgress(): boolean {
    return this.tools.some((t) => t.pendingProgress.length > 0)
  }

  /**
   * Wait for remaining tools and yield their results as they complete
   * Also yields progress messages as they become available
   */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    while (this.hasUnfinishedTools()) {
      if (this.executionFailed) throw this.executionFailure
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      // If we still have executing tools but nothing completed, wait for any to complete
      // OR for progress to become available
      if (
        (this.hasExecutingTools() || this.tools.some((t) => t.status === 'classifying')) &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const executingPromises = this.tools.flatMap((t) =>
          t.status === 'executing' && t.promise
            ? [t.promise]
            : t.status === 'classifying' && t.classification
              ? [t.classification]
              : [],
        )

        // Also wait for progress to become available
        const progressPromise = new Promise<void>((resolve) => {
          this.progressAvailableResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }

    endToolBatchSpan(this.turnSpan)
    this.turnSpan = null
  }

  /**
   * Check if there are any completed results ready to yield
   */
  private hasCompletedResults(): boolean {
    return this.tools.some((t) => t.status === 'completed')
  }

  /**
   * Check if there are any tools still executing
   */
  private hasExecutingTools(): boolean {
    return this.tools.some((t) => t.status === 'executing')
  }

  /**
   * Check if there are any unfinished tools
   */
  private hasUnfinishedTools(): boolean {
    return this.tools.some((t) => t.status !== 'yielded')
  }

  /**
   * Get the current tool use context (may have been modified by context modifiers)
   */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }
}

function markToolUseAsComplete(toolUseContext: ToolUseContext, toolUseID: string) {
  toolUseContext.setInProgressToolUseIDs((prev) => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
