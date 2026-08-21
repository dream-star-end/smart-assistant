import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { type OpenClaudeConfig } from '@openclaude/storage'
import { CursorAdapter } from '../engine/cursorAdapter.js'
import type { EngineEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const REQUEST = 'b'.repeat(32)
const GATEWAY_SECRET = 'gateway_secret_must_only_be_in_token_file'

function opts(cwd: string, model = 'cursor-auto'): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:cursor-boundary-test',
    agentId: 'main',
    agentBaseDir: cwd,
    config: {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: GATEWAY_SECRET },
      auth: { mode: 'api_key', claudeCodePath: cwd },
      defaults: { model: 'cursor-auto', permissionMode: 'default' },
    } as OpenClaudeConfig,
    persona: path.join(cwd, 'persona.md'),
    permissionMode: 'bypassPermissions',
    model,
  } as EngineCreateOpts
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}

function completeAssistant(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function partialAssistant(text: string, timestampMs: number): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp_ms: timestampMs,
  }
}

function fakeStreamScript(events: unknown[]): string {
  return `#!/usr/bin/env node
for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e))
`
}

async function runAssistantEvents(events: unknown[]): Promise<{
  assistantText: string
  segmentText: string
  liveText: string
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-boundary-'))
  const fake = path.join(dir, 'fake.cjs')
  await writeFile(fake, fakeStreamScript([...events, { type: 'result', subtype: 'success', is_error: false }]))
  await chmod(fake, 0o755)
  const old = process.env.OC_CURSOR_WRAPPER_BIN
  process.env.OC_CURSOR_WRAPPER_BIN = fake
  try {
    const adapter = new CursorAdapter(opts(dir))
    adapter.on('error', () => {})
    const live: EngineEvent[] = []
    const run = adapter.submitTurn({
      input: 'x',
      requestId: REQUEST,
      onEvent: (event) => live.push(event),
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await run.submitted
    const summary = await run.summary
    await adapter.waitForOutputDrain()
    const assistantText = summary?.assistantText ?? ''
    const segmentText = (summary?.assistantSegments ?? []).map((s) => s.text).join('')
    const liveText = live
      .filter(
        (event): event is Extract<EngineEvent, { kind: 'block' }> =>
          event.kind === 'block' && event.block.kind === 'text',
      )
      .map((event) => (event.block.kind === 'text' ? event.block.text : ''))
      .join('')
    return { assistantText, segmentText, liveText }
  } finally {
    restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
    await rm(dir, { recursive: true, force: true })
  }
}

describe('CursorAdapter complete-assistant block boundary', () => {
  test('inserts \\n\\n between two complete assistant events when the first has no trailing newline', async () => {
    const out = await runAssistantEvents([completeAssistant('hello'), completeAssistant('world')])
    assert.equal(out.assistantText, 'hello\n\nworld')
    assert.equal(out.segmentText, out.assistantText)
    assert.equal(out.liveText, out.assistantText)
  })

  test('does not insert another separator when existing text already ends with a newline', async () => {
    const out = await runAssistantEvents([completeAssistant('hello\n'), completeAssistant('world')])
    assert.equal(out.assistantText, 'hello\nworld')
    assert.equal(out.segmentText, out.assistantText)
    assert.equal(out.liveText, out.assistantText)
  })

  test('streaming partial deltas concatenate with no inserted characters', async () => {
    const deltas = ['你', '好', '，', '世', '界']
    const events = [
      ...deltas.map((piece, i) => partialAssistant(piece, i + 1)),
      completeAssistant(deltas.join('')),
    ]
    const out = await runAssistantEvents(events)
    assert.equal(out.assistantText, '你好，世界')
    assert.equal(out.assistantText.includes('\n'), false)
    assert.equal(out.segmentText, out.assistantText)
    assert.equal(out.liveText, out.assistantText)
  })

  test('closing fence from a complete event stays on its own line before the next body', async () => {
    const first = '```options\n{"question":"q","options":[{"label":"都不用，收工"}]}\n```'
    const second = '这四条是刚才三个子任务里 typecheck 命令的回执'
    assert.equal(first.endsWith('\n'), false)
    const out = await runAssistantEvents([completeAssistant(first), completeAssistant(second)])
    assert.equal(out.assistantText, `${first}\n\n${second}`)
    assert.equal(out.assistantText.includes('```这四条'), false)
    const closeLine = out.assistantText.split('\n').find((line) => line === '```')
    assert.equal(closeLine, '```')
    assert.equal(out.segmentText, out.assistantText)
    assert.equal(out.liveText, out.assistantText)
  })
})
