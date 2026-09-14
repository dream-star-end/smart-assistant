/** Real model CLI + actual late descendant. Synthetic upstream only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../', import.meta.url))
for (const mode of ['late', 'ordinary', 'deleted']) test(`real model candidate lifecycle ${mode}`, { timeout: 150000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-model-'))
  const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'),
    fileURLToPath(new URL('./fixtures/receiptCandidateModel.fixture.ts', import.meta.url)), dir, mode],
  { cwd: root, env: { PATH: process.env.PATH!, HOME: dir, NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1',
    OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { error += b })
  const timer = setTimeout(() => child.kill('SIGTERM'), 130000)
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    assert.equal(exit, 0, error.slice(-6000)); assert.match(output, /CANDIDATE_LIFECYCLE_PASS/)
    const p = JSON.parse(readFileSync(join(dir, 'lifecycle-proof.json'), 'utf8'))
    assert.equal(p.recreated, false); assert.equal(p.ordinaryPreserved, true)
    assert.deepEqual(p.states, ['retired']); assert.equal(p.executions, mode !== 'ordinary' ? 1 : 0)
    assert.equal(p.writerAliveAfterEnd, mode !== 'ordinary')
    process.stdout.write(JSON.stringify(p) + '\n')
  } finally { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }) }
})
