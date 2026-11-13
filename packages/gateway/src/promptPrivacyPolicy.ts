/** Pure policy hashing: importing it never initializes storage paths or databases. */
import { createHash } from 'node:crypto'
import { effectivePromptPrivacy } from '@openclaude/protocol'
export function promptPrivacyFingerprint(policy: unknown, sessionId: string | undefined): string {
  return createHash('sha256').update(JSON.stringify(effectivePromptPrivacy(policy, sessionId))).digest('hex')
}
