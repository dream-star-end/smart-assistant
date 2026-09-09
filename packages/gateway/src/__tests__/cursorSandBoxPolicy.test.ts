import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { CursorSandBoxResolver, parseCursorSandBoxPolicy, readCursorSandBoxPolicy, CURSOR_SAND_BOX_MAX_POLICY_BYTES } from '../engine/cursorSandBox.js'
const { configurePolicy } = await import(pathToFileURL(resolve('scripts/cursor-sand-box-relay/configure-policy.mts')).href)
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
function fixture(){const root=mkdtempSync(join(tmpdir(),'sand-box-policy-'));const gen='gen-'+ 'a'.repeat(24),dir=join(root,'.pool-generations',gen);mkdirSync(dir,{recursive:true});const machine='abcdefghijklmnopqrstuvwxyz',token='x.'+Buffer.from(JSON.stringify({type:'session',sub:'synthetic-subject',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.y';writeFileSync(join(root,'.pool-active'),gen+'\n');writeFileSync(join(dir,'api-key'),token+'\n');writeFileSync(join(dir,'.credential-kind'),'api-key session '+machine+'\n');writeFileSync(join(dir,'.slot-identities'),'api-key 19 '+hash(token+'\n').slice(0,16)+' 1\n');return {root,dir,token,machine,opts:{authDir:root,accountId:'19',expectedTokenSha256:hash(token),expectedMachineSha256:hash(machine)},close:()=>rmSync(root,{recursive:true,force:true})}}
test('dry run writes nothing; apply contains only bindings and leaves credentials intact',()=>{const f=fixture();try{const before=readFileSync(join(f.dir,'api-key'));assert.equal(configurePolicy(f.opts).wouldChange,true);assert.equal(readdirSync(f.root).includes('.sand-box-policy.json'),false);assert.equal(configurePolicy({...f.opts,apply:true}).changed,true);const file=join(f.root,'.sand-box-policy.json'),text=readFileSync(file,'utf8');for(const secret of [f.token,f.machine,'synthetic-subject'])assert.equal(text.includes(secret),false);assert.equal(statSync(file).mode&0o777,0o600);assert.deepEqual(readFileSync(join(f.dir,'api-key')),before);assert.equal(configurePolicy({...f.opts,apply:true}).changed,false);assert.equal(readdirSync(f.root).some(x=>x.includes('.stage-')),false);}finally{f.close()}})
test('existing other binding preserved and durable backup equals original policy',()=>{const f=fixture();try{const old=JSON.stringify({version:1,accounts:[{accountId:'20',subjectHash:'b'.repeat(64),machineHash:'c'.repeat(64)}]})+'\n';writeFileSync(join(f.root,'.sand-box-policy.json'),old);configurePolicy({...f.opts,apply:true});const result=JSON.parse(readFileSync(join(f.root,'.sand-box-policy.json'),'utf8'));assert.deepEqual(result.accounts.map((a:any)=>a.accountId),['20','19']);const backup=readdirSync(f.root).find(x=>x.includes('.backup-'));assert.ok(backup);assert.equal(readFileSync(join(f.root,backup),'utf8'),old);assert.equal(statSync(join(f.root,backup)).mode&0o777,0o600);}finally{f.close()}})
test('wrong account/token/machine rejected before policy write',()=>{const f=fixture();try{for(const patch of [{accountId:'20'},{expectedTokenSha256:'0'.repeat(64)},{expectedMachineSha256:'0'.repeat(64)}])assert.throws(()=>configurePolicy({...f.opts,...patch,apply:true}));assert.equal(readdirSync(f.root).includes('.sand-box-policy.json'),false);}finally{f.close()}})

test('101 ready bindings pass the actual bounded policy reader and resolve first and last accounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sand-policy-capacity-'))
  const file = join(root, 'policy.json'), machine = 'a'.repeat(32)
  const accounts = Array.from({ length: 101 }, (_, i) => ({
    accountId: String(i + 1), subjectHash: hash(`subject-${i + 1}`), machineHash: hash(machine),
  }))
  try {
    const text = JSON.stringify({ version: 1, accounts })
    assert.ok(Buffer.byteLength(text) > 16 * 1024, 'must exceed the old reader limit')
    writeFileSync(file, text, { mode: 0o600 })
    assert.equal(readCursorSandBoxPolicy(file)!.accounts.length, 101)
    for (const accountId of ['1', '101']) {
      const token = 'x.' + Buffer.from(JSON.stringify({ type: 'session', sub: `subject-${accountId}`, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.y'
      let calls = 0
      const resolver = new CursorSandBoxResolver({ accountId, credentialKind: 'session', readPolicy: () => readCursorSandBoxPolicy(file), fetchImpl: async (url, init) => {
        calls += 1
        assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${token}`)
        return Response.json(url.endsWith('/GetSandBoxRunState') ? { state: 'SAND_BOX_RUN_STATE_RUNNING' }
          : { gatewayUrl: `https://box-${accountId}.cursorvm.com/prefix`, gatewayToken: 'synthetic-gateway', networkToken: 'synthetic-network' })
      } })
      const result = await resolver.resolve(token, machine, new AbortController().signal)
      assert.equal(result!.url, `https://box-${accountId}.cursorvm.com/prefix/sand-stream-relay/aiserver.v1.InferenceService/Stream`)
      assert.equal(calls, 2)
    }
    assert.throws(() => parseCursorSandBoxPolicy({ version: 1, accounts: Array.from({ length: 4097 }, (_, i) => ({ ...accounts[0], accountId: String(i + 1) })) }), /POLICY_INVALID/)
    writeFileSync(file, '{"version":1,"accounts":[]}' + ' '.repeat(CURSOR_SAND_BOX_MAX_POLICY_BYTES + 1))
    assert.throws(() => readCursorSandBoxPolicy(file), /POLICY_UNAVAILABLE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
