import { isCc5ExecutionBackend } from '@openclaude/protocol'

export interface ConfigRestartableRunner {
  readonly executionBackend?: unknown
  readonly isRunning: boolean
  shutdown(): Promise<void>
  restartForConfigChange?: () => Promise<void>
}

/**
 * Restart a runner so its next turn picks up new effort/model/privacy/identity config, without
 * revoking a remote execution lane: a cold CC5 port is single-use, and a remote Codex lane only
 * recycles its local kernel here (its full shutdown is reserved for real teardown).
 */
export async function restartRunnerForConfigChange(runner: ConfigRestartableRunner): Promise<void> {
  if (typeof runner.restartForConfigChange === 'function') return runner.restartForConfigChange()
  if (!isCc5ExecutionBackend(runner.executionBackend) || runner.isRunning) await runner.shutdown()
}
