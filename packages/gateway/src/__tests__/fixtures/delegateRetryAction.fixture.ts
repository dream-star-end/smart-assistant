import { spawnSync } from 'node:child_process'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'
const [path, keyText, sourceText, output] = process.argv.slice(2)
const jobs = new DelegateJobStore({ durable: new DelegateDurableDb(path!), sm: true })
process.stdout.write('READY\n')
await new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
try {
  const accepted = jobs.acceptRetryAction(JSON.parse(keyText!), JSON.parse(sourceText!))
  if ('error' in accepted) throw new Error(accepted.error)
  if (accepted.kind === 'accepted') {
    const claim = jobs.claimQueued(accepted.action.targetJobId)
    if (!claim.ok) throw new Error('original claim failed')
    const child = spawnSync(process.execPath, ['-e', `require('node:fs').appendFileSync(process.argv[1],process.argv[2]+'\\n')`, output!, accepted.action.targetJobId])
    if (child.status !== 0) throw new Error(child.stderr?.toString())
    if (!jobs.complete(accepted.action.targetJobId, { httpStatus: 200, body: { output: 'private synthetic child' } }, claim)) throw new Error('terminal failed')
  }
  process.stdout.write(JSON.stringify({ kind: accepted.kind, target: accepted.action.targetJobId }) + '\n')
} finally { jobs.close() }
