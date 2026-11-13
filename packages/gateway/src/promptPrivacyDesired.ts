/** Fresh consent on every turn. No TTL cache, profile text, or preference timestamps in logs. */
import { DEFAULT_PROMPT_PRIVACY, type PromptPrivacyPolicy } from '@openclaude/protocol'
import { fetchPlatformSlotsFromMasterDetailed, promptPrivacyFingerprint, type FetchPlatformSlotsDeps } from './promptSlots.js'
export async function getDesiredPromptPrivacy(sessionId: string | undefined, deps: FetchPlatformSlotsDeps = {}): Promise<PromptPrivacyPolicy> {
  const r = await fetchPlatformSlotsFromMasterDetailed({ agentId: 'main', sessionId }, deps)
  if (r === null) return { ...DEFAULT_PROMPT_PRIVACY }
  if (!r.ok || !r.promptPolicy) throw new Error('暂时无法核验助手隐私设置，请稍后重试；本轮尚未发送给模型。')
  return r.promptPolicy
}
export function promptPrivacyNeedsRestart(applied: string | undefined, desired: PromptPrivacyPolicy, sessionId: string | undefined): boolean {
  return applied !== promptPrivacyFingerprint(desired, sessionId)
}
