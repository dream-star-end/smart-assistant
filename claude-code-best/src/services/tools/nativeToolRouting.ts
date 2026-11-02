/** Trusted Worker-side routing port. Never deserialize this object from wire JSON.
 * prepare may only classify, not validate permissions, run hooks or execute tools.
 * The adapter authenticates manifest ownership and binds the plan to scope, input,
 * context/policy revisions and a durable execution grant. Unknown ownership fails
 * closed. execute revalidates the current context and owns result/artifact ACKs.
 */
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { type ToolUseContext, findToolByName } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { isOpenClaudeAdvisorHermetic } from '../../utils/envUtils.js'
import { createUserMessage } from '../../utils/messages.js'
import type { MessageUpdateLazy } from './toolExecution.js'

export type NativeToolRoute =
  | { owner: 'worker' }
  | {
      owner: 'host'
      isConcurrencySafe: boolean
      interruptBehavior: 'cancel' | 'block'
      execute(request: {
        block: ToolUseBlock
        assistantMessage: AssistantMessage
        context: ToolUseContext
      }): AsyncGenerator<MessageUpdateLazy, void>
    }
export interface NativeToolRouting {
  /** Stable revision of relevant policy/context, including Skill overlays. Must
   * compare semantic revisions, never getAppState() object identity. */
  getContextRevision(context: ToolUseContext): string
  prepare(block: ToolUseBlock, context: ToolUseContext): Promise<NativeToolRoute>
}
export type PreparedNativeToolRoute = NativeToolRoute | { owner: 'unavailable' }

export function getNativeToolContextRevision(context: ToolUseContext): string | undefined {
  try {
    const revision = context.nativeToolRouting?.getContextRevision(context)
    return typeof revision === 'string' && revision.length > 0 && revision.length <= 160
      ? revision
      : undefined
  } catch {
    return undefined
  }
}

export async function prepareNativeToolRoute(
  block: ToolUseBlock,
  context: ToolUseContext,
): Promise<PreparedNativeToolRoute | undefined> {
  if (!context.nativeToolRouting || isOpenClaudeAdvisorHermetic()) return undefined
  if (getNativeToolContextRevision(context) === undefined) return { owner: 'unavailable' }
  try {
    const route = await context.nativeToolRouting.prepare(block, context)
    if (route?.owner === 'worker') return route
    if (
      route?.owner === 'host' &&
      typeof route.isConcurrencySafe === 'boolean' &&
      (route.interruptBehavior === 'cancel' || route.interruptBehavior === 'block') &&
      typeof route.execute === 'function'
    )
      return route
  } catch {
    // Classification cannot start effects. Preserve a tool error, never silently
    // fall back to execution in the Worker's filesystem/network environment.
  }
  return { owner: 'unavailable' }
}
export function isPreparedToolConcurrencySafe(
  block: ToolUseBlock,
  context: ToolUseContext,
  route?: PreparedNativeToolRoute,
): boolean {
  if (route?.owner === 'host') return route.isConcurrencySafe
  if (route?.owner === 'unavailable') return false
  const tool = findToolByName(context.options.tools, block.name)
  const parsed = tool?.inputSchema.safeParse(block.input)
  if (!parsed?.success) return false
  try {
    return Boolean(tool?.isConcurrencySafe(parsed.data))
  } catch {
    return false
  }
}
export function unavailableNativeToolUpdate(
  block: ToolUseBlock,
  assistant: AssistantMessage,
): MessageUpdateLazy {
  const error = 'Remote tool classification unavailable; execution did not start'
  return {
    message: createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `<tool_use_error>${error}</tool_use_error>`,
        },
      ],
      toolUseResult: error,
      sourceToolAssistantUUID: assistant.uuid,
    }),
  }
}
