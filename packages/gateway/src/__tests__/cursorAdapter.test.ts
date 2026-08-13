import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CursorAdapter } from '../engine/cursorAdapter.js'
import type { EngineEvent, EngineExternalBillingEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const REQUEST = 'b'.repeat(32)
function opts(cwd: string): EngineCreateOpts { return { sessionKey: 'agent:main:webchat:dm:cursor-test', agentId: 'main', agentBaseDir: cwd, config: { defaults: { model: 'cursor-auto' } } as OpenClaudeConfig, model: 'cursor-auto' } as EngineCreateOpts }

describe('CursorAdapter', () => {
  test('parses official stream-json, reports only supplied usage, and never transports credentials or raw model arguments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-adapter-')); const fake = path.join(dir, 'fake.cjs'); const capture = path.join(dir, 'capture.json'); const sentinel = 'crsr_secret_must_not_leak'
    await writeFile(fake, `#!/usr/bin/env node
const fs=require('node:fs'); fs.writeFileSync(process.env.CAPTURE,JSON.stringify({argv:process.argv.slice(2),key:process.env.CURSOR_API_KEY}))
for(const e of [{type:'system',subtype:'init'},{type:'thinking',text:'think'},{type:'assistant',text:'hello '},{type:'tool_call',tool_call_id:'t1',tool_name:'terminal',input:{command:'pwd'}},{type:'tool_result',tool_call_id:'t1',status:'completed',output:{exit_code:0,stdout:'ok'}},{type:'assistant',text:'done'},{type:'result',usage:{input_tokens:7,output_tokens:3}}]) console.log(JSON.stringify(e))
`); await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN, oldCapture = process.env.CAPTURE, oldSecret = process.env.CURSOR_API_KEY
    process.env.OC_CURSOR_WRAPPER_BIN = fake; process.env.CAPTURE = capture; process.env.CURSOR_API_KEY = sentinel
    try {
      const adapter = new CursorAdapter(opts(dir)); const events: EngineEvent[] = []; const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (e) => billing.push(e)); adapter.on('error', () => {})
      const run = adapter.submitTurn({ input: `do not expose ${sentinel}`, requestId: REQUEST, onEvent: (e) => events.push(e), sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
      await run.submitted; const summary = await run.summary; await adapter.waitForOutputDrain()
      assert.equal(summary?.assistantText, 'hello done'); assert.equal(summary?.thinkingText, 'think'); assert.equal(summary?.tools[0]?.output.includes('ok'), true)
      assert.deepEqual(billing, [{ requestId: REQUEST, engine: 'cursor', status: 'success', durationMs: billing[0]!.durationMs, usage: { input_tokens: 7, output_tokens: 3 } }])
      const launched = JSON.parse(await readFile(capture, 'utf8')); assert.deepEqual(launched.argv.slice(0, 3), ['--mode', 'ask', '--']); assert.equal(launched.argv.includes('--model'), false); assert.equal(launched.argv.includes('--output-format'), false); assert.equal(launched.key, undefined)
      assert.equal(JSON.stringify(events).includes(sentinel), false)
    } finally { if (oldBin === undefined) delete process.env.OC_CURSOR_WRAPPER_BIN; else process.env.OC_CURSOR_WRAPPER_BIN = oldBin; if (oldCapture === undefined) delete process.env.CAPTURE; else process.env.CAPTURE = oldCapture; if (oldSecret === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = oldSecret; await rm(dir, { recursive: true, force: true }) }
  })

  test('missing usage stays absent and auth/quota failures are external unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-error-')); const fake = path.join(dir, 'fake.cjs')
    await writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'error',message:'401 authentication credential unavailable'}));console.log(JSON.stringify({type:'result'}))\n`); await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN; process.env.OC_CURSOR_WRAPPER_BIN = fake
    try { const adapter = new CursorAdapter(opts(dir)); const billing: EngineExternalBillingEvent[] = []; const events: EngineEvent[] = []; adapter.on('external_billing', (e) => billing.push(e)); adapter.on('error', () => {}); const run = adapter.submitTurn({ input:'x', requestId:REQUEST, onEvent:(e)=>events.push(e), sessionTotals:{totalCostUSD:0,turns:0}, toolUseIdToName:new Map() }); await run.submitted; await run.summary; await adapter.waitForOutputDrain(); assert.equal(billing[0]?.status,'unavailable'); assert.equal(billing[0]?.terminalCode,'AUTH_UNAVAILABLE'); assert.equal('usage' in billing[0]!,false); assert.equal(events.some((e)=>e.kind==='usage'),false) } finally { if(old===undefined) delete process.env.OC_CURSOR_WRAPPER_BIN; else process.env.OC_CURSOR_WRAPPER_BIN=old; await rm(dir,{recursive:true,force:true}) }
  })

  test('rejects every model except controlled cursor-auto', () => { const adapter = new CursorAdapter(opts('/tmp')); assert.throws(() => adapter.setModel('cursor-auto --force'), /not allowlisted/); assert.throws(() => adapter.setEffortLevel('high'), /does not expose/) })
})
