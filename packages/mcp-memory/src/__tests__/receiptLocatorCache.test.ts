import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ReceiptOwnerCapabilities } from '../../../gateway/src/receiptOwnerCapability.js'
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
  const make = (cap = issue(), cache = root) => new ReceiptCliTransport({
    [RECEIPT_CAP_ENV]: cap, [RECEIPT_CACHE_ENV]: cache, [RECEIPT_REPORT_ENV]: join(home, 'unused'),
  })
  return {home, root, context, make, close() {
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

test('separate refreshed transport finds immutable candidate; foreign turn cannot find it or create a fallback partition', () => {
  const f=setup()
  try {
    f.make().remember(locator)
    fs.writeFileSync(f.context,'refreshed-validity-tested-by-real-HTTP-model-fixture')
    const refreshed=f.make(issue({contextHash:'hash-b',consumerToolUseId:'waiter'}))
    assert.deepEqual(refreshed.lookup(locator.jobId),locator)
    assert.equal(f.make(issue({turnKey:'new-turn'})).lookup(locator.jobId),undefined)
    assert.equal(fs.readdirSync(f.root).length,1)
    assert.throws(()=>f.make('no-signed-partition'),/partition/)
    assert.throws(()=>refreshed.remember({...locator,receiptNonce:'b'.repeat(64)}),/conflicting/)
    assert.deepEqual(refreshed.lookup(locator.jobId),locator)
  }finally{f.close()}
})

test('actual concurrent processes publish one complete candidate, idempotently, with no partial final files', async () => {
  const f=setup(),cap=issue()
  try {
    const source=new URL('../receiptCliTransport.ts',import.meta.url).pathname
    const env={PATH:process.env.PATH!,HOME:f.home,OPENCLAUDE_DELEGATE_CONTEXT_FILE:f.context,
      [RECEIPT_CAP_ENV]:cap,[RECEIPT_CACHE_ENV]:f.root,[RECEIPT_REPORT_ENV]:join(f.home,'unused')}
    await Promise.all(Array.from({length:6},()=>new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
        `import {ReceiptCliTransport} from ${JSON.stringify(source)}; new ReceiptCliTransport().remember(${JSON.stringify(locator)});`],{env,stdio:['ignore','ignore','pipe']})
      let stderr='';child.stderr.on('data',b=>{stderr+=b})
      const timer=setTimeout(()=>child.kill('SIGKILL'),15000)
      child.once('error',e=>{clearTimeout(timer);reject(e)})
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(stderr||String(code)))})
    })))
    assert.deepEqual(f.make(cap).lookup(locator.jobId),locator)
    assert.deepEqual(fs.readdirSync(join(f.root,partition(cap))),[locator.jobId+'.json'])
    assert.equal(fs.statSync(join(f.root,partition(cap),locator.jobId+'.json')).mode&0o777,0o600)
  }finally{f.close()}
})

test('lookup rejects symlink, FIFO, directory, oversized, public and wrong-job entries without traversing or blocking', () => {
  const f=setup(),cap=issue()
  try {
    const t=f.make(cap);t.remember(locator)
    const file=join(f.root,partition(cap),locator.jobId+'.json'), outside=join(f.home,'outside')
    fs.writeFileSync(outside,JSON.stringify(locator),{mode:0o600});fs.unlinkSync(file)
    fs.symlinkSync(outside,file);assert.throws(()=>t.lookup(locator.jobId));assert.throws(()=>t.remember(locator));fs.unlinkSync(file)
    assert.equal(fs.readFileSync(outside,'utf8'),JSON.stringify(locator))
    assert.equal(spawnSync('mkfifo',[file]).status,0);assert.throws(()=>t.lookup(locator.jobId),/invalid receipt cache record/);fs.unlinkSync(file)
    fs.mkdirSync(file);assert.throws(()=>t.lookup(locator.jobId),/invalid receipt cache record/);fs.rmdirSync(file)
    fs.writeFileSync(file,'x'.repeat(4097),{mode:0o600});assert.throws(()=>t.lookup(locator.jobId),/invalid receipt cache record/)
    fs.writeFileSync(file,JSON.stringify({...locator,jobId:'dlgjob-wrong'}));assert.throws(()=>t.lookup(locator.jobId),/job mismatch/)
    fs.writeFileSync(file,JSON.stringify(locator));fs.chmodSync(file,0o644);assert.throws(()=>t.lookup(locator.jobId),/invalid receipt cache record/)
  }finally{f.close()}
})

test('private root and partition are no-follow; path replacement after open cannot redirect publication', () => {
  const f=setup(),cap=issue(),originalOpen=fs.openSync
  try {
    const outside=join(f.home,'outside');fs.mkdirSync(outside,{mode:0o700})
    fs.symlinkSync(outside,f.root);assert.throws(()=>f.make(cap).remember(locator));assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(f.root)
    fs.mkdirSync(f.root,{mode:0o700});fs.symlinkSync(outside,join(f.root,partition(cap)))
    assert.throws(()=>f.make(cap).remember(locator));assert.deepEqual(fs.readdirSync(outside),[]);fs.unlinkSync(join(f.root,partition(cap)))
    fs.chmodSync(f.root,0o755);assert.throws(()=>f.make(cap).remember(locator),/private/);fs.chmodSync(f.root,0o700)
    const saved=join(f.home,'pinned-root');let replaced=false
    fs.openSync=((...args:Parameters<typeof fs.openSync>)=>{
      const fd=originalOpen(...args)
      if(args[0]===f.root&&!replaced){replaced=true;fs.renameSync(f.root,saved);fs.symlinkSync(outside,f.root)}
      return fd
    }) as typeof fs.openSync
    syncBuiltinESMExports()
    f.make(cap).remember(locator)
    assert.ok(replaced);assert.deepEqual(fs.readdirSync(outside),[])
    assert.deepEqual(JSON.parse(fs.readFileSync(join(saved,partition(cap),locator.jobId+'.json'),'utf8')),locator)
    assert.throws(()=>f.make(cap).lookup(locator.jobId))
  }finally{fs.openSync=originalOpen;syncBuiltinESMExports();f.close()}
})
