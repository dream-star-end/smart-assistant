import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { CursorAdapter } from '../engine/cursorAdapter.js'
import type { EngineEvent, EngineExternalBillingEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const REQUEST = 'b'.repeat(32)
function opts(cwd: string, model = 'cursor-auto'): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:cursor-test',
    agentId: 'main',
    agentBaseDir: cwd,
    config: { defaults: { model: 'cursor-auto' } } as OpenClaudeConfig,
    model,
  } as EngineCreateOpts
}
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

describe('CursorAdapter', () => {
  test('parses pinned official stream-json without duplicating the final assistant flush', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-adapter-'))
    const fake = path.join(dir, 'fake.cjs')
    const capture = path.join(dir, 'capture.json')
    const sentinel = 'crsr_secret_must_not_leak'
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs=require('node:fs'); fs.writeFileSync(process.env.CAPTURE,JSON.stringify({argv:process.argv.slice(2),key:process.env.CURSOR_API_KEY}))
for(const e of [
  {type:'system',subtype:'init',apiKeySource:'env',model:'Auto'},
  {type:'thinking',subtype:'delta',text:'think'},
  {type:'thinking',subtype:'completed'},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'CURSOR'}]},timestamp_ms:1},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'_'}]},timestamp_ms:2},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]},timestamp_ms:3},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'CURSOR_OK'}]}},
  {type:'result',subtype:'success',is_error:false,result:'CURSOR_OK',usage:{inputTokens:10,outputTokens:4,cacheReadTokens:3,cacheWriteTokens:2}},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldCapture = process.env.CAPTURE
    const oldSecret = process.env.CURSOR_API_KEY
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    process.env.CAPTURE = capture
    process.env.CURSOR_API_KEY = sentinel
    try {
      const adapter = new CursorAdapter(opts(dir))
      const events: EngineEvent[] = []
      const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (event) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: `do not expose ${sentinel}`,
        requestId: REQUEST,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.assistantText, 'CURSOR_OK')
      assert.equal(summary?.thinkingText, 'think')
      assert.deepEqual(billing, [
        {
          requestId: REQUEST,
          engine: 'cursor',
          status: 'success',
          durationMs: billing[0]!.durationMs,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      ])
      const text = events
        .filter(
          (event): event is Extract<EngineEvent, { kind: 'block' }> =>
            event.kind === 'block' && event.block.kind === 'text',
        )
        .map((event) => (event.block.kind === 'text' ? event.block.text : ''))
        .join('')
      assert.equal(text, 'CURSOR_OK')
      const launched = JSON.parse(await readFile(capture, 'utf8'))
      assert.deepEqual(launched.argv.slice(0, 3), ['--mode', 'ask', '--'])
      assert.equal(launched.argv.includes('--model'), false)
      assert.equal(launched.argv.includes('--output-format'), false)
      assert.equal(launched.key, undefined)
      assert.equal(JSON.stringify(events).includes(sentinel), false)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('CAPTURE', oldCapture)
      restoreEnv('CURSOR_API_KEY', oldSecret)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('suppresses timestamped aggregate flushes before retry and interaction_query', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-boundary-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
for(const e of [
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'A'}]},timestamp_ms:1},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'A'}]},timestamp_ms:2},
  {type:'retry',subtype:'rate_limit',timestamp_ms:3},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'B'}]},timestamp_ms:4},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'B'}]},timestamp_ms:5},
  {type:'interaction_query',subtype:'request',query_type:'ask_question',timestamp_ms:6},
  {type:'interaction_query',subtype:'response',query_type:'ask_question',timestamp_ms:7},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'C'}]},timestamp_ms:8},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'C'}]}},
  {type:'result',subtype:'success',is_error:false},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.assistantText, 'ABC')
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('parses pinned official tool_call started/completed, including completion-only calls', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-tool-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
for(const e of [
  {type:'tool_call',subtype:'started',call_id:'t1',tool_call:{tool:{case:'shellToolCall'},command:'pwd'}},
  {type:'tool_call',subtype:'completed',call_id:'t1',tool_call:{tool:{case:'shellToolCall'},result:{case:'success'},stdout:'ok'}},
  {type:'tool_call',subtype:'completed',call_id:'t2',tool_call:{tool:{case:'readToolCall'},result:{case:'failure'},error:'missing'}},
  {type:'result',subtype:'success',is_error:false},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.tools.length, 2)
      assert.equal(summary?.tools[0]?.toolUseId, 't1')
      assert.equal(summary?.tools[0]?.toolName, 'shellToolCall')
      assert.equal(summary?.tools[0]?.completed, true)
      assert.equal(summary?.tools[0]?.isError, false)
      assert.equal(summary?.tools[1]?.toolUseId, 't2')
      assert.equal(summary?.tools[1]?.toolName, 'readToolCall')
      assert.equal(summary?.tools[1]?.completed, true)
      assert.equal(summary?.tools[1]?.isError, true)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('missing usage stays absent and auth/quota failures are external unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-error-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
console.log(JSON.stringify({type:'error',message:'401 authentication credential unavailable'}))
console.log(JSON.stringify({type:'result',subtype:'error',is_error:true}))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      const billing: EngineExternalBillingEvent[] = []
      const events: EngineEvent[] = []
      adapter.on('external_billing', (event) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(billing[0]?.status, 'unavailable')
      assert.equal(billing[0]?.terminalCode, 'AUTH_UNAVAILABLE')
      assert.equal('usage' in billing[0]!, false)
      assert.equal(
        events.some((event) => event.kind === 'usage'),
        false,
      )
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('result.is_error cannot produce success external billing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-result-error-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'quota exhausted'}))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (event) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(billing[0]?.status, 'unavailable')
      assert.equal(billing[0]?.terminalCode, 'QUOTA_UNAVAILABLE')
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(
    'Stop interrupts the detached Cursor process group and emits cancelled terminal state',
    { timeout: 5_000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-stop-'))
      const fake = path.join(dir, 'fake.sh')
      const ready = path.join(dir, 'ready')
      await writeFile(
        fake,
        `#!/bin/sh
trap 'exit 130' INT TERM
: > "$READY"
while :; do sleep 1; done
`,
      )
      await chmod(fake, 0o755)
      const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
      const oldReady = process.env.READY
      process.env.OC_CURSOR_WRAPPER_BIN = fake
      process.env.READY = ready
      try {
        const adapter = new CursorAdapter(opts(dir))
        const events: EngineEvent[] = []
        const billing: EngineExternalBillingEvent[] = []
        adapter.on('external_billing', (event) => billing.push(event))
        adapter.on('error', () => {})
        const run = adapter.submitTurn({
          input: 'wait',
          requestId: REQUEST,
          onEvent: (event) => events.push(event),
          sessionTotals: { totalCostUSD: 0, turns: 0 },
          toolUseIdToName: new Map(),
        })
        await run.submitted
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            await stat(ready)
            break
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        await stat(ready)
        assert.equal(adapter.interrupt(), true)
        const summary = await run.summary
        await adapter.waitForOutputDrain()
        assert.equal(summary?.stopReason, 'interrupted')
        assert.equal(billing[0]?.status, 'error')
        assert.equal(billing[0]?.terminalCode, 'USER_CANCELLED')
        assert.equal(
          events.some(
            (event) => event.kind === 'final' && event.meta?.stopReason === 'interrupted',
          ),
          true,
        )
      } finally {
        restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
        restoreEnv('READY', oldReady)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  test('maps every canonical model to its exact controlled CLI argument', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-models-'))
    const fake = path.join(dir, 'fake.cjs')
    const capture = path.join(dir, 'capture.jsonl')
    await writeFile(fake, `#!/usr/bin/env node
const fs=require('node:fs'); fs.appendFileSync(process.env.CAPTURE,JSON.stringify(process.argv.slice(2))+'\\n');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));
`)
    await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldCapture = process.env.CAPTURE
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    process.env.CAPTURE = capture
    const models: Array<[string, string | null]> = [
      ['cursor-auto', null],
      ['cursor-grok-4.6-high', 'cursor-grok-4.6-high'],
      ['cursor-composer-2.5-fast', 'composer-2.5-fast'],
      ['cursor-opus-5-high', 'claude-opus-5-thinking-high'],
      ['cursor-fable-5-high', 'claude-fable-5-thinking-high'],
      ['cursor-grok-4.5-high', 'cursor-grok-4.5-high'],
    ]
    try {
      for (const [model] of models) {
        const adapter = new CursorAdapter(opts(dir, model))
        adapter.on('error', () => {})
        const run = adapter.submitTurn({ input: 'x', requestId: REQUEST, onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
        await run.submitted
        await run.summary
        await adapter.waitForOutputDrain()
      }
      const launched = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
      models.forEach(([, upstream], index) => {
        if (upstream === null) assert.equal(launched[index]!.includes('--model'), false)
        else assert.deepEqual(launched[index]!.slice(0, 2), ['--model', upstream])
      })
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('CAPTURE', oldCapture)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects models outside the controlled allowlist', () => {
    const adapter = new CursorAdapter(opts('/tmp'))
    assert.throws(() => adapter.setModel('cursor-auto --force'), /not allowlisted/)
    assert.throws(() => adapter.setModel('gpt-5.3-codex'), /not allowlisted/)
    assert.throws(() => adapter.setEffortLevel('high'), /does not expose/)
  })
})
