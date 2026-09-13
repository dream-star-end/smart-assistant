import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ReceiptCandidateLifecycle } from '@openclaude/storage/receiptCandidateLifecycle'
import { checkedReceiptToolOwner, ReceiptOwnerCapabilities } from '../../../gateway/src/receiptOwnerCapability.js'
import { ReceiptCliTransport, RECEIPT_CAP_ENV, RECEIPT_CACHE_ENV, RECEIPT_REPORT_ENV } from '../receiptCliTransport.js'

const issuer = new ReceiptOwnerCapabilities()
const identity = { userId: 'c:3', agentId: 'main', sessionKey: 'parent-session', adapterInstanceId: 'adapter',
  parentOwnerEpoch: 'epoch', turnKey: 'turn', nativeSessionId: 'native', consumerToolUseId: 'creator', toolName: 'Bash', contextHash: 'hash-a' }
const issue = (extra = {}) => issuer.issue({ ...identity, ...extra })
const partition = (cap: string) => issuer.verify(cap)!.locatorPartition
const locator = { jobId: 'dlgjob-cache-1', generation: 1, receiptNonce: 'a'.repeat(64) }
function setup() {
  const home = fs.mkdtempSync(join(tmpdir(), 'receipt-cache-'))
  const context = join(home, 'context');fs.writeFileSync(context, 'synthetic-file-token', {mode:0o600})
  const old = process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE
  process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE = context
  const root = join(home, 'cache')
  const lifecycle = new ReceiptCandidateLifecycle(root)
  const register = async (cap = issue()) => {
    const c = issuer.verify(cap)!
    await lifecycle.register({ partition: c.locatorPartition, userId: c.userId, agentId: c.agentId, sessionKey: c.sessionKey, owner: { ...checkedReceiptToolOwner(c) } }, c.consumerToolUseId, () => {})
  }
  const make = (cap = issue(), cache = root) => new ReceiptCliTransport({
    [RECEIPT_CAP_ENV]: cap, [RECEIPT_CACHE_ENV]: cache, [RECEIPT_REPORT_ENV]: new ReceiptCandidateLifecycle(cache).reportPath(partition(cap), issuer.verify(cap)!.consumerToolUseId),
  })
  return {home, root, context, make, register, lifecycle, close() {
    if(old===undefined)delete process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE;else process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE=old
    fs.rmSync(home,{recursive:true,force:true})
  }}
}

test('signed partition survives credential and consumer refresh but separates every authenticated owner dimension', () => {
  const original = issue(), key = partition(original)
  assert.match(key,/^[a-f0-9]{64}$/)
  assert.equal(partition(issue({contextHash:'new-context',consumerToolUseId:'independent-wait',toolName:'mcp__openclaude-memory__delegate_wait'})),key)
  for(const field of ['userId','agentId','sessionKey','adapterInstanceId','parentOwnerEpoch','turnKey','nativeSessionId'] as const) {
    assert.notEqual(partition(issue({[field]:identity[field]+'-other'})),key,field)
  }
  const [payload, signature] = original.split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());claims.locatorPartition='f'.repeat(64)
  assert.equal(issuer.verify(Buffer.from(JSON.stringify(claims)).toString('base64url')+'.'+signature),null)
  // Even an issue caller's extra field cannot override the internal derivation.
  assert.equal(partition(issue({locatorPartition:'f'.repeat(64)})),key)
})

test('separate refreshed transport finds immutable candidate; foreign turn cannot find it or create a fallback partition', async () => {
  const f=setup()
  try {
    await f.register(); await f.make().remember(locator)
    fs.writeFileSync(f.context,'refreshed-validity-tested-by-real-HTTP-model-fixture')
    const refreshed=f.make(issue({contextHash:'hash-b',consumerToolUseId:'waiter'}))
    assert.deepEqual(await refreshed.lookup(locator.jobId),locator)
    await assert.rejects(f.make(issue({turnKey:'new-turn'})).lookup(locator.jobId), /namespace unavailable/)
    assert.equal(fs.readdirSync(join(f.root,'data')).length,1)
    assert.throws(()=>new ReceiptCliTransport({[RECEIPT_CAP_ENV]:'no-signed-partition',[RECEIPT_CACHE_ENV]:f.root},()=>{}),/partition/)
    await assert.rejects(refreshed.remember({...locator,receiptNonce:'b'.repeat(64)}),/conflicting/)
    assert.deepEqual(await refreshed.lookup(locator.jobId),locator)
  }finally{f.close()}
})

test('actual concurrent processes publish one complete candidate, idempotently, with no partial final files', async () => {
  const f=setup(),cap=issue()
  try {
    await f.register(cap)
    const source=new URL('../receiptCliTransport.ts',import.meta.url).pathname
    const env={PATH:process.env.PATH!,HOME:f.home,OPENCLAUDE_DELEGATE_CONTEXT_FILE:f.context,
      [RECEIPT_CAP_ENV]:cap,[RECEIPT_CACHE_ENV]:f.root,[RECEIPT_REPORT_ENV]:f.lifecycle.reportPath(partition(cap),identity.consumerToolUseId)}
    await Promise.all(Array.from({length:6},()=>new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
        `import {ReceiptCliTransport} from ${JSON.stringify(source)}; await new ReceiptCliTransport().remember(${JSON.stringify(locator)});`],{env,stdio:['ignore','ignore','pipe']})
      let stderr='';child.stderr.on('data',b=>{stderr+=b})
      const timer=setTimeout(()=>child.kill('SIGKILL'),15000)
      child.once('error',e=>{clearTimeout(timer);reject(e)})
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(stderr||String(code)))})
    })))
    assert.deepEqual(await f.make(cap).lookup(locator.jobId),locator)
    assert.deepEqual(fs.readdirSync(join(f.root,'data',partition(cap),'cache')),[locator.jobId+'.json'])
    assert.equal(fs.statSync(join(f.root,'data',partition(cap),'cache',locator.jobId+'.json')).mode&0o777,0o600)
  }finally{f.close()}
})

test('lookup rejects symlink, FIFO, directory, oversized, public and wrong-job entries without traversing or blocking', async () => {
  const f=setup(),cap=issue()
  try {
    await f.register(cap);const t=f.make(cap);await t.remember(locator)
    const file=join(f.root,'data',partition(cap),'cache',locator.jobId+'.json'), outside=join(f.home,'outside')
    fs.writeFileSync(outside,JSON.stringify(locator),{mode:0o600});fs.unlinkSync(file)
    fs.symlinkSync(outside,file);await assert.rejects(t.lookup(locator.jobId));await assert.rejects(t.remember(locator));fs.unlinkSync(file)
    assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify(locator))
    assert.equal(spawnSync('mkfifo',[file]).status,0);await assert.rejects(t.lookup(locator.jobId),/invalid receipt cache record/);fs.unlinkSync(file)
    fs.mkdirSync(file);await assert.rejects(t.lookup(locator.jobId),/invalid receipt cache record/);fs.rmdirSync(file)
    fs.writeFileSync(file,'x'.repeat(4097),{mode:0o600});await assert.rejects(t.lookup(locator.jobId),/invalid receipt cache record/)
    fs.writeFileSync(file,JSON.stringify({...locator,jobId:'dlgjob-wrong'}));await assert.rejects(t.lookup(locator.jobId),/job mismatch/)
    fs.writeFileSync(file,JSON.stringify(locator));fs.chmodSync(file,0o644);await assert.rejects(t.lookup(locator.jobId),/invalid receipt cache record/)
  }finally{f.close()}
})

test('private root and partition are no-follow; path replacement after open cannot redirect publication', async () => {
  const f=setup(),cap=issue(),originalOpen=fs.openSync
  try {
    const outside=join(f.home,'outside');fs.mkdirSync(outside,{mode:0o700})
    fs.symlinkSync(outside,f.root);await assert.rejects(f.make(cap).remember(locator));assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(f.root)
    await f.register(cap)
    const cache = join(f.root,'data',partition(cap),'cache');fs.rmdirSync(cache);fs.symlinkSync(outside,cache)
    await assert.rejects(f.make(cap).remember(locator));assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(cache);fs.mkdirSync(cache,{mode:0o700})
    fs.chmodSync(f.root,0o755);await assert.rejects(f.make(cap).remember(locator),/private/);fs.chmodSync(f.root,0o700)
    const saved=join(f.home,'pinned-root');let replaced=false
    fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{
      const fd=originalOpen(...args)
      if(args[0]===f.root&&!replaced){replaced=true;fs.renameSync(f.root,saved);fs.symlinkSync(outside,f.root)}
      return fd
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    await f.make(cap).remember(locator)
    assert.ok(replaced);assert.deepEqual(fs.readdirSync(outside),[])
    assert.deepEqual(JSON.parse(fs.readFileSync(join(saved,'data',partition(cap),'cache',locator.jobId+'.json'),'utf8')),locator)
    await assert.rejects(f.make(cap).lookup(locator.jobId))
  }finally{fs.openSync=originalOpen;syncBuiltinESMExports();f.close()}
})
