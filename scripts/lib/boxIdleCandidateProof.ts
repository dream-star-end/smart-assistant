import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** Run real SessionManager submit/recovery in a fresh process so the proof
 * cannot share the release gate's OPENCLAUDE_HOME or sessions backend. */
export async function proveIdleCandidateRecovery(candidate: string): Promise<string> {
  const fixture = pathToFileURL(join(candidate,
    'packages/gateway/src/__tests__/fixtures/boxIdleCandidateFixture.ts')).href
  const receipt = '[t1642u-box-idle-recovery] PASS'
  const code = `const m = await import(${JSON.stringify(fixture)}); console.log(await m.proveBoxIdleCandidateRecovery())`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code],
      { cwd: candidate, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-128_000) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', status => {
      clearTimeout(timer)
      if (status === 0 && output.split('\n').includes(receipt)) resolve(receipt)
      else reject(new Error(`T1642U_CANDIDATE_PROOF_FAILED exit=${status}\n${output}`))
    })
  })
}
