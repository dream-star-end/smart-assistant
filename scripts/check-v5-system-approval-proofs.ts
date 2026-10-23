/** Real temporary SQLite + independent executors. No app startup, PG, account or external provider. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SystemActionStore, type PrepareSystemAction } from '../packages/storage/src/systemActions.js'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = new URL('../packages/storage/src/systemActions.ts', import.meta.url).href
const dir = mkdtempSync(join(tmpdir(), 'oc-approval-gate-'))
const dbPath = join(dir, 'actions.db')
const key = randomBytes(32)
const store = new SystemActionStore({ dbPath, key, now: () => 1000000 })
const effectPath = join(dir, 'isolated-effects')
writeFileSync(effectPath, '')
const input: PrepareSystemAction = { userId: '765', sessionId: 'isolated-proof', agentId: 'main', operationId: 'proof.notification', operationVersion: 1,
  operationTitle: '隔离审批证明', executor: 'master', resourceKey: 'same-resource', idempotencyKey: 'proof-a', args: { enabled: false },
  preview: { title: '隔离审批证明', description: '只写本证明的临时计数文件', scope: '独立fixture', before: [], after: [], consequences: ['不调用产品操作'], destructive: false, price: { kind: 'none', label: '无付费或网络请求' } } }
function proof(id: string) {
  const detail = store.detail('765', id)
  return { nonce: store.issueChallenge('765', id, 'device-a', detail.previewHash), previewHash: detail.previewHash, deviceId: 'device-a' }
}
function expectBlocked(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => Boolean(e && typeof e === 'object' && 'code' in e && e.code === code), `expected ${code}`)
}
const children: ReturnType<typeof spawn>[] = []
const workerPath = join(dir, 'executor.mjs')
writeFileSync(workerPath, `
import { appendFileSync } from 'node:fs';
import { SystemActionStore } from ${JSON.stringify(SOURCE)};
process.once('message', m => {
  const s = new SystemActionStore({dbPath:m.dbPath,key:Buffer.from(m.key,'base64'),now:()=>1000000});
  process.send({type:'ready'});
  process.once('message', () => {
    try {
      if (m.mode==='race') {
        s.confirm('765',m.id,m.proof,m.owner);
        appendFileSync(m.effects,'effect\\n');
      } else {
        for(let i=0;i<20;i++) {
          const a=s.prepare({...m.input,idempotencyKey:m.owner+'-'+i,resourceKey:m.owner+'-'+i});
          const d=s.detail('765',a.id);
          const nonce=s.issueChallenge('765',a.id,'device-a',d.previewHash);
          const h=s.confirm('765',a.id,{nonce,previewHash:d.previewHash,deviceId:'device-a'},m.owner);
          appendFileSync(m.effects,'effect\\n');
          s.finish(h,'succeeded',{summary:'fixture effect persisted',completion:'done'});
        }
      }
      process.send({type:'result',ok:true});
    } catch(e) { process.send({type:'result',ok:false,code:e.code??'PROOF_ERROR'}); }
    s.close();process.disconnect();
  });
});
`)
async function runPair(mode: 'race' | 'stress', args: Record<string, unknown>) {
  const workers = ['proof-a', 'proof-b'].map(owner => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    children.push(child)
    let ready!: () => void
    let result!: (v: { ok: boolean; code?: string }) => void
    let rejectReady!: (e: Error) => void
    let rejectResult!: (e: Error) => void
    const readyPromise = new Promise<void>((r, reject) => { ready = r; rejectReady = reject })
    const resultPromise = new Promise<{ ok: boolean; code?: string }>((r, reject) => { result = r; rejectResult = reject })
    const exitPromise = new Promise<void>((r, reject) => {
      const fail = () => { const e = new Error('isolated approval executor failed'); rejectReady(e); rejectResult(e); reject(e) }
      child.once('error', fail)
      child.once('exit', code => { if (code === 0) r(); else fail() })
    })
    child.on('message', (v: { type: string; ok: boolean; code?: string }) => { if (v.type === 'ready') ready(); if (v.type === 'result') result(v) })
    child.send({ dbPath, key: key.toString('base64'), input, effects: effectPath, mode, owner, ...args })
    return { child, readyPromise, resultPromise, exitPromise }
  })
  const deadline = setTimeout(() => { for (const { child } of workers) if (child.exitCode === null) child.kill('SIGTERM') }, 30000)
  try {
    await Promise.all(workers.map(w => w.readyPromise))
    for (const w of workers) w.child.send({ type: 'go' })
    const result = await Promise.all(workers.map(w => w.resultPromise))
    await Promise.all(workers.map(w => w.exitPromise))
    return result
  } finally { clearTimeout(deadline) }
}
try {
  const a = store.prepare(input)
  const b = store.prepare({ ...input, idempotencyKey: 'preexisting-master' })
  const c = store.prepare({ ...input, idempotencyKey: 'preexisting-browser', executor: 'browser' })
  const pb = proof(b.id)
  const approved = store.confirm('765', c.id, proof(c.id), 'browser')
  assert.ok('browserGrant' in approved)
  const race = await runPair('race', { id: a.id, proof: proof(a.id) })
  assert.equal(race.filter(r => r.ok).length, 1, 'one approval starts one isolated effect')
  assert.equal(race.filter(r => r.code === 'CONFLICT').length, 1, 'loser is a domain conflict, never SQLITE_BUSY_SNAPSHOT')
  assert.equal(store.markExecutorLost('proof-a') + store.markExecutorLost('proof-b'), 1)
  expectBlocked(() => store.confirm('765', b.id, pb, 'preexisting'), 'RECONCILIATION_REQUIRED')
  expectBlocked(() => store.claimBrowser('765', c.id, 'device-a', approved.browserGrant, 'browser'), 'RECONCILIATION_REQUIRED')
  expectBlocked(() => store.prepare({ ...input, idempotencyKey: 'retry' }), 'RECONCILIATION_REQUIRED')
  assert.equal(readFileSync(effectPath, 'utf8'), 'effect\n', 'unknown and preexisting proposals never repeat the effect')
  const stress = await runPair('stress', {})
  assert.equal(stress.filter(r => r.ok).length, 2, 'both concurrent writers durably finish unrelated operations')
  assert.equal(readFileSync(effectPath, 'utf8').trim().split('\n').length, 41)
  console.log('[ocv5-610-durable-approval-fencing] PASS: one raced effect; old master/browser proposals blocked after loss; 40 concurrent completions durable')
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  store.close(); key.fill(0)
}
