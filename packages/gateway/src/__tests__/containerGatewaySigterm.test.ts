// OCV5-733: the container chain is tini -> entrypoint.ts -> `npm run gateway`
// -> sh -c <scripts.gateway> -> bash run-container-gateway.sh -> exec node.
// npm forwards SIGTERM only to its direct child, the `sh -c`. Without `exec`
// that shell dies on the signal and the gateway never runs its shutdown: on
// 2026-11-04 a `docker restart` left no "shutting down" log and a Box run
// orphaned as first_round_unknown. This runs the repository's exact
// scripts.gateway string through real npm, with only the script path swapped
// for a probe that execs node like run-container-gateway.sh does.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const GATEWAY_SCRIPT = 'packages/cli/scripts/run-container-gateway.sh'

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

test('OCV5-733 SIGTERM sent to `npm run gateway` reaches the gateway node process', async () => {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  const command: string = scripts.gateway
  assert.ok(command.includes(GATEWAY_SCRIPT), command)
  const realScript = readFileSync(path.join(ROOT, GATEWAY_SCRIPT), 'utf8')
  assert.match(realScript, /^\s*exec node /m, 'run-container-gateway.sh must exec node')

  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-733-sigterm-'))
  const out = path.join(dir, 'out.txt')
  try {
    writeFileSync(path.join(dir, 'probe.mjs'), [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(out)}, 'pid:' + process.pid + '\\n')`,
      `process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(out)}, 'SIGTERM\\n'); process.exit(0) })`,
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    writeFileSync(path.join(dir, 'probe.sh'), `exec node ${JSON.stringify(path.join(dir, 'probe.mjs'))}\n`)
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0',
      scripts: { gateway: command.replace(GATEWAY_SCRIPT, 'probe.sh') } }))
    const npm = spawn('npm', ['run', '--silent', 'gateway'], { cwd: dir, stdio: 'ignore' })
    const exited = new Promise<void>((resolve) => npm.once('exit', () => resolve()))
    assert.ok(await waitFor(() => existsSync(out), 15_000), 'probe did not start')
    npm.kill('SIGTERM')
    const got = await waitFor(() => readFileSync(out, 'utf8').includes('SIGTERM'), 5_000)
    if (!got) {
      const pid = Number(/^pid:(\d+)$/m.exec(readFileSync(out, 'utf8'))?.[1])
      try { if (pid > 0) process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    assert.equal(got, true, 'gateway process never received SIGTERM through npm run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
