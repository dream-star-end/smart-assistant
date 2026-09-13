import { test, expect } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { getSessionId } from '../../bootstrap/state.js'
import { prepareReceiptToolInvocation, receiptMcpRequest, receiptShellEnvironment } from '../receiptToolInvocation.js'
import { callMCPToolWithUrlElicitationRetry } from '../../services/mcp/client.js'
import { RECEIPT_MCP_META } from '../../../../packages/mcp-memory/src/receiptMcpTransport.js'
import { RECEIPT_CAP_ENV } from '../../../../packages/mcp-memory/src/receiptCliTransport.js'

const name = 'mcp__openclaude-memory__delegate_task'
function assistant(id: string): any { return { type: 'assistant', uuid: randomUUID(), message: { content: [
  { type: 'tool_use', id: 'unrelated-first-block', name: 'Read', input: {} },
  { type: 'tool_use', id, name, input: {} },
] } } }
async function fixture(fn: (config: any) => Promise<void>, wrapped = false) {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-mcp-unit-'))
  const keys = ['OPENCLAUDE_RECEIPT_CALLER_V2','OPENCLAUDE_HOME','OPENCLAUDE_GATEWAY_PORT','OPENCLAUDE_GATEWAY_TOKEN_FILE','OPENCLAUDE_DELEGATE_CONTEXT_FILE']
  const old = keys.map(k => process.env[k])
  const server = createServer(async (req, res) => {
    let data = ''; for await (const b of req) data += b
    const { toolUseId } = JSON.parse(data)
    const claims = { nativeSessionId: getSessionId(), consumerToolUseId: toolUseId, toolName: wrapped ? 'ExecuteExtraTool' : name, ...(wrapped ? {receiptMcpTarget:name} : {}) }
    res.end(JSON.stringify({ capability: Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic-unit' }))
  })
  try {
    await writeFile(join(dir, 'token'), 'synthetic-only'); await writeFile(join(dir, 'context'), 'synthetic-parent')
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    Object.assign(process.env, { OPENCLAUDE_RECEIPT_CALLER_V2: '1', OPENCLAUDE_HOME: dir,
      OPENCLAUDE_GATEWAY_PORT: String((server.address() as any).port), OPENCLAUDE_GATEWAY_TOKEN_FILE: join(dir, 'token'),
      OPENCLAUDE_DELEGATE_CONTEXT_FILE: join(dir, 'context') })
    await fn({ type: 'stdio', command: 'npx', args: ['tsx', fileURLToPath(new URL('../../../../packages/mcp-memory/src/index.ts', import.meta.url))],
      env: { OPENCLAUDE_DELEGATE_CONTEXT_FILE: join(dir, 'context') } })
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()))
    keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i] })
    await rm(dir, { recursive: true, force: true })
  }
}
test('parallel MCP invocations retain actual non-first SDK IDs without shared env or shell identity', async () => {
  await fixture(async config => {
    const before = process.env[RECEIPT_CAP_ENV]
    await Promise.all(['one', 'two'].map(async toolUseId => {
      const call = await prepareReceiptToolInvocation({ toolUseId, assistantMessage: assistant(toolUseId) })
      expect(call).toBeDefined()
      await call!.run(async () => {
        await new Promise(r => setTimeout(r, toolUseId === 'one' ? 10 : 1))
        const meta = receiptMcpRequest('openclaude-memory','delegate_task',toolUseId,config)!.meta
        expect(meta['claudecode/toolUseId']).toBe(toolUseId)
        expect(JSON.parse(Buffer.from(meta[RECEIPT_MCP_META].capability.split('.')[0]!, 'base64url').toString()).consumerToolUseId).toBe(toolUseId)
        expect(receiptShellEnvironment()[RECEIPT_CAP_ENV]).toBeUndefined()
      })
      expect(await call!.input()).toBeUndefined()
    }))
    expect(process.env[RECEIPT_CAP_ENV]).toBe(before)
    expect(receiptMcpRequest('third-party','delegate_task','one',config)).toBeUndefined()
  })
})
test('receipt rejects third-party transport, sibling tool ID, and duplicate candidate results', async () => {
  await fixture(async config => {
    const call = await prepareReceiptToolInvocation({ toolUseId:'one', assistantMessage:assistant('one') })
    await call!.run(async () => {
      expect(() => receiptMcpRequest('third-party','delegate_task','one',config)).toThrow()
      expect(() => receiptMcpRequest('openclaude-memory','delegate_task','two',config)).toThrow()
      expect(() => receiptMcpRequest('openclaude-memory','delegate_task','one',{type:'http'})).toThrow()
      expect(() => receiptMcpRequest('openclaude-memory','delegate_task','one',{...config,args:['tsx','/untrusted.ts']})).toThrow()
      const req = receiptMcpRequest('openclaude-memory','delegate_task','one',config)!
      const meta = {'openclaude/receipt-locator': { jobId:'dlgjob-test',generation:1,receiptNonce:'a'.repeat(64) }}
      req.capture(meta); expect(() => req.capture(meta)).toThrow('composite')
    })
  })
})
test('subagent and disabled caller cannot mint a receipt invocation', async () => {
  await fixture(async () => {
    expect(await prepareReceiptToolInvocation({ toolUseId:'one',assistantMessage:assistant('one'),agentId:'child' })).toBeUndefined()
    delete process.env.OPENCLAUDE_RECEIPT_CALLER_V2
    expect(await prepareReceiptToolInvocation({ toolUseId:'one',assistantMessage:assistant('one') })).toBeUndefined()
  })
})
test('receipt URL elicitation cannot replay a possibly started request', async () => {
  let calls=0,elicitations=0
  const error=new McpError(ErrorCode.UrlElicitationRequired,'uncertain create',{elicitations:[{mode:'url',url:'https://example.invalid',elicitationId:'x',message:'auth'}]})
  await expect(callMCPToolWithUrlElicitationRetry({ client:{} as any,clientConnection:{} as any,tool:'delegate_task',args:{},
    signal:new AbortController().signal,setAppState:()=>{},disableRetries:true,
    handleElicitation:async()=>{elicitations++;return {action:'accept'}},
    callToolFn:async()=>{calls++;throw error},
  })).rejects.toBe(error)
  expect(calls).toBe(1);expect(elicitations).toBe(0)
})

test('deferred native scope keeps outer identity and enforces the parsed inner MCP target',async()=>{
  await fixture(async config=>{
    const message=assistant('outer')
    message.message.content[1].name='ExecuteExtraTool'
    message.message.content[1].input={tool_name:name,params:{goal:'synthetic'}}
    const call=await prepareReceiptToolInvocation({toolUseId:'outer',assistantMessage:message})
    expect(call).toBeDefined()
    await call!.run(async()=>{
      const request=receiptMcpRequest('openclaude-memory','delegate_task','outer',config)!
      const claims=JSON.parse(Buffer.from(request.meta[RECEIPT_MCP_META].capability.split('.')[0]!, 'base64url').toString())
      expect(claims.toolName).toBe('ExecuteExtraTool');expect(claims.consumerToolUseId).toBe('outer');expect(claims.receiptMcpTarget).toBe(name)
      expect(()=>receiptMcpRequest('openclaude-memory','delegate_wait','outer',config)).toThrow()
      expect(receiptShellEnvironment()[RECEIPT_CAP_ENV]).toBeUndefined()
    })
    message.message.content[1].input.tool_name='mcp__untrusted__delegate_task'
    expect(await prepareReceiptToolInvocation({toolUseId:'outer',assistantMessage:message})).toBeUndefined()
  },true)
})
