import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { deriveBoxAgentSession, parseBoxAgentScopeControl } from './boxAgentScope.js'

test('Box control binds derived API identity and rejects arbitrary scope authority fields', () => {
  const rootSessionId = randomUUID()
  const request = {subtype:'box_agent_scope',version:1,operation:'register',scopeId:randomUUID(),
    rootSessionId,sessionId:deriveBoxAgentSession(rootSessionId,'a1'),agentId:'a1',turnKey:'a'.repeat(64),
    parentScopeId:null,background:false,sequence:1}
  assert.deepEqual(parseBoxAgentScopeControl(request),request)
  assert.notEqual(request.sessionId,rootSessionId)
  assert.notEqual(request.sessionId,deriveBoxAgentSession(rootSessionId,'a2'))
  assert.equal(deriveBoxAgentSession(rootSessionId,'a1'),request.sessionId)
  for (const changed of [{sessionId:rootSessionId},{accountId:'1'},{sequence:0},
    {scopeId:'bad'},{background:true,parentScopeId:randomUUID()},{rootSessionId:randomUUID()}]) {
    assert.equal(parseBoxAgentScopeControl({...request,...changed}),null)
  }
})
