/** Session admission for a signed remote-lane chat; no model or filesystem effects. */
import {
  type RemoteExecutionBackend,
  boxClaudeRunner,
  isCc5ExecutionBackend,
  parseCodexExecutionBackend,
} from '@openclaude/protocol'

/** Remote-pool catalog ids always end in `-remote` (remoteBrainPool toRemotePoolModelId). */
function isRemoteChatModel(model: string): boolean {
  return model.endsWith('-remote') || boxClaudeRunner(model) === 'interactive'
}
import { isCc5ResumeId, parseCc5ResumeId } from './engine/cc5ResumeId.js'

export function cc5SessionBackend(input: {
  executionAuthority?: { source?: string; executionBackend?: RemoteExecutionBackend }
  engineId: string
  executionModel: string
  sessionKey: string
  storedResumeId?: string
  hermeticNoTools?: boolean
  delegationDepth?: number
  usageAttribution?: unknown
  advisorExecutionLock?: unknown
  channel?: string
}): RemoteExecutionBackend | undefined {
  const scope = input.executionAuthority?.executionBackend
  // A restart must never silently replay a remote chat locally while it still names a
  // remote model. Explicit switches to other models keep their preexisting behavior
  // (the new local runner starts without the remote resume id).
  if (isRemoteChatModel(input.executionModel) && !scope && isCc5ResumeId(input.storedResumeId)) {
    throw new Error('CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED')
  }
  if (scope === undefined) return undefined
  // The signed scope is the only authority for a remote lane, whatever engine it selects.
  if (input.executionAuthority?.source !== 'bridge_signed' ||
    scope.sessionKey !== input.sessionKey || input.hermeticNoTools || input.delegationDepth ||
    input.usageAttribution || input.advisorExecutionLock || input.channel && input.channel !== 'webchat'
  ) throw new Error('CC5_BACKEND_SCOPE_INVALID')
  if (isCc5ExecutionBackend(scope)) {
    if (input.engineId !== 'ccb') throw new Error('CC5_BACKEND_SCOPE_INVALID')
    return scope
  }
  if ((scope as { kind?: unknown }).kind !== 'codex-app-server-v1' || input.engineId !== 'codex') {
    throw new Error('CC5_BACKEND_SCOPE_INVALID')
  }
  parseCodexExecutionBackend(scope)
  return scope
}

/** Call again after the final canonical session lock, immediately before any replacement. */
export async function assertFreshCc5Session(input: {
  current?: { turns: number; runner: { nativeSessionId: string | null } }
  storedResumeId?: string
  executionBackend?: RemoteExecutionBackend
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
  // A codex lane resume names a native thread, not a cc5 resume id. The relay only accepts the
  // thread its own manifest binds, so a foreign thread id fails closed there, not here.
  if (
    !input.current &&
    input.executionBackend &&
    !isCc5ExecutionBackend(input.executionBackend) &&
    !isCc5ResumeId(input.storedResumeId)
  ) {
    return
  }
  if (input.current?.turns || input.current?.runner.nativeSessionId || input.storedResumeId ||
    await input.hasPersistedTurnActivity(input.sessionIds)) {
    throw new Error('CC5_BACKEND_REQUIRES_NEW_SESSION')
  }
}
