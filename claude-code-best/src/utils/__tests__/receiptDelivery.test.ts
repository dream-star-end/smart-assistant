import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../messages.js'
import { admitReceiptInput } from '../receiptInputAdmission.js'
import { bindCoordinatedReceiptInput, openReceiptDelivery } from '../receiptDelivery.js'
import {
  clearSessionMessagesCache, flushSessionStorage, getProjectDir,
  getTranscriptPath, loadFullLog, observeStrictReceiptInput,
  recordTranscript, resetProjectForTesting,
} from '../sessionStorage.js'
import type {
  ReceiptDeliveryCoordinator, TrustedReceiptBinding,
} from '../../../../packages/storage/src/receiptDeliveryCoordinator.js'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
let dir: string
let stores: ReceiptDeliveryCoordinator[]
const oldConfig = process.env.CLAUDE_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oc-206-bun-pair-'))
  stores = []
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  getProjectDir.cache.clear?.()
  resetProjectForTesting()
  clearSessionMessagesCache()
  switchSession(randomUUID())
})
afterEach(async () => {
  await flushSessionStorage()
  stores.forEach(s => s.close())
  resetProjectForTesting()
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  await rm(dir, { recursive: true, force: true })
})

// A real Node gateway creates/upgrades/commits the real durable DB. No manually
// simplified schema or Bun-only fixture. All subprocesses get private HOME.
function node(source: string): string {
  return execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: root,
    env: { PATH: process.env.PATH!, HOME: dir, NODE_ENV: 'test' },
    encoding: 'utf8', timeout: 20000,
  }).trim()
}
async function fixture() {
  const dbPath = join(dir, 'delegate-jobs.db')
  const binding: TrustedReceiptBinding = JSON.parse(node(`
    import {createHash} from 'node:crypto';
    import {DelegateDurableDb} from './packages/gateway/src/delegateDurable.ts';
    import {DelegateJobStore} from './packages/gateway/src/delegateJobs.ts';
    const db=new DelegateDurableDb(${JSON.stringify(dbPath)});
    const jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true});
    const made=jobs.create('worker',{callback:'stdout-wait',callbackOriginUserId:'3',parentSessionKey:'parent',
      deliveryReceipt:{parentTurnKey:'turn',nativeToolUseId:'tool-1',receiptNonceHash:createHash('sha256').update('private-nonce').digest('hex')}});
    if(!('jobId' in made))throw Error('fixture job admission failed');
    const snap=jobs.snapshotOf(made.jobId);
    if(!jobs.complete(made.jobId,{httpStatus:200,body:{ok:false,error:'EXACT_CHILD_FAILURE'}},
      {claimToken:snap.claimToken,fencingEpoch:snap.fencingEpoch}))throw Error('fixture result commit failed');
    console.log(JSON.stringify(db.getDeliveryReceipt(made.jobId,0)));jobs.close();
  `))
  const delivery = await openReceiptDelivery(dbPath)
  stores.push(delivery)
  const first = createUserMessage({ content: 'do the task' })
  const assistant: any = {
    type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(),
    message: { id: 'api-id', type: 'message', role: 'assistant', model: 'synthetic',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'true' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  }
  const result = createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'EXACT_CHILD_FAILURE' }],
    sourceToolAssistantUUID: assistant.uuid,
  })
  const history: Message[] = [first, assistant]
  const parent = { epoch: 'controlled-epoch', isCurrentOwner: async () => true }
  const inspect = () => JSON.parse(node(`
    import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(dbPath)},{fileMustExist:true});
    console.log(JSON.stringify({receipt:db.prepare('SELECT * FROM delegate_delivery_receipt').get(),
      job:db.prepare('SELECT callback,callback_state FROM delegate_jobs').get()}));db.close();
  `))
  const sql = (statement: string) => node(`
    import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(dbPath)},{fileMustExist:true});
    db.exec(${JSON.stringify(statement)});db.close();
  `)
  const restored = async () => loadFullLog({
    isLite: true, sessionId: getSessionId(), fullPath: getTranscriptPath(), messages: [], date: '',
    value: 0, created: new Date(), modified: new Date(), firstPrompt: '', messageCount: 3, isSidechain: false,
  })
  return { dbPath, binding, delivery, result, history, parent, inspect, sql, restored }
}

test('Node-created receipt is ingested by real Bun/CCB native writer, with no callback or duplicate on replay', async () => {
  const f = await fixture()
  bindCoordinatedReceiptInput(f.result, f.delivery, f.binding, f.parent)
  const admitted = await admitReceiptInput(f.result, f.history)
  await recordTranscript([...f.history, admitted])
  await flushSessionStorage()
  const state = f.inspect()
  expect(state.receipt.state).toBe('ingested')
  expect(state.receipt.parent_owner_epoch).toBe('controlled-epoch')
  expect(state.job).toEqual({ callback: 'stdout-wait', callback_state: 'none' })
  expect((await f.restored()).messages.filter(m => m.uuid === f.result.uuid)).toHaveLength(1)
  const rows = (await readFile(getTranscriptPath(), 'utf8')).trim().split('\n').map(s => JSON.parse(s))
  expect(rows.find(r => r.uuid === f.result.uuid).delegateReceipt.resultDigest).toBe(f.binding.resultDigest)
  const replay = await admitReceiptInput(f.result, f.history)
  expect(replay.uuid).not.toBe(f.result.uuid)
  expect(JSON.stringify(replay)).not.toContain('EXACT_CHILD_FAILURE')
  expect(await f.delivery.recover(f.binding, async claim => observeStrictReceiptInput(claim.proof), async () => 'inactive'))
    .toBe('already_ingested')
  expect((await f.restored()).messages.filter(m => m.uuid === f.result.uuid)).toHaveLength(1)
}, 60000)

test('native append followed by real SQL ACK failure is recovered via the native oracle without notification', async () => {
  const f = await fixture()
  f.sql("CREATE TRIGGER reject_ack BEFORE UPDATE OF state ON delegate_delivery_receipt WHEN NEW.state='ingested' BEGIN SELECT RAISE(ABORT,'controlled ACK failure'); END")
  bindCoordinatedReceiptInput(f.result, f.delivery, f.binding, f.parent)
  await expect(admitReceiptInput(f.result, f.history)).rejects.toThrow('controlled ACK failure')
  expect(f.inspect().receipt.state).toBe('ingest_claimed')
  expect((await f.restored()).messages.filter(m => m.uuid === f.result.uuid)).toHaveLength(1)
  f.sql('DROP TRIGGER reject_ack')
  const reopened = await openReceiptDelivery(f.dbPath)
  stores.push(reopened)
  expect(await reopened.recover(f.binding, async claim => observeStrictReceiptInput(claim.proof), async () => 'inactive'))
    .toBe('ingested')
  expect(f.inspect().job.callback_state).toBe('none')
  expect((await f.restored()).messages.filter(m => m.uuid === f.result.uuid)).toHaveLength(1)
}, 60000)

test('a Node notification owner excludes late Bun/native input and never writes original result', async () => {
  const f = await fixture()
  expect(node(`
    import {ReceiptDeliveryStore} from './packages/storage/src/receiptDeliveryStore.ts';
    const store=new ReceiptDeliveryStore(${JSON.stringify(f.dbPath)});
    console.log(await store.recover(${JSON.stringify(f.binding)},async()=>({kind:'absent'}),async()=>'inactive'));store.close();
  `)).toBe('notify_ready')
  bindCoordinatedReceiptInput(f.result, f.delivery, f.binding, f.parent)
  const admitted = await admitReceiptInput(f.result, f.history)
  await recordTranscript([...f.history, admitted])
  await flushSessionStorage()
  expect(f.inspect().receipt.state).toBe('notify_pending')
  const log = await f.restored()
  expect(log.messages.some(m => m.uuid === f.result.uuid)).toBe(false)
  expect(JSON.stringify(log.messages)).not.toContain('EXACT_CHILD_FAILURE')
  expect(JSON.stringify(log.messages)).toContain('不重复提交结果')
}, 60000)

test('Bun writer holds the same FD barrier against Node recovery until native write/ACK finish', async () => {
  const f = await fixture()
  let unlock!: () => void
  let acquired!: () => void
  const pause = new Promise<void>(r => { unlock = r })
  const ready = new Promise<void>(r => { acquired = r })
  bindCoordinatedReceiptInput(f.result, f.delivery, f.binding, {
    epoch: 'controlled-epoch', isCurrentOwner: async () => { acquired(); await pause; return true },
  })
  const input = admitReceiptInput(f.result, f.history)
  const settled = input.catch(() => {})
  await ready
  try {
    const other = node(`
      import {ReceiptDeliveryStore} from './packages/storage/src/receiptDeliveryStore.ts';
      const store=new ReceiptDeliveryStore(${JSON.stringify(f.dbPath)});
      try{await store.recover(${JSON.stringify(f.binding)},async()=>({kind:'absent'}),async()=>'inactive',{timeoutMs:25});console.log('UNSAFE_NOTIFY');}
      catch(e){console.log(e.message);}finally{store.close();}
    `)
    expect(other).toMatch(/flock failed|timed out/)
    expect(f.inspect().receipt.state).toBe('offered')
  } finally { unlock(); await settled }
  expect((await input).uuid).toBe(f.result.uuid)
  expect(f.inspect().receipt.state).toBe('ingested')
}, 60000)

test('Bun transaction rolls back both receipt and callback when job-update fails', async () => {
  const f = await fixture()
  f.sql("CREATE TRIGGER reject_notify BEFORE UPDATE OF callback ON delegate_jobs BEGIN SELECT RAISE(ABORT,'controlled notify failure'); END")
  await expect(f.delivery.recover(f.binding, async () => ({ kind: 'absent' }), async () => 'inactive'))
    .rejects.toThrow('controlled notify failure')
  expect(f.inspect().receipt.state).toBe('offered')
  expect(f.inspect().receipt.owner_token).toBeNull()
  expect(f.inspect().job.callback_state).toBe('none')
}, 60000)

test('Bun rejects stale parent, wrong native tool and cross-user bindings before original input writes', async () => {
  const f = await fixture()
  expect(() => bindCoordinatedReceiptInput(f.result, f.delivery, { ...f.binding, nativeToolUseId: 'other' }, f.parent))
    .toThrow('bound native tool')
  bindCoordinatedReceiptInput(f.result, f.delivery, { ...f.binding, userId: 'foreign' }, f.parent)
  await expect(admitReceiptInput(f.result, f.history)).rejects.toThrow('binding mismatch')
  const other = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'STALE_RESULT' }],
    sourceToolAssistantUUID: f.history[1]!.uuid as any })
  bindCoordinatedReceiptInput(other, f.delivery, f.binding, { epoch: 'stale', isCurrentOwner: async () => false })
  const result = await admitReceiptInput(other, f.history)
  expect(JSON.stringify(result)).not.toContain('STALE_RESULT')
  expect(f.inspect().receipt.state).toBe('offered')
}, 60000)

test('Bun adapter refuses memory, missing database and old schema without creating or upgrading', async () => {
  await expect(openReceiptDelivery(':memory:')).rejects.toThrow('persistent database')
  await expect(openReceiptDelivery(join(dir, 'missing.db'))).rejects.toThrow()
  const f = await fixture()
  f.sql('PRAGMA user_version=6')
  await expect(openReceiptDelivery(f.dbPath)).rejects.toThrow('unsupported receipt consumer schema')
  expect(node(`import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(f.dbPath)});console.log(db.pragma('user_version',{simple:true}));db.close();`)).toBe('6')
}, 60000)

test('the same CCB receipt factory supports an explicitly selected Node runtime', async () => {
  const f = await fixture()
  expect(node(`
    import {openReceiptDelivery} from './claude-code-best/src/utils/receiptSqlite.ts';
    const store=await openReceiptDelivery(${JSON.stringify(f.dbPath)});
    console.log(await store.recover(${JSON.stringify(f.binding)},async()=>({kind:'absent'}),async()=>'inactive'));store.close();
  `)).toBe('notify_ready')
  expect(f.inspect().receipt.state).toBe('notify_pending')
}, 60000)

for (const afterAppend of [false, true]) {
  test(`actual Bun input writer SIGKILL ${afterAppend ? 'after native fsync' : 'before append'} recovers once from SQLite and native history`, async () => {
    const f = await fixture()
    const child = spawn(process.execPath, ['-e', `
      import {openReceiptDelivery} from './src/utils/receiptSqlite.ts';
      import {prepareStrictReceiptInput} from './src/utils/sessionStorage.ts';
      import {switchSession} from './src/bootstrap/state.ts';
      switchSession(${JSON.stringify(getSessionId())});
      const store=await openReceiptDelivery(${JSON.stringify(f.dbPath)});
      const binding=${JSON.stringify(f.binding)};
      const prepared=await prepareStrictReceiptInput(${JSON.stringify(f.result)},${JSON.stringify(f.history)},
        {jobId:binding.jobId,generation:binding.generation,resultDigest:binding.resultDigest});
      await store.ingest(binding,{proof:prepared.proof,parentOwnerEpoch:'controlled-child',isCurrentParentOwner:async()=>true},async()=>{
        if(${afterAppend})await prepared.commit();
        console.log('PAIRED_WRITER_LOCKED');
        await new Promise(()=>{setInterval(()=>{},1000)});
      },()=>prepared.observe());store.close();
    `], {
      cwd: join(root, 'claude-code-best'),
      env: { PATH: process.env.PATH!, HOME: dir, CLAUDE_CONFIG_DIR: dir, NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = '', stdout = ''
    child.stderr!.on('data', b => { stderr += b })
    const exited = new Promise<void>(r => child.once('close', () => r()))
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000)
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', b => { stdout += b; if (stdout.includes('PAIRED_WRITER_LOCKED')) resolve() })
        child.once('error', reject)
        child.once('close', () => reject(Error(stderr || 'writer exited before acquiring receipt')))
      })
      expect(f.inspect().receipt.state).toBe('ingest_claimed')
      await expect(f.delivery.recover(f.binding, async claim => observeStrictReceiptInput(claim.proof), async () => 'inactive', { timeoutMs: 25 }))
        .rejects.toThrow(/flock failed|timed out/)
      child.kill('SIGKILL')
      await exited
      expect(child.signalCode).toBe('SIGKILL')
      const state = f.inspect()
      const proof = JSON.parse(state.receipt.input_proof)
      expect(await f.delivery.recover(f.binding, async claim => observeStrictReceiptInput(claim.proof), async () => 'inactive'))
        .toBe(afterAppend ? 'ingested' : 'notify_ready')
      expect(f.inspect().job.callback_state).toBe(afterAppend ? 'none' : 'pending')
      if (afterAppend) {
        // A third OS process reopens through the real CCB --resume reader.
        const resumed = Bun.spawn([process.execPath, '-e', `
          import {loadFullLog} from './src/utils/sessionStorage.ts';
          const proof=${JSON.stringify(proof)};
          const log=await loadFullLog({isLite:true,sessionId:proof.nativeSessionId,fullPath:JSON.parse(proof.recordLocator)[0],
            messages:[],date:'',value:0,created:new Date(),modified:new Date(),firstPrompt:'',messageCount:3,isSidechain:false});
          console.log(JSON.stringify(log.messages.filter(m=>m.uuid===${JSON.stringify(f.result.uuid)})));
        `], {
          cwd: join(root, 'claude-code-best'),
          env: { PATH: process.env.PATH!, HOME: dir, CLAUDE_CONFIG_DIR: dir, NODE_ENV: 'test' },
          stdout: 'pipe', stderr: 'pipe',
        })
        const [out, err, code] = await Promise.all([new Response(resumed.stdout).text(), new Response(resumed.stderr).text(), resumed.exited])
        expect({ code, err }).toEqual({ code: 0, err: '' })
        const matches = JSON.parse(out.trim())
        expect(matches).toHaveLength(1)
        expect(JSON.stringify(matches)).toContain('EXACT_CHILD_FAILURE')
      }
    } finally {
      clearTimeout(watchdog)
      child.kill('SIGKILL')
      await exited
    }
  }, 60000)
}
