import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import Database from 'better-sqlite3'
import type { SystemActionPreview } from '@openclaude/protocol'
import { SystemActionError, SystemActionStore, systemActionRequestHash, type PrepareSystemAction, type SystemActionExecution } from './systemActions.js'

const USER = '765'
const OTHER_FIXTURE_USER = 'synthetic-other'
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-system-ledger-proof-'))
  const dbPath = join(dir, 'actions.db')
  const key = randomBytes(32)
  let now = 1_000_000
  const create = (k = key) => new SystemActionStore({ dbPath, key: k, now: () => now })
  return { dbPath, key, create, tick: (ms: number) => { now += ms } }
}
const preview: SystemActionPreview = {
  title: '更改偏好', description: '只影响此账号后续请求', scope: '账号',
  before: [{ label: '通知', value: '' }], after: [{ label: '通知', value: '关闭\n后续不再发送' }],
  consequences: ['不撤回已发送通知'], price: { kind: 'none', label: '无新增模型请求' }, destructive: false,
}
function input(over: Partial<PrepareSystemAction> = {}): PrepareSystemAction {
  return { userId: USER, sessionId: 'fixture-session', agentId: 'main', operationId: 'preferences.patch', operationTitle: '更改偏好',
    operationVersion: 1, executor: 'master', resourceKey: 'notification', idempotencyKey: 'request-a',
    args: { notify_email: false, content: 'private-content-must-be-encrypted' }, preview, ...over }
}
function proof(store: SystemActionStore, id: string) {
  const d = store.detail(USER, id)
  return { nonce: store.issueChallenge(USER, id, 'device-a', d.previewHash), previewHash: d.previewHash, deviceId: 'device-a' }
}
function handle(value: SystemActionExecution | { browserGrant: string }): SystemActionExecution {
  if (!('executionNonce' in value)) throw new Error('expected master execution')
  return value
}
function throwsCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof SystemActionError && e.code === code)
}
function materials(dbPath: string, id: string) {
  const db = new Database(dbPath, { readonly: true })
  try { return db.prepare('SELECT sealed,approval_hash,grant_hash,execution_hash FROM system_actions WHERE id=?').get(id) } finally { db.close() }
}

describe('master-private persistent system action approvals', () => {
  test('reopens the same encrypted proposal; idempotent keys bind the full intent', () => {
    const t = setup(); const s = t.create(); const a = s.prepare(input())
    assert.equal(s.prepare(input()).id, a.id)
    throwsCode(() => s.prepare(input({ args: { notify_email: true } })), 'CONFLICT')
    assert.equal(s.detail(USER, a.id).preview?.after[0]?.value, '关闭\n后续不再发送')
    s.close()
    assert.equal(readFileSync(t.dbPath).includes(Buffer.from('private-content-must-be-encrypted')), false)
    const reopened = t.create()
    assert.equal(reopened.get(USER, a.id).state, 'prepared')
    assert.equal(reopened.detail(USER, a.id).preview?.title, preview.title)
    reopened.close()
  })
  test('cross-user reads, challenge, decision and execution proof never change the owner record', () => {
    const t = setup()
    const s = t.create()
    const a = s.prepare(input())
    throwsCode(() => s.get(OTHER_FIXTURE_USER, a.id), 'NOT_FOUND')
    throwsCode(() => s.detail(OTHER_FIXTURE_USER, a.id), 'NOT_FOUND')
    throwsCode(() => s.issueChallenge(OTHER_FIXTURE_USER, a.id, 'device-a', 'x'), 'NOT_FOUND')
    throwsCode(() => s.deny(OTHER_FIXTURE_USER, a.id), 'NOT_FOUND')
    const p = proof(s, a.id)
    throwsCode(() => s.confirm(OTHER_FIXTURE_USER, a.id, p, 'worker-a'), 'NOT_FOUND')
    assert.equal(s.get(USER, a.id).state, 'prepared')
    s.close()
  })
  test('wrong nonce, device or preview cannot execute; two connections may claim only once', () => {
    const t = setup()
    const a = t.create()
    const b = t.create()
    const proposal = a.prepare(input())
    const p = proof(a, proposal.id)
    throwsCode(() => a.confirm(USER, proposal.id, { ...p, nonce: 'wrong' }, 'worker'), 'INVALID_PROOF')
    throwsCode(() => a.confirm(USER, proposal.id, { ...p, deviceId: 'other-device' }, 'worker'), 'INVALID_PROOF')
    throwsCode(() => a.confirm(USER, proposal.id, { ...p, previewHash: 'changed-price-or-preview' }, 'worker'), 'INVALID_PROOF')
    const h = handle(a.confirm(USER, proposal.id, p, 'worker-a'))
    throwsCode(() => b.confirm(USER, proposal.id, p, 'worker-b'), 'CONFLICT')
    assert.equal(a.get(USER, proposal.id).state, 'executing')
    throwsCode(() => b.finish({ ...h, executionNonce: 'wrong' }, 'succeeded', { summary: 'done', completion: 'done' }), 'INVALID_PROOF')
    a.finish(h, 'succeeded', { summary: '已更改偏好', completion: 'done', secret: 'must-not-be-projected' } as never)
    assert.equal(JSON.stringify(a.get(USER, proposal.id)).includes('must-not-be-projected'), false)
    assert.deepEqual(materials(t.dbPath, proposal.id), { sealed: null, approval_hash: null, grant_hash: null, execution_hash: null })
    throwsCode(() => b.confirm(USER, proposal.id, p, 'worker-b'), 'CONFLICT')
    a.close(); b.close()
  })
  test('browser confirmation is waiting, not execution; token and device bind a single claim', () => {
    const t = setup()
    const s = t.create()
    const a = s.prepare(input({ executor: 'browser' }))
    const p = proof(s, a.id)
    const approved = s.confirm(USER, a.id, p, 'web-a')
    if (!('browserGrant' in approved)) throw new Error('expected browser grant')
    assert.equal(s.get(USER, a.id).state, 'approved_waiting_browser')
    throwsCode(() => s.claimBrowser(USER, a.id, 'device-b', approved.browserGrant, 'web-b'), 'INVALID_PROOF')
    const fresh = s.renewBrowserGrant(USER, a.id, 'device-a')
    throwsCode(() => s.claimBrowser(USER, a.id, 'device-a', approved.browserGrant, 'web-a'), 'INVALID_PROOF')
    const h = s.claimBrowser(USER, a.id, 'device-a', fresh, 'web-a')
    throwsCode(() => s.claimBrowser(USER, a.id, 'device-a', fresh, 'web-b'), 'CONFLICT')
    s.finish(h, 'succeeded', { summary: '已发起授权，等待本人完成', completion: 'awaiting_user' })
    assert.equal(s.get(USER, a.id).result?.completion, 'awaiting_user')
    s.close()
  })
  test('expiry/denial clear execution materials and never expire or rerun an executing operation', () => {
    const t = setup()
    const s = t.create()
    const a = s.prepare(input({ ttlMs: 10 }))
    const p = proof(s, a.id)
    t.tick(11)
    throwsCode(() => s.confirm(USER, a.id, p, 'worker'), 'EXPIRED')
    assert.deepEqual(materials(t.dbPath, a.id), { sealed: null, approval_hash: null, grant_hash: null, execution_hash: null })
    const b = s.prepare(input({ idempotencyKey: 'b' })); s.deny(USER, b.id)
    assert.equal(s.get(USER, b.id).state, 'denied')
    assert.equal((materials(t.dbPath, b.id) as { sealed: unknown }).sealed, null)
    const c = s.prepare(input({ idempotencyKey: 'c', ttlMs: 10 }))
    const h = handle(s.confirm(USER, c.id, proof(s, c.id), 'worker-c'))
    t.tick(1000); s.expire()
    assert.equal(s.get(USER, c.id).state, 'executing')
    s.finish(h, 'failed', { summary: '已确认未生效', completion: 'done' })
    s.close()
  })
  test('reopen does not steal an executor; proven lost execution becomes unknown and cannot auto-retry', () => {
    const t = setup()
    const s = t.create()
    const a = s.prepare(input())
    handle(s.confirm(USER, a.id, proof(s, a.id), 'proven-dead-worker'))
    s.close()
    const reopened = t.create()
    assert.equal(reopened.get(USER, a.id).state, 'executing')
    assert.equal(reopened.markExecutorLost('different-live-worker'), 0)
    assert.equal(reopened.markExecutorLost('proven-dead-worker'), 1)
    assert.equal(reopened.get(USER, a.id).state, 'unknown')
    throwsCode(() => reopened.prepare(input({ idempotencyKey: 'new-attempt', operationId: 'preferences.other-alias', preview: { ...preview, description: 'changed' } })), 'RECONCILIATION_REQUIRED')
    assert.equal((materials(t.dbPath, a.id) as { sealed: unknown }).sealed, null)
    reopened.close()
  })
  test('two child processes race one approval; a lost finish never repeats the actual effect', { timeout: 15000 }, async () => {
    const t = setup()
    const s = t.create()
    const action = s.prepare(input())
    const p = proof(s, action.id)
    const counter = join(`${t.dbPath}-proof-effects`)
    writeFileSync(counter, '')
    const worker = `${t.dbPath}-worker.mjs`
    writeFileSync(worker, `
      import { appendFileSync } from 'node:fs';
      import { SystemActionStore } from ${JSON.stringify(new URL('./systemActions.ts', import.meta.url).href)};
      process.once('message', m => {
        const store = new SystemActionStore({dbPath:m.dbPath,key:Buffer.from(m.key,'base64'),now:()=>1000000});
        process.send({type:'ready'});
        process.once('message', () => {
          try {
            store.confirm('765',m.id,m.proof,m.owner);
            appendFileSync(m.counter,'effect\\n');
            process.send({type:'result',winner:true});
          } catch(e) { process.send({type:'result',winner:false,code:e.code}); }
          store.close(); process.disconnect();
        });
      });
    `)
    const children = ['child-a','child-b'].map(owner => {
      const child = spawn(process.execPath, ['--import', 'tsx', worker], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: ['ignore','ignore','pipe','ipc'],
      })
      let stderr = ''
      child.stderr?.on('data', b => { stderr += String(b) })
      let readyResolve: () => void = () => {}
      let resultResolve: (x: { winner: boolean; code?: string }) => void = () => {}
      let rejectBoth: (e: Error) => void = () => {}
      const ready = new Promise<void>((resolve, reject) => { readyResolve=resolve; rejectBoth=reject })
      const result = new Promise<{ winner: boolean; code?: string }>((resolve, reject) => {
        resultResolve=resolve; const previous=rejectBoth; rejectBoth=e=>{previous(e);reject(e)}
      })
      const exit = new Promise<void>((resolve, reject) => child.once('exit', code => {
        if(code===0) resolve(); else { const e=new Error(stderr || 'child failed'); rejectBoth(e); reject(e) }
      }))
      child.once('error', rejectBoth)
      child.on('message', (m: {type?:string;winner:boolean;code?:string}) => {
        if(m.type==='ready') readyResolve()
        if(m.type==='result') resultResolve(m)
      })
      child.send({dbPath:t.dbPath,key:t.key.toString('base64'),id:action.id,proof:p,owner,counter})
      return {child,ready,result,exit}
    })
    try {
      await Promise.all(children.map(c=>c.ready))
      for(const c of children) c.child.send({type:'go'})
      const results=await Promise.all(children.map(c=>c.result))
      await Promise.all(children.map(c=>c.exit))
      assert.equal(results.filter(r=>r.winner).length,1)
      assert.equal(results.filter(r=>r.code==='CONFLICT').length,1)
      assert.equal(readFileSync(counter,'utf8'),'effect\n')
      assert.equal(s.get(USER,action.id).state,'executing')
      assert.equal(s.markExecutorLost('child-a')+s.markExecutorLost('child-b'),1)
      throwsCode(()=>s.prepare(input({idempotencyKey:'retry-after-lost-result'})),'RECONCILIATION_REQUIRED')
      assert.equal(readFileSync(counter,'utf8'),'effect\n')
    } finally {
      for(const c of children) if(c.child.exitCode===null) c.child.kill('SIGTERM')
      s.close()
    }
  })
  test('preexisting master and approved browser proposals cannot bypass an unknown resource', () => {
    const t = setup()
    const s = t.create()
    const a = s.prepare(input())
    const b = s.prepare(input({ idempotencyKey: 'preexisting-b' }))
    const c = s.prepare(input({ idempotencyKey: 'preexisting-browser', executor: 'browser' }))
    const pb = proof(s, b.id)
    const approved = s.confirm(USER, c.id, proof(s, c.id), 'browser')
    if (!('browserGrant' in approved)) throw new Error('expected browser approval')
    handle(s.confirm(USER, a.id, proof(s, a.id), 'lost-executor'))
    s.markExecutorLost('lost-executor')
    throwsCode(() => s.confirm(USER, b.id, pb, 'worker-b'), 'RECONCILIATION_REQUIRED')
    throwsCode(() => s.claimBrowser(USER, c.id, 'device-a', approved.browserGrant, 'browser'), 'RECONCILIATION_REQUIRED')
    assert.equal(s.get(USER, b.id).state, 'prepared')
    assert.equal(s.get(USER, c.id).state, 'approved_waiting_browser')
    s.close()
  })
  test('an in-flight resource serializes existing proposals until its result is durable', () => {
    const t = setup()
    const s = t.create()
    const a = s.prepare(input())
    const b = s.prepare(input({ idempotencyKey: 'b' }))
    const pb = proof(s, b.id)
    const h = handle(s.confirm(USER, a.id, proof(s, a.id), 'live-worker'))
    throwsCode(() => s.confirm(USER, b.id, pb, 'worker-b'), 'CONFLICT')
    s.finish(h, 'succeeded', { summary: '第一项结果已落库', completion: 'done' })
    const hb = handle(s.confirm(USER, b.id, pb, 'worker-b'))
    s.finish(hb, 'succeeded', { summary: '第二项结果已落库', completion: 'done' })
    s.close()
  })
  test('a wrong encryption key cannot read pending content', () => {
    const t = setup();
    const s = t.create();
    const a = s.prepare(input()); s.close()
    const wrong = t.create(randomBytes(32))
    assert.throws(() => wrong.detail(USER, a.id))
    assert.equal(wrong.get(USER, a.id).state, 'prepared')
    wrong.close()
  })
})

test('stable original request replay survives a changed business snapshot and process reopen', () => {
  const f = setup()
  const original = { operationId: 'preferences.update', args: { intelligent_ui: false, theme: 'dark' } }
  const requestHash = systemActionRequestHash(original)
  let store = f.create()
  const prepared = store.prepare({ ...input({ idempotencyKey: 'stable-original' }), requestHash })
  store.close(); store = f.create()
  try {
    assert.equal(systemActionRequestHash({ args: { theme: 'dark', intelligent_ui: false }, operationId: 'preferences.update' }), requestHash)
    assert.equal(store.replayPrepared(USER, 'stable-original', requestHash)?.id, prepared.id)
    const concurrentRecompute = store.prepare({ ...input({ idempotencyKey: 'stable-original' }), requestHash, expectedVersion: 'a-new-resource-version', preview: { ...preview, before: [{ label: '通知', value: '其他设备刚更改' }] } })
    assert.equal(concurrentRecompute.id, prepared.id)
    assert.deepEqual(store.detail(USER, prepared.id).preview, preview)
    assert.throws(() => store.replayPrepared(USER, 'stable-original', systemActionRequestHash({ ...original, args: { intelligent_ui: true } })), e => e instanceof SystemActionError && e.code === 'CONFLICT')
    assert.equal(store.replayPrepared(OTHER_FIXTURE_USER, 'stable-original', requestHash), null)
  } finally { store.close() }
})
for (const legacyVersion of [0, 1]) test(`a legacy private ledger (version ${legacyVersion}) migrates without losing its owner-scoped terminal receipt`, () => {
  const f = setup()
  const legacy = new Database(f.dbPath)
  legacy.exec(`CREATE TABLE system_actions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, operation_version INTEGER NOT NULL, executor TEXT NOT NULL,
    resource_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, preview_hash TEXT NOT NULL,
    title TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    sealed TEXT, quote_hash TEXT, expected_version TEXT, device_id TEXT, approval_hash TEXT,
    grant_hash TEXT, execution_hash TEXT, executor_id TEXT, result_json TEXT, UNIQUE(user_id,idempotency_key));
    PRAGMA user_version=${legacyVersion};`)
  legacy.prepare(`INSERT INTO system_actions (id,user_id,session_id,agent_id,operation_id,operation_version,executor,
    resource_key,idempotency_key,input_hash,preview_hash,title,state,created_at,updated_at,expires_at,result_json)
    VALUES ('legacy-action',?,'fixture','main','preferences.update',1,'master','resource','legacy-key','input','preview','旧审批','succeeded',1,2,3,?)`).run(USER, JSON.stringify({ summary: '已保存', completion: 'done' }))
  legacy.close()
  const store = f.create()
  try {
    assert.equal(store.get(USER, 'legacy-action').result?.summary, '已保存')
    assert.throws(() => store.replayPrepared(USER, 'legacy-key', systemActionRequestHash({})), e => e instanceof SystemActionError && e.code === 'CONFLICT')
    const inspect = new Database(f.dbPath, { readonly: true })
    assert.equal(inspect.pragma('user_version', { simple: true }), 2)
    inspect.close()
  } finally { store.close() }
})

test('positive exact receipt reconciles only unknown and never takes over a live executor', () => {
  const fixture = setup(); const store = fixture.create()
  try {
    const proposal = store.prepare(input({ requestHash: systemActionRequestHash({ operation: 'fixture', setting: false }) }))
    const claim = handle(store.confirm(USER, proposal.id, proof(store, proposal.id), 'fixture-executor'))
    assert.match(claim.inputHash, /^[a-f0-9]{64}$/)
    assert.match(claim.requestHash!, /^[a-f0-9]{64}$/)
    assert.equal(store.unknownReceiptBinding(USER, proposal.id), null)
    const binding = { id: claim.id, userId: claim.userId, sessionId: claim.sessionId, agentId: claim.agentId,
      operationId: claim.operationId, operationVersion: claim.operationVersion, requestHash: claim.requestHash, inputHash: claim.inputHash }
    throwsCode(() => store.reconcileUnknownFromReceipt(binding, { summary: 'done', completion: 'done' }), 'INVALID_PROOF')
    assert.equal(store.get(USER, proposal.id).state, 'executing')
    store.finish(claim, 'unknown', { summary: 'check receipt', completion: 'accepted' })
    assert.deepEqual(store.unknownReceiptBinding(USER, proposal.id), binding)
    for (const changed of [{ inputHash: 'f'.repeat(64) }, { requestHash: 'e'.repeat(64) }, { sessionId: 'different' }, { agentId: 'different' }, { operationVersion: 2 }]) {
      throwsCode(() => store.reconcileUnknownFromReceipt({ ...binding, ...changed }, { summary: 'done', completion: 'done' }), 'INVALID_PROOF')
      assert.equal(store.get(USER, proposal.id).state, 'unknown')
    }
    throwsCode(() => store.prepare(input({ idempotencyKey: 'still-blocked' })), 'RECONCILIATION_REQUIRED')
    store.reconcileUnknownFromReceipt(binding, { summary: 'committed', completion: 'done' })
    assert.equal(store.get(USER, proposal.id).state, 'succeeded')
    assert.equal((materials(fixture.dbPath, proposal.id) as { sealed: unknown }).sealed, null)
    store.prepare(input({ idempotencyKey: 'new-explicit-approval' }))
  } finally { store.close() }
})
