import { writeFileSync } from 'node:fs'
import { issueParentCallerToken } from '../delegateContext.js'

/** Write the immutable caller snapshot selected for this queued turn. */
export function writeCodexDelegateContext(input: {
  file?: string
  agentId: string
  sessionKey: string
  depth: number
  traceId?: string
  consultTurn?: { turnKey: string; turnIndex: number; configVersion: string } | null
}): void {
  if (!input.file) return
  const token = issueParentCallerToken(input)
  writeFileSync(input.file, `${token}\n`, { mode: 0o600 })
}
