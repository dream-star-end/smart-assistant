/** Synthetic crash/race process. All paths come from the parent test's own root. */
import { appendFileSync, readFileSync } from 'node:fs'
import type { NativeFrame, NativeScope } from '@openclaude/protocol/agentRemoteNative'
import { type NativeHostIdentity, SqliteNativeHostJournal } from '../nativeHostJournal.js'
import type { NativeJournalRecord } from '../nativeJournal.js'
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  filename: string
  identity: NativeHostIdentity
  expected: NativeScope
  control: NativeJournalRecord
  frame: NativeFrame
  hookEffects: string
  toolEffects: string
}
const mode = process.argv[3]!
const journal = new SqliteNativeHostJournal({
  filename: config.filename,
  identity: config.identity,
  hostInstanceId: 'h1',
  clock: () => 1000,
})
const accepted = journal.accept(config.expected, config.control, config.frame)
if (mode === 'accepted') process.kill(process.pid, 'SIGKILL')
const admission = journal.beginPipeline(accepted.operation)
if (admission.kind === 'start') {
  appendFileSync(config.hookEffects, 'hook\n', { mode: 0o600 })
  if (mode === 'pipeline') process.kill(process.pid, 'SIGKILL')
  journal.commitEffectiveInput(admission.permit, { command: 'synthetic' }, 1)
  const call = journal.beginCanonicalCall(admission.permit, { command: 'synthetic' }, 1)
  if (call.kind !== 'call') throw Error('fresh-call-expected')
  appendFileSync(config.toolEffects, 'tool\n', { mode: 0o600 })
  if (mode === 'call') process.kill(process.pid, 'SIGKILL')
  journal.finish(admission.permit, {
    kind: 'native.receipt',
    payloadHash: config.control.request.body.payloadHash,
    status: 'completed',
  })
  if (mode === 'receipt') process.kill(process.pid, 'SIGKILL')
}
journal.close()
process.stdout.write(JSON.stringify({ kind: admission.kind }))
