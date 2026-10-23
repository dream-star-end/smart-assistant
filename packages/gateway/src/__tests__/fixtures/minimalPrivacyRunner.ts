/** Existing synthetic runners begin with an applied minimal policy. No storage import before test HOME. */
import { EventEmitter } from 'node:events'
import { DEFAULT_PROMPT_PRIVACY, type PromptPrivacyPolicy } from '@openclaude/protocol'
import { promptPrivacyFingerprint } from '../../promptPrivacyPolicy.js'
export class MinimalPrivacyRunner extends EventEmitter {
  private desiredPromptPrivacy: PromptPrivacyPolicy | undefined
  promptPolicyFingerprint = promptPrivacyFingerprint(DEFAULT_PROMPT_PRIVACY, undefined)
  setPromptPrivacy(policy: PromptPrivacyPolicy): void { this.desiredPromptPrivacy = structuredClone(policy) }
  clearPromptPrivacy(): void { this.desiredPromptPrivacy = undefined }
  assertPromptPrivacyStopped(): void {
    if ((this as unknown as { isRunning?: boolean }).isRunning === true) throw new Error('fixture runner still running')
  }
  protected recordBuiltPromptPrivacy(): void {
    const policy = this.desiredPromptPrivacy ?? DEFAULT_PROMPT_PRIVACY
    this.promptPolicyFingerprint = promptPrivacyFingerprint(policy, policy.profile?.sessionId)
  }
}
