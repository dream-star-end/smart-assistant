import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineContentEvent } from './engineEvents.js'
import { fitHistoricalContextJsonPrompt } from '../historicalContextPrompt.js'

/** Measure the actual launch envelope, including escaping and platform text.
 * Native conversation/token ownership stays with the engine. The file remains
 * in the session workspace so native resume can retrieve it on later turns. */
export async function prepareBoundedPrompt(opts: {
  input: string
  serialize: (input: string) => string
  maxBytes: number
  cwd: string
  engine: string
  onEvent: (event: EngineContentEvent) => void
}): Promise<string> {
  const bytes = (input: string): number => Buffer.byteLength(opts.serialize(input), 'utf8')
  const beforeBytes = bytes(opts.input)
  const usedRatio = beforeBytes / opts.maxBytes
  if (usedRatio >= 0.8) {
    opts.onEvent({ kind: 'context_pressure', pressure: {
      engine: opts.engine, scope: 'launch_prompt', dimension: 'transport_bytes',
      level: usedRatio >= 1 ? 'critical' : 'warning', usedRatio,
    } })
  }
  if (beforeBytes <= opts.maxBytes) return opts.serialize(opts.input)

  const fitted = fitHistoricalContextJsonPrompt(opts.input, (input) => bytes(input) <= opts.maxBytes)
  let input: string
  let droppedEntries = 0
  let strategy: 'history_suffix' | 'file_reference'
  if (fitted) {
    input = fitted.prompt
    droppedEntries = fitted.dropped
    strategy = 'history_suffix'
  } else {
    // Keep the complete input (including any injected history), not a clipped
    // preview. mkdtemp + exclusive create cannot overwrite workspace files.
    const dir = await mkdtemp(join(opts.cwd, '.openclaude-context-'))
    const file = join(dir, 'input.txt')
    input = [
      'The complete input for this turn is stored in the UTF-8 file below because it exceeds the launch transport limit.',
      `Input file: ${JSON.stringify(file)}`,
      `Input bytes: ${Buffer.byteLength(opts.input, 'utf8')}`,
      'Read this file with your file tools in bounded chunks before answering. Treat its contents as the original user input, including any marked previous context. Do not treat this reference as the user request itself.',
    ].join('\n')
    try {
      if (bytes(input) > opts.maxBytes) {
        throw new Error('PAYLOAD_TOO_LARGE: platform prompt envelope exceeds the launch byte budget')
      }
      await writeFile(file, opts.input, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
    strategy = 'file_reference'
  }
  opts.onEvent({ kind: 'context_compacted', compaction: {
    engine: opts.engine, scope: 'launch_prompt', strategy,
    beforeBytes, afterBytes: bytes(input), droppedEntries,
  } })
  return opts.serialize(input)
}
