/** Real model CLI/SDK/stdio, synthetic upstream and new-process native recovery. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
async function run(cmd: string, args: string[], home: string) {
  const child = spawn(cmd, args, { cwd: root, env: { PATH: process.env.PATH!, HOME: home, NODE_ENV: 'test',
    TEST_ENABLE_SESSION_PERSISTENCE: '1', OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { err += b })
  const timer = setTimeout(() => child.kill('SIGTERM'), 210000)
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(exit, 0, `${out.slice(-2000)}\n${err.slice(-5000)}`)
    return out
  } finally { clearTimeout(timer) }
}
for (const mode of ['background-create', 'background-stop', 'create-live-refresh', 'deferred-create-live-refresh', 'create-before-refresh', 'create-before-revoke'] as const) {
  test(`coherent credentials actual model ${mode}`, { timeout: 240000 }, async () => {
    const dir = mkdtempSync(join(process.env.RECEIPT_TEST_EVIDENCE_DIR || tmpdir(), `credentials-${mode}-`))
    try {
      const bg = mode.startsWith('background-'), submode = bg ? mode.replace('background-', '') : mode
      const model = join(fixtures, bg ? 'receiptModelCredentialBackground.fixture.ts' : 'receiptModelCredentialForeground.fixture.ts')
      const out = await run(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), model, dir, submode], dir)
      assert.match(out, /MODEL_PROBE_PASS/)
      const e = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'))
      const denied = mode === 'create-before-revoke'
      assert.equal(e.failure, null); assert.equal(e.executions, denied ? 0 : 1); assert.equal(bg ? e.refreshed : e.renewed, true)
      assert.ok(e.http.some((r: {path: string; status: number}) => r.path.endsWith('/refresh') && r.status === (denied ? 409 : 200)))
      const stopped = mode === 'background-stop' || denied
      assert.equal(e.received, !stopped)
      const restore = join(fixtures, bg ? 'receiptBackgroundRestore.fixture.ts' : 'receiptModelRestore.fixture.ts')
      const restored = await run('bun', ['run', restore, dir, stopped ? 'stop' : 'create'], dir)
      const proof = JSON.parse(restored.trim().split('\n').pop()!)
      assert.equal(proof.receiptInputs, stopped ? 0 : 1); assert.equal(proof.passed, true)
      console.log(JSON.stringify({ mode, dir, modelRequests: e.requests.length, executions: e.executions, restored: proof.receiptInputs }))
    } finally { if (!process.env.RECEIPT_TEST_EVIDENCE_DIR) rmSync(dir, { recursive: true, force: true }) }
  })
}
