import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {deriveBoxAgentSession} from '@openclaude/protocol'
import {controlBoxAgentScope} from './boxAgentScopeClient.js'

const rootSessionId=randomUUID()
const identity={rootSessionId,scopeId:randomUUID(),agentId:'a1',
  sessionId:deriveBoxAgentSession(rootSessionId,'a1'),turnKey:'a'.repeat(64)}
const env={ANTHROPIC_BASE_URL:'http://172.31.0.1:18892',OPENCLAUDE_V3_MASTER_BASE_URL:'http://172.31.0.1:18892',
  OPENCLAUDE_V3_CONTAINER_TOKEN:'oc-v3.1.synthetic'}

test('scope Stop needs both a committed future fence and positive original-run proof',async () => {
  for(const receipt of [{status:'stopped',fence:'active',proof:'all_physical_runs_terminal'},
    {status:'stopped',fence:'cancelled'}, {status:'stopped',fence:'cancelled',proof:'expired_unproven'}]) {
    await assert.rejects(() => controlBoxAgentScope(identity,'cancel','explicit-stop',{env,
      fetchImpl:async () => new Response(JSON.stringify({scopeId:identity.scopeId,...receipt}))}),/RECEIPT_INVALID/)
  }
  const answer=await controlBoxAgentScope(identity,'cancel','explicit-stop',{env,fetchImpl:async (url,init) => {
    assert.equal(String(url),'http://172.31.0.1:18892/internal/box/agent-scope')
    assert.deepEqual(JSON.parse(String(init?.body)),{...identity,operation:'cancel',reason:'explicit-stop'})
    return new Response(JSON.stringify({scopeId:identity.scopeId,status:'stopped',fence:'cancelled',proof:'prelaunch_cancelled'}))
  }})
  assert.equal(answer.status,'stopped')
})

test('untrusted scope endpoint never receives container credentials; 404 is pending',async () => {
  let sent=0
  await assert.rejects(() => controlBoxAgentScope(identity,'status',undefined,{env:{...env,
    ANTHROPIC_BASE_URL:'https://outside.invalid',OPENCLAUDE_V3_MASTER_BASE_URL:'https://outside.invalid'},
    fetchImpl:async () => {sent++;throw new Error('must not send')}}),/TRANSPORT_INVALID/)
  assert.equal(sent,0)
  await assert.rejects(() => controlBoxAgentScope(identity,'cancel','explicit-stop',{env,
    fetchImpl:async () => new Response('{}',{status:404})}),/CONTROL_PENDING/)
})
