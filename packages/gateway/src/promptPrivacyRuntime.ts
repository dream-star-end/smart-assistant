/** A frozen policy belongs to one logical operation, while applied describes the actual warm process. */
import type { PromptPrivacyPolicy } from '@openclaude/protocol'
import { getDesiredPromptPrivacy, promptPrivacyNeedsRestart } from './promptPrivacyDesired.js'
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
export async function prepareRunnerPromptPrivacy(runner: PromptPrivacyRunner, sessionId: string | undefined): Promise<boolean> {
  if (typeof runner.setPromptPrivacy !== 'function') return false
  const policy = await getDesiredPromptPrivacy(sessionId)
  const changed = promptPrivacyNeedsRestart(runner.promptPolicyFingerprint, policy, sessionId)
  runner.setPromptPrivacy(policy)
  return changed
}
export async function refreshRunnerPromptPrivacy(runner: PromptPrivacyRunner, sessionId: string | undefined): Promise<void> {
  try {
    if (await prepareRunnerPromptPrivacy(runner, sessionId)) {
      await runner.shutdown()
      assertRunnerPromptPrivacyStopped(runner)
    }
  } catch (error) {
    clearRunnerPromptPrivacy(runner)
    throw new Error('助手隐私设置尚未生效，本次操作未发送；请稍后重试。', { cause: error })
  }
}
export async function withFreshPromptPrivacy<T>(runner: PromptPrivacyRunner, sessionId: string | undefined, operation: () => Promise<T>): Promise<T> {
  await refreshRunnerPromptPrivacy(runner, sessionId)
  try { return await operation() } finally { clearRunnerPromptPrivacy(runner) }
}
