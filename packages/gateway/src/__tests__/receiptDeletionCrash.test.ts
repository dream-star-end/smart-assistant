import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('SIGKILL after actual SQL DELETE before candidate cleanup is repaired by new process Gateway.start receipt boot prefix', { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'f2-crash-private-'))
  const fixture = fileURLToPath(new URL('./fixtures/receiptDeletionCrash.fixture.ts', import.meta.url))
  const env = { PATH: process.env.PATH, HOME: home, OPENCLAUDE_HOME: home, NODE_ENV: 'test' }
  const old = spawn(process.execPath, ['--import', 'tsx', fixture, 'delete'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const oldClosed = once(old, 'close')
  let boot: ChildProcess | undefined, bootClosed: Promise<unknown[]> | undefined
  const deadline = setTimeout(() => { old.kill('SIGKILL'); boot?.kill('SIGKILL') }, 25000)
  let output = '', errors = ''
  old.stderr.on('data', b => { errors += b })
  try {
    const reached = await new Promise<{ data: string; partition: string; state: string }>((resolve, reject) => {
      old.stdout.on('data', b => {
        output += b
        for (const line of output.split('\n')) {
          try { const row = JSON.parse(line); if (row.phase === 'sql-before-fs') { resolve(row); return } } catch { /* partial log */ }
        }
      })
      old.once('close', (code, signal) => reject(new Error(`crash gate missed: ${code}/${signal}\n${errors}\n${output}`)))
    })
    assert.equal(reached.state, 'deleted'); assert.ok(existsSync(reached.data))
    old.kill('SIGKILL'); const [code, signal] = await oldClosed
    assert.equal(code, null); assert.equal(signal, 'SIGKILL')
    assert.ok(existsSync(reached.data), 'kernel death itself must not impersonate cleanup')
    boot = spawn(process.execPath, ['--import', 'tsx', fixture, 'boot', reached.data], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    bootClosed = once(boot, 'close')
    let bootOut = '', bootErr = ''
    boot.stdout!.on('data', b => { bootOut += b }); boot.stderr!.on('data', b => { bootErr += b })
    const [exit, bootSignal] = await bootClosed
    assert.equal(exit, 0, bootErr); assert.equal(bootSignal, null)
    assert.match(bootOut, /"phase":"boot-swept","calls":1,"exists":false/)
    assert.equal(existsSync(reached.data), false)
    const manifest = JSON.parse(readFileSync(join(home, 'receipt-candidates-v1', 'namespaces', reached.partition + '.json'), 'utf8'))
    assert.equal(manifest.state, 'retired')
    assert.deepEqual(manifest.deletionRef, { userId: 'default', clientSessionId: 'f2-crash' })
  } finally { clearTimeout(deadline); old.kill('SIGKILL'); boot?.kill('SIGKILL'); await oldClosed; await bootClosed }
})
