/** A frozen policy belongs to one logical operation, while applied describes the actual warm process. */
import type { PromptPrivacyPolicy } from '@openclaude/protocol'
import { getDesiredPromptPrivacy, promptPrivacyNeedsRestart } from './promptPrivacyDesired.js'
export interface PromptPrivacyLifecycle {
  assertCurrent(): void
  /** Reuse this exact admitted policy for same-turn source reinjection. The
   * callback runs after setPromptPrivacy and never performs a second read. */
  onPrepared?(policy: PromptPrivacyPolicy): void
  /** Reserve the expected generation change of this operation's own shutdown. */
  beforeOwnedShutdown?(): void
}
export interface PromptPrivacyRunner {
  promptPolicyFingerprint?: string
  setPromptPrivacy?: (policy: PromptPrivacyPolicy) => void
  clearPromptPrivacy?: () => void
  assertPromptPrivacyStopped?: () => void
  shutdown(): Promise<void>
}
export function clearRunnerPromptPrivacy(runner: PromptPrivacyRunner): void { runner.clearPromptPrivacy?.() }
export function assertRunnerPromptPrivacyStopped(runner: PromptPrivacyRunner): void {
  if (!runner.assertPromptPrivacyStopped) throw new Error('无法核验旧进程是否已停止。')
  runner.assertPromptPrivacyStopped()
}
export async function prepareRunnerPromptPrivacy(runner: PromptPrivacyRunner, sessionId: string | undefined, lifecycle?: PromptPrivacyLifecycle): Promise<boolean> {
  lifecycle?.assertCurrent()
  if (typeof runner.setPromptPrivacy !== 'function') return false
  const policy = await getDesiredPromptPrivacy(sessionId)
  lifecycle?.assertCurrent()
  const changed = promptPrivacyNeedsRestart(runner.promptPolicyFingerprint, policy, sessionId)
  runner.setPromptPrivacy(policy)
  lifecycle?.onPrepared?.(policy)
  return changed
}
export async function refreshRunnerPromptPrivacy(runner: PromptPrivacyRunner, sessionId: string | undefined, lifecycle?: PromptPrivacyLifecycle): Promise<void> {
  try {
    if (await prepareRunnerPromptPrivacy(runner, sessionId, lifecycle)) {
      lifecycle?.assertCurrent()
      lifecycle?.beforeOwnedShutdown?.()
      await runner.shutdown()
      lifecycle?.assertCurrent()
      assertRunnerPromptPrivacyStopped(runner)
    }
    lifecycle?.assertCurrent()
  } catch (error) {
    clearRunnerPromptPrivacy(runner)
    throw new Error('助手隐私设置尚未生效，本次操作未发送；请稍后重试。', { cause: error })
  }
}
export async function withFreshPromptPrivacy<T>(runner: PromptPrivacyRunner, sessionId: string | undefined, operation: () => Promise<T>, lifecycle?: PromptPrivacyLifecycle): Promise<T> {
  await refreshRunnerPromptPrivacy(runner, sessionId, lifecycle)
  try { lifecycle?.assertCurrent(); return await operation() } finally { clearRunnerPromptPrivacy(runner) }
}
