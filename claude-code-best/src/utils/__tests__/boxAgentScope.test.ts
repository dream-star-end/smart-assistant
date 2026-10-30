import { afterEach, describe, expect, test } from 'bun:test'
import { getSessionId } from '../../bootstrap/state.js'
import { runWithAgentContext, type SubagentContext } from '../agentContext.js'
import { bindBoxAgentControlTransport, boxAgentMetadata, captureBoxAgentOrigin,
  createBoxAgentInvocation, currentBoxAgentInvocation, deriveBoxAgentSession,
  detachBoxAgentInvocation, ensureBoxAgentScope, finishBoxAgentInvocation,
  isBoxApiModel, linkBoxAgentAbort, renewBoxAgentOrigins, scopedBoxDescriptor, withBoxAgentAuxiliaryInvocation,
  scopedBoxHeaders, stopBoxAgentById, type BoxAgentInvocation } from '../boxAgentScope.js'

const BOX = 'box-api-claude-opus-5-5'
const keys = ['CLAUDE_CODE_EXTRA_METADATA', 'ANTHROPIC_CUSTOM_HEADERS', 'OC_MODEL_EXECUTION_DESCRIPTOR'] as const
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const created: BoxAgentInvocation[] = []
function turn(letter: string) {
  process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({oc_turn_key: letter.repeat(64),oc_mode:'chat'})
  process.env.ANTHROPIC_CUSTOM_HEADERS = `x-oc-model-authority: authority-${letter}\nx-oc-turn-lease: lease-${letter}\nx-openclaude-trace-id: trace-${letter}`
  process.env.OC_MODEL_EXECUTION_DESCRIPTOR = `descriptor-${letter}`
}
function scope(id: string, background = false): SubagentContext {
  const invocation = createBoxAgentInvocation(captureBoxAgentOrigin(),id,background)!
  created.push(invocation)
  return {agentType:'subagent',agentId:id,boxInvocation:invocation}
}
afterEach(async () => {
  bindBoxAgentControlTransport(async request => ({scopeId:request.scopeId,sequence:request.sequence,
    status:request.operation === 'register' || request.operation === 'detach' ? 'active' : 'pending'}))
  await Promise.all(created.splice(0).map(item => finishBoxAgentInvocation(item).catch(() => {})))
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

describe('Box Agent invocation boundaries', () => {
  test('real subagents get stable independent API UUIDs; root/teammate/other models retain the root', async () => {
    turn('a')
    const a = scope('agent-a'), b = scope('agent-b')
    const root = getSessionId()
    expect(boxAgentMetadata(BOX)).toBeUndefined()
    const first = runWithAgentContext(a,() => boxAgentMetadata(BOX)!)
    expect(first.sessionId).toBe(deriveBoxAgentSession(root,'agent-a'))
    expect(first.sessionId).not.toBe(root)
    expect(runWithAgentContext(b,() => boxAgentMetadata(BOX)!.sessionId)).not.toBe(first.sessionId)
    expect(runWithAgentContext(a,() => boxAgentMetadata('deepseek-v4-pro')!.sessionId)).toBe(root)
    expect(runWithAgentContext({agentType:'teammate',agentId:'teammate',agentName:'name',teamName:'team',parentSessionId:root},
      () => boxAgentMetadata(BOX))).toBeUndefined()
    expect(() => runWithAgentContext(a,() => boxAgentMetadata(BOX,'different-agent'))).toThrow('BOX_AGENT_CONTEXT_MISMATCH')
    expect(isBoxApiModel(BOX+'[1m]')).toBe(true)
    expect(isBoxApiModel('box-claude-opus-5-5')).toBe(false)
    turn('b')
    const resumed = scope('agent-a',true)
    expect(resumed.boxInvocation!.sessionId).toBe(first.sessionId)
    expect(resumed.boxInvocation!.scopeId).not.toBe(a.boxInvocation!.scopeId)
    expect(resumed.boxInvocation!.origin.turnKey).toBe('b'.repeat(64))
  })

  test('background A freezes metadata/trace/descriptor; only identical authority may renew its lease', async () => {
    turn('a')
    delete process.env.OC_MODEL_EXECUTION_DESCRIPTOR
    const a = scope('background-a',true)
    turn('b')
    renewBoxAgentOrigins({ANTHROPIC_CUSTOM_HEADERS:process.env.ANTHROPIC_CUSTOM_HEADERS!})
    runWithAgentContext(a,() => {
      expect(JSON.parse(boxAgentMetadata(BOX)!.extraMetadata!).oc_turn_key).toBe('a'.repeat(64))
      expect(scopedBoxDescriptor()!.value).toBeUndefined()
      const headers = scopedBoxHeaders({'x-oc-turn-lease':'lease-b','x-openclaude-trace-id':'trace-b',Authorization:'fresh-auth'})
      expect(headers['x-oc-turn-lease']).toBe('lease-a')
      expect(headers['x-openclaude-trace-id']).toBe('trace-a')
      expect(headers.Authorization).toBe('fresh-auth')
    })
    renewBoxAgentOrigins({ANTHROPIC_CUSTOM_HEADERS:'x-oc-model-authority: authority-a\nx-oc-turn-lease: renewed-a\nx-openclaude-trace-id: wrong'})
    runWithAgentContext(a,() => {
      const headers = scopedBoxHeaders({})
      expect(headers['x-oc-turn-lease']).toBe('renewed-a')
      expect(headers['x-openclaude-trace-id']).toBe('trace-a')
      const nested = scope('nested-a')
      expect(nested.boxInvocation!.origin).toBe(a.boxInvocation!.origin)
      expect(nested.boxInvocation!.parentScopeId).toBe(a.boxInvocation!.scopeId)
    })
  })

  test('first paid dispatch waits for registration ACK; missing ACK never permits a request', async () => {
    turn('a')
    const a = scope('ack-agent')
    let acknowledge!: () => void, dispatched = 0
    const ack = new Promise<void>(resolve => {acknowledge=resolve})
    bindBoxAgentControlTransport(async request => {await ack;return {scopeId:request.scopeId,sequence:request.sequence,status:'active'}})
    const request = runWithAgentContext(a,async () => {await ensureBoxAgentScope(BOX+'[2m]');dispatched++})
    await Promise.resolve()
    expect(dispatched).toBe(0)
    acknowledge();await request
    expect(dispatched).toBe(1)
    const b = scope('failed-ack')
    bindBoxAgentControlTransport(async () => {throw new Error('durable persist failed')})
    await expect(runWithAgentContext(b,async () => {await ensureBoxAgentScope(BOX);dispatched++})).rejects.toThrow('durable persist failed')
    expect(dispatched).toBe(1)
  })

  test('detach before first API has no RPC; registered detach is acknowledged before unlink', async () => {
    turn('a')
    const a = scope('detach-agent')
    const calls: string[] = []
    bindBoxAgentControlTransport(async request => {calls.push(request.operation);return {scopeId:request.scopeId,sequence:request.sequence,status:'active'}})
    await detachBoxAgentInvocation(a.boxInvocation)
    expect(calls).toEqual([])
    expect(a.boxInvocation!.background).toBe(true)
    await runWithAgentContext(a,() => ensureBoxAgentScope(BOX))
    expect(calls).toEqual(['register'])
    const b = scope('registered-detach')
    await runWithAgentContext(b,() => ensureBoxAgentScope(BOX))
    let acknowledge!: () => void
    const ack = new Promise<void>(resolve => {acknowledge=resolve})
    bindBoxAgentControlTransport(async request => {await ack;return {scopeId:request.scopeId,sequence:request.sequence,status:'active'}})
    const detached = detachBoxAgentInvocation(b.boxInvocation)
    await Promise.resolve();expect(b.boxInvocation!.background).toBe(false)
    acknowledge();await detached
    expect(b.boxInvocation!.background).toBe(true)
  })

  test('Stop closes delayed first API and a detached background survives parent abort', async () => {
    turn('a')
    const a = scope('late-agent')
    await stopBoxAgentById('late-agent')
    await expect(runWithAgentContext(a,() => ensureBoxAgentScope(BOX))).rejects.toThrow('BOX_AGENT_SCOPE_CLOSED')
    expect(()=>runWithAgentContext(a,()=>scope('late-nested-background',true))).toThrow('BOX_AGENT_SCOPE_CLOSED')
    const background = scope('background',true)
    const parent = new AbortController()
    linkBoxAgentAbort(background.boxInvocation,parent.signal)
    parent.abort()
    expect(background.boxInvocation!.closed).toBe(false)
    expect(runWithAgentContext(background,() => currentBoxAgentInvocation())).toBe(background.boxInvocation)
  })

  test('a cancelled detach ACK cannot unlink a still-foreground invocation',async()=>{
    turn('a')
    const a=scope('detach-stop-race')
    bindBoxAgentControlTransport(async request=>({scopeId:request.scopeId,sequence:request.sequence,status:'active'}))
    await runWithAgentContext(a,()=>ensureBoxAgentScope(BOX))
    bindBoxAgentControlTransport(async request=>({scopeId:request.scopeId,sequence:request.sequence,status:'pending'}))
    await expect(detachBoxAgentInvocation(a.boxInvocation)).rejects.toThrow('BOX_AGENT_SCOPE_NOT_ACTIVE')
    expect(a.boxInvocation!.background).toBe(false)
  })

  test('an actual utility query identity gets an independent auxiliary scope and keeps frozen parent lineage', async () => {
    turn('a')
    const parent=scope('agent-with-utility',true)
    const controls: Array<{operation:string;agentId:string;parentScopeId:string|null}>=[]
    const registered=new Set<string>()
    bindBoxAgentControlTransport(async request=>{
      if(request.operation==='register') {
        if(request.parentScopeId) expect(registered.has(request.parentScopeId)).toBe(true)
        registered.add(request.scopeId)
      }
      controls.push(request);return {
      scopeId:request.scopeId,sequence:request.sequence,status:request.operation==='register'?'active':'pending'}})
    turn('b')
    await runWithAgentContext(parent,()=>withBoxAgentAuxiliaryInvocation('actual-utility-id',new AbortController().signal,async()=>{
      await ensureBoxAgentScope(BOX,'actual-utility-id')
      const metadata=boxAgentMetadata(BOX,'actual-utility-id')!
      expect(metadata.sessionId).not.toBe(parent.boxInvocation!.sessionId)
      expect(JSON.parse(metadata.extraMetadata!).oc_turn_key).toBe('a'.repeat(64))
      expect(currentBoxAgentInvocation()!.parentScopeId).toBe(parent.boxInvocation!.scopeId)
      expect(boxAgentMetadata('deepseek-v4-pro','actual-utility-id')!.sessionId).toBe(getSessionId())
    }))
    expect(controls.map(item=>[item.operation,item.agentId])).toEqual([
      ['register','agent-with-utility'],['register','actual-utility-id'],['finish','actual-utility-id']])
    expect(parent.boxInvocation!.closed).toBe(false)
  })

  test('lost finish delivery retains closed intent and an explicit Stop reason until a durable control ACK',async()=>{
    turn('a')
    const parent=scope('finish-retry-agent')
    bindBoxAgentControlTransport(async request=>({scopeId:request.scopeId,sequence:request.sequence,status:'active'}))
    await runWithAgentContext(parent,()=>ensureBoxAgentScope(BOX))
    const invocation=parent.boxInvocation!
    bindBoxAgentControlTransport(async()=>{throw new Error('lost terminal control')})
    await expect(stopBoxAgentById(invocation.agentId)).resolves.toBe('pending')
    await expect(finishBoxAgentInvocation(invocation)).rejects.toThrow('lost terminal control')
    expect(invocation.retireRetry).toBeDefined()
    const delivered:string[]=[]
    bindBoxAgentControlTransport(async request=>{delivered.push(request.operation);return {
      scopeId:request.scopeId,sequence:request.sequence,status:'pending'}})
    await finishBoxAgentInvocation(invocation)
    expect(delivered).toEqual(['explicit-stop'])
    expect(invocation.retireRetry).toBeUndefined()
  })
})
