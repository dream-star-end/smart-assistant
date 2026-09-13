import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReceiptOwnerCapabilities, receiptContextHash } from '../../../gateway/src/receiptOwnerCapability.js'
import { ReceiptConsumerCredentials } from '../receiptConsumerCredentials.js'
import { ReceiptCliTransport, RECEIPT_CAP_ENV, RECEIPT_CACHE_ENV } from '../receiptCliTransport.js'
import { runDelegateWaitLoop } from '../delegateWaitCli.js'
import { DELEGATE_CONTEXT_HEADER, postJsonToGateway } from '../gatewayClient.js'
const owner = { userId: 'default', agentId: 'main', sessionKey: 'session', adapterInstanceId: 'adapter',
  parentOwnerEpoch: 'epoch', turnKey: 'turn', nativeSessionId: 'native', consumerToolUseId: 'creator', toolName: 'Bash',
  parentProcess: { pid: 123, startTicks: '12', bootId: '0'.repeat(36), pidNamespace: 'pid:[123]' } }
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'credential-pair-')), caps = new ReceiptOwnerCapabilities()
  const old = { ...process.env }, context = join(home, 'context'), pending = new Map<string, ServerResponse>()
  let received!: () => void, calls: Array<{path: string; context: string; body: any}> = []
  const server = createServer(async (req, res) => {
    let bytes = ''; for await (const b of req) bytes += b
    const body = JSON.parse(bytes), token = String(req.headers[DELEGATE_CONTEXT_HEADER])
    calls.push({ path: req.url!, context: token, body })
    if (req.url?.endsWith('/refresh')) { pending.set(token, res); received?.(); return }
    if (req.url === '/operation') {
      const claims = caps.verify(body.capability)
      res.statusCode = claims?.contextHash === receiptContextHash(token) ? 200 : 401
      res.end('{}'); return
    }
    // Simulates an ambiguous create transport failure AFTER request arrival.
    req.socket.destroy()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`
  process.env.OPENCLAUDE_GATEWAY_PORT = String((server.address() as {port: number}).port)
  process.env.OPENCLAUDE_GATEWAY_TOKEN = 'local-only'; delete process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE
  process.env.OPENCLAUDE_DELEGATE_CONTEXT_FILE = context
  const set = (s: string) => writeFileSync(context, s)
  set('original')
  const issue = (token: string, patch = {}) => caps.issue({ ...owner, contextHash: receiptContextHash(token), ...patch })
  const original = issue('original')
  const arrive = async (token: string) => { if (!pending.has(token)) await new Promise<void>(r => { received = r }); assert.ok(pending.has(token)) }
  const reply = (token: string, capability = issue(token), status = 200) => { const res = pending.get(token)!; pending.delete(token); res.statusCode = status; res.end(JSON.stringify({ capability, ownerState: 'active' })) }
  return { base, home, caps, original, issue, set, arrive, reply, calls, disconnect(token: string) {pending.get(token)!.destroy();pending.delete(token)}, async close() {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    for (const k of ['OPENCLAUDE_GATEWAY_PORT','OPENCLAUDE_GATEWAY_TOKEN','OPENCLAUDE_GATEWAY_TOKEN_FILE','OPENCLAUDE_DELEGATE_CONTEXT_FILE']) {
      if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]
    }
    rmSync(home, { recursive: true, force: true })
  } }
}

test('concurrent reversed refresh responses preserve each real HTTP operation pair', async () => {
  const f = await fixture()
  try {
    const client = new ReceiptConsumerCredentials(f.original)
    f.set('A'); const a = client.current(); await f.arrive('A')
    f.set('B'); const b = client.current(); await f.arrive('B')
    f.reply('B'); const pairB = await b
    f.reply('A'); const pairA = await a
    for (const pair of [pairB, pairA]) {
      assert.ok(Object.isFrozen(pair) && Object.isFrozen(pair.headers))
      const result = await postJsonToGateway(f.base + '/operation', { headers: pair.headers, body: JSON.stringify({capability:pair.capability}), timeoutMs:5000 })
      assert.equal(result.statusCode, 200)
    }
    // The late cached A still cannot mix with the next B headers.
    const next = client.current(); await f.arrive('B');
    f.reply('B'); const pair = await next
    assert.equal(f.caps.verify(pair.capability)!.contextHash, receiptContextHash('B'))
  } finally { await f.close() }
})

test('refresh rejects altered original identity, wrong context, expiry and refusal without fallback', async () => {
  const f = await fixture()
  try {
    for (const field of ['userId','agentId','sessionKey','adapterInstanceId','parentOwnerEpoch','turnKey','nativeSessionId','consumerToolUseId','toolName','receiptMcpTarget','parentProcess'] as const) {
      const client = new ReceiptConsumerCredentials(f.original); const token = 'changed-' + field
      f.set(token); const p = client.current(); const rejected = assert.rejects(p, /identity mismatch/); await f.arrive(token)
      f.reply(token, f.issue(token, { [field]: field === 'parentProcess' ? {...owner.parentProcess,pid:456} : 'other' })); await rejected
    }
    for (const mode of ['context', 'expiry', 'refused']) {
      const client = new ReceiptConsumerCredentials(f.original); f.set(mode)
      const p = client.current(), rejected = assert.rejects(p, /refresh/); await f.arrive(mode)
      const claims = f.caps.verify(f.original)!
      const expired = f.caps.issue({...claims,contextHash:receiptContextHash(mode)}, Date.now() - (claims.exp-claims.iat) - 1)
      f.reply(mode, mode === 'context' ? f.issue('wrong') : expired, mode === 'refused' ? 409 : 200); await rejected
    }
    assert.ok(f.calls.every(c => c.path.endsWith('/refresh')))
  } finally { await f.close() }
})

test('receipt start refreshes before one nonce/create; refusal sends zero creates and socket failure never resubmits', async () => {
  const f = await fixture()
  try {
    const transport = () => new ReceiptCliTransport({[RECEIPT_CAP_ENV]:f.original,[RECEIPT_CACHE_ENV]:join(f.home,'cache')},()=>{})
    f.set('refused'); const first = transport().start('coding-assistant', {goal:'local-only'})
    const rejected = assert.rejects(first,/refresh rejected/); await f.arrive('refused');f.reply('refused',f.original,409);await rejected
    assert.equal(f.calls.filter(c=>c.path.includes('/agents/')).length,0)
    f.set('allowed'); const second = transport().start('coding-assistant', {goal:'local-only'})
    const failed = assert.rejects(second,/socket hang up|ECONNRESET/);await f.arrive('allowed');f.reply('allowed');await failed
    const creates=f.calls.filter(c=>c.path.includes('/agents/'));assert.equal(creates.length,1)
    const claims=f.caps.verify(creates[0]!.body.receipt.capability)!
    assert.equal(claims.contextHash,receiptContextHash(creates[0]!.context));assert.equal(claims.consumerToolUseId,'creator')
    assert.match(creates[0]!.body.receipt.receiptNonce,/^[a-f0-9]{64}$/)
  } finally { await f.close() }
})


test('receipt wait does not inherit legacy socket retry after either refresh or status transport failure', async () => {
  const f = await fixture()
  try {
    const locator = {jobId:'dlgjob-existing',generation:1,receiptNonce:'a'.repeat(64)}
    for (const refreshing of [false,true]) {
      const t=new ReceiptCliTransport({[RECEIPT_CAP_ENV]:f.original,[RECEIPT_CACHE_ENV]:join(f.home,'cache')},()=>{throw Error('no ACK')})
      f.set(refreshing?'refresh-disconnect':'original');const before=f.calls.length
      const result=runDelegateWaitLoop({jobIds:[locator.jobId],pollWaitMs:1000,waitOnce:(_id,ms)=>t.wait(locator,ms)})
      if(refreshing){await f.arrive('refresh-disconnect');f.disconnect('refresh-disconnect')}
      const r=await result;assert.equal(r.exitCode,2);assert.match(r.stdout,/job retained, do not resubmit/)
      assert.equal(f.calls.length-before,1,'no legacy transient resubmission')
      assert.equal(f.calls.at(-1)!.path,refreshing?'/api/delegate/receipt-owner/refresh':'/api/delegate/receipt-owner/status')
    }
  } finally {await f.close()}
})
