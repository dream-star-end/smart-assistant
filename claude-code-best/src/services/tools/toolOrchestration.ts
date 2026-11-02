import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { all } from '../../utils/generators.js'
import { createToolBatchSpan, endToolBatchSpan } from '../langfuse/index.js'
import {
  type PreparedNativeToolRoute,
  getNativeToolContextRevision,
  isPreparedToolConcurrencySafe,
  prepareNativeToolRoute,
} from './nativeToolRouting.js'
import { type MessageUpdateLazy, runToolUse } from './toolExecution.js'

function getMaxToolUseConcurrency(): number {
  return Number.parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}

export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  // Wrap all tool calls in this turn under a single Langfuse turn span
  const turnSpan =
    toolUseMessages.length > 0
      ? createToolBatchSpan(toolUseContext.langfuseTrace ?? null, {
          toolNames: toolUseMessages.map((b) => b.name),
          batchIndex: 0,
        })
      : null
  const contextWithTurn = turnSpan
    ? { ...toolUseContext, langfuseBatchSpan: turnSpan }
    : toolUseContext

  let currentContext = contextWithTurn
  const routes = new Map<ToolUseBlock, PreparedNativeToolRoute | undefined>()
  for await (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    () => currentContext,
    routes,
  )) {
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
      // Run read-only batch concurrently
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
        routes,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = []
          }
          queuedContextModifiers[toolUseID].push(modifyContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id]
        if (!modifiers) {
          continue
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
      yield { newContext: currentContext }
    } else {
      // Run non-read-only batch serially
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
        routes,
      )) {
        if (update.newContext) {
          currentContext = update.newContext
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }

  endToolBatchSpan(turnSpan)
}

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
async function* partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  getContext: () => ToolUseContext,
  routes: Map<ToolUseBlock, PreparedNativeToolRoute | undefined>,
): AsyncGenerator<Batch, void> {
  let index = 0
  let pending:
    | {
        block: ToolUseBlock
        context: ToolUseContext
        revision: string | undefined
        route: PreparedNativeToolRoute | undefined
      }
    | undefined
  while (index < toolUseMessages.length) {
    const context = getContext()
    const revision = getNativeToolContextRevision(context)
    const block = toolUseMessages[index]!
    const route =
      pending?.block === block && pending.context === context && pending.revision === revision
        ? pending.route
        : await prepareNativeToolRoute(block, context)
    pending = undefined
    const isConcurrencySafe = isPreparedToolConcurrencySafe(block, context, route)
    const blocks = [block]
    routes.set(block, route)
    index++
    if (isConcurrencySafe) {
      while (index < toolUseMessages.length) {
        const next = toolUseMessages[index]!
        const nextRoute = await prepareNativeToolRoute(next, context)
        if (!isPreparedToolConcurrencySafe(next, context, nextRoute)) {
          // Probe only: don't carry this plan across a context/state modifier.
          pending = { block: next, context, revision, route: nextRoute }
          break
        }
        routes.set(next, nextRoute)
        blocks.push(next)
        index++
      }
    }
    yield { isConcurrencySafe, blocks }
    // A serial Skill's real closure has now run. Classify all following tools
    // using its current permission/model/effort overlay, never the old root.
  }
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  routes: Map<ToolUseBlock, PreparedNativeToolRoute | undefined>,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs((prev) => new Set(prev).add(toolUse.id))
    for await (const update of runToolUse(
      toolUse,
      assistantMessages.find(
        (_) =>
          Array.isArray(_.message.content) &&
          _.message.content.some((_) => _.type === 'tool_use' && _.id === toolUse.id),
      )!,
      canUseTool,
      currentContext,
      routes.get(toolUse),
    )) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)
      }
      yield {
        message: update.message,
        newContext: currentContext,
      }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
  routes: Map<ToolUseBlock, PreparedNativeToolRoute | undefined>,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      toolUseContext.setInProgressToolUseIDs((prev) => new Set(prev).add(toolUse.id))
      yield* runToolUse(
        toolUse,
        assistantMessages.find(
          (_) =>
            Array.isArray(_.message.content) &&
            _.message.content.some((_) => _.type === 'tool_use' && _.id === toolUse.id),
        )!,
        canUseTool,
        toolUseContext,
        routes.get(toolUse),
      )
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),
  )
}

function markToolUseAsComplete(toolUseContext: ToolUseContext, toolUseID: string) {
  toolUseContext.setInProgressToolUseIDs((prev) => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
