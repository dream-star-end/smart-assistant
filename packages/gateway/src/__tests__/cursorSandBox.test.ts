import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { CursorSandBoxResolver, parseCursorSandBoxPolicy, cursorSandBoxHeaders, cursorSandBoxTicketError, type CursorSandBoxPolicy } from '../engine/cursorSandBox.js'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const machine='abcdefghijklmnopqrstuvwxyz'
const token=(sub='account-a')=>'x.'+Buffer.from(JSON.stringify({type:'session',sub,exp:2_000_000_000})).toString('base64url')+'.y'
const policy:CursorSandBoxPolicy={version:1,accounts:[{accountId:'19',subjectHash:hash('account-a'),machineHash:hash(machine)}]}
const signal=()=>new AbortController().signal
function fixture(options:{state?:string;status?:number;descriptor?:unknown;accountId?:string;timeout?:boolean}={}){
 const calls:Array<{url:string;init:RequestInit}>=[];let now=1_000_000
 const resolver=new CursorSandBoxResolver({accountId:options.accountId??'19',credentialKind:'session',readPolicy:()=>policy,now:()=>now,controlTimeoutMs:20,fetchImpl:async(url,init)=>{
  calls.push({url,init});
  if(options.status)return new Response('{}',{status:options.status})
  if(options.timeout)return new Response(new ReadableStream({pull(){}}))
  return new Response(JSON.stringify(url.endsWith('GetSandBoxRunState')?{state:options.state??'SAND_BOX_RUN_STATE_RUNNING'}:options.descriptor??{gatewayUrl:'https://box.cursorvm.com/prefix',gatewayToken:'GATE',networkToken:'NET'}))
 }})
 return {resolver,calls,advance:()=>{now+=61_000}}
}
test('policy schema rejects duplicate ids and missing bindings',()=>{
 assert.deepEqual(parseCursorSandBoxPolicy(policy),policy)
 for(const x of [null,{}, {version:1,accounts:[policy.accounts[0],policy.accounts[0]]},{version:1,accounts:[{accountId:'19'}]}])assert.throws(()=>parseCursorSandBoxPolicy(x),/POLICY_INVALID/)
})
test('unlisted account causes zero controls; mismatched subject or machine fails closed',async()=>{
 const off=fixture({accountId:'20'});assert.equal(await off.resolver.resolve(token(),machine,signal()),null);assert.equal(off.calls.length,0)
 const f=fixture();await assert.rejects(f.resolver.resolve(token('account-b'),machine,signal()),/IDENTITY_MISMATCH/);await assert.rejects(f.resolver.resolve(token(),machine+'x',signal()),/IDENTITY_MISMATCH/);assert.equal(f.calls.length,0)
})
test('official account controls, URL prefix, cache, and gateway-only headers',async()=>{
 const f=fixture();const first=await f.resolver.resolve(token(),machine,signal());assert.ok(first);assert.equal(first.url,'https://box.cursorvm.com/prefix/sand-stream-relay/aiserver.v1.InferenceService/Stream');assert.equal(f.calls.length,2)
 assert.equal(f.calls[0].url,'https://api2.cursor.sh/aiserver.v1.GrokBotService/GetSandBoxRunState');for(const c of f.calls){assert.equal(new Headers(c.init.headers).get('authorization'),'Bearer '+token());assert.equal(c.init.redirect,'error')}
 assert.equal(await f.resolver.resolve(token(),machine,signal()),first);assert.equal(f.calls.length,2);f.advance();const second=await f.resolver.resolve(token(),machine,signal());assert.ok(second);assert.equal(f.calls.length,4);f.resolver.invalidate(first);assert.equal(await f.resolver.resolve(token(),machine,signal()),second);assert.equal(f.calls.length,4);f.resolver.invalidate(second);await f.resolver.resolve(token(),machine,signal());assert.equal(f.calls.length,6)
 const h=cursorSandBoxHeaders(first,{authorization:'ACCOUNT',cookie:'PRIVATE','x-cursor-checksum':'PRIVATE','content-type':'application/connect+proto'});assert.equal(h.authorization,'Bearer GATE');assert.equal(h['x-anyrun-network-token'],'NET');assert.equal(h.cookie,undefined);assert.equal(h['x-cursor-checksum'],undefined)
})
test('ABSENT never calls Ensure and controls auth retains account-error classification',async()=>{
 const absent=fixture({state:'SAND_BOX_RUN_STATE_ABSENT'});await assert.rejects(absent.resolver.resolve(token(),machine,signal()),/BOX_NOT_RUNNING/);assert.equal(absent.calls.length,1)
 const bad=fixture({status:401});await assert.rejects(bad.resolver.resolve(token(),machine,signal()),/CURSOR_SAND_AUTH_BOX_CONTROL_401/);assert.equal(bad.calls.length,1)
})
test('unsafe descriptor URLs and stalled control body are rejected',async()=>{
 for(const url of ['http://box.cursorvm.com','https://evil.example','https://box.cursorvm.com.evil.example','https://box.cursorvm.com/?secret=x']){const f=fixture({descriptor:{gatewayUrl:url,gatewayToken:'GATE',networkToken:'NET'}});await assert.rejects(f.resolver.resolve(token(),machine,signal()),/DESCRIPTOR_INVALID/)}
 const f=fixture({timeout:true});await assert.rejects(f.resolver.resolve(token(),machine,signal()),/BOX_CANCELLED/);assert.equal(f.calls.length,1)
})
test('Box inference ticket errors are nonretryable, real quota remains distinct',()=>{
 assert.match(cursorSandBoxTicketError('unauthenticated: ERROR_NOT_LOGGED_IN')??'',/BOX_INFERENCE_TICKET_REJECTED.*non-retryable/)
 assert.equal(cursorSandBoxTicketError('quota exceeded 429'),null)
})
