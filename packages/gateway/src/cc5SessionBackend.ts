/** Session admission for the single signed remote chat; no model or filesystem effects. */
import {
  type Cc5ExecutionBackend,
  CC5_NATIVE_MODEL,
  isCc5ExecutionBackend,
} from '@openclaude/protocol'
import { isCc5ResumeId, parseCc5ResumeId } from './engine/cc5ResumeId.js'

export function cc5SessionBackend(input: {
  executionAuthority?: { source?: string; executionBackend?: Cc5ExecutionBackend }
  engineId: string
  executionModel: string
  sessionKey: string
  storedResumeId?: string
  hermeticNoTools?: boolean
  delegationDepth?: number
  usageAttribution?: unknown
  advisorExecutionLock?: unknown
  channel?: string
}): Cc5ExecutionBackend | undefined {
  const scope = input.executionAuthority?.executionBackend
  // A restart must never silently replay this remote Sonnet chat locally.
  // Explicit changes to other models keep their preexisting behavior.
  if (input.executionModel === CC5_NATIVE_MODEL && !scope && isCc5ResumeId(input.storedResumeId)) {
    throw new Error('CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED')
  }
  if (scope !== undefined && (
    !isCc5ExecutionBackend(scope) || input.executionAuthority?.source !== 'bridge_signed' ||
    input.engineId !== 'ccb' || input.executionModel !== CC5_NATIVE_MODEL ||
    scope.sessionKey !== input.sessionKey || input.hermeticNoTools || input.delegationDepth ||
    input.usageAttribution || input.advisorExecutionLock || input.channel && input.channel !== 'webchat'
  )) throw new Error('CC5_BACKEND_SCOPE_INVALID')
  return scope
}

/** Call again after the final canonical session lock, immediately before any replacement. */
export async function assertFreshCc5Session(input: {
  current?: { turns: number; runner: { nativeSessionId: string | null } }
  storedResumeId?: string
  executionBackend?: Cc5ExecutionBackend
  sessionIds: string[]
  hasPersistedTurnActivity: (ids: string[]) => Promise<boolean>
}): Promise<void> {
  if (
    !input.current &&
    input.executionBackend &&
    parseCc5ResumeId(input.storedResumeId)?.bindingId === input.executionBackend.operationId
  ) {
    return
  }
  if (input.current?.turns || input.current?.runner.nativeSessionId || input.storedResumeId ||
    await input.hasPersistedTurnActivity(input.sessionIds)) {
    throw new Error('CC5_BACKEND_REQUIRES_NEW_SESSION')
  }
}
