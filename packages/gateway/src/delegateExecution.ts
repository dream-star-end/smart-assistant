import type { RunLog, RunLogEntry } from './runLog.js'

export interface DelegateExecutionResult {
  output: string
  error: string
}

export interface DelegateExecutionOptions {
  agentId: string
  sessionKey: string
  runLog: RunLog
  runEntry: RunLogEntry
  submit: (onEvent: (event: any) => void) => Promise<void>
  emitCompleted: (result: DelegateExecutionResult) => void
  releaseActive: () => void
  outputPreviewLimit?: number
}

export async function runDelegateExecution(
  opts: DelegateExecutionOptions,
): Promise<DelegateExecutionResult> {
  const outputPreviewLimit = opts.outputPreviewLimit ?? 2000
  let output = ''
  let error = ''

  try {
    await opts.submit((event) => {
      if (event?.kind === 'block' && event.block?.kind === 'text') {
        output += event.block.text ?? ''
      }
      if (event?.kind === 'error') {
        error = event.error ?? ''
      }
    })
    opts.runLog.complete(opts.runEntry, {
      status: error ? 'failed' : 'completed',
      error: error || undefined,
      outputPreview: output.trim().slice(0, outputPreviewLimit),
    })
    const result = { output, error }
    opts.emitCompleted(result)
    return result
  } catch (err: any) {
    error = error || String(err)
    opts.runLog.complete(opts.runEntry, {
      status: 'failed',
      error,
      outputPreview: output.trim().slice(0, outputPreviewLimit),
    })
    const result = { output, error }
    opts.emitCompleted(result)
    return result
  } finally {
    opts.releaseActive()
  }
}
