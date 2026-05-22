// Offline unit test for sessionManager parser logic.
// Feeds a recorded CCB stream-json stdout through the SubprocessRunner event path
// and verifies SessionStreamEvent outputs.

import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { SessionManager } from '../openclaude/packages/gateway/src/sessionManager.js'
import type { SessionStreamEvent } from '../openclaude/packages/gateway/src/sessionManager.js'
import type { SdkMessage } from '../openclaude/packages/gateway/src/subprocessRunner.js'

// Minimal mock runner that plays back a recorded JSONL file when submit() is called
class MockRunner extends EventEmitter {
  sessionId: string | null = null
  private lines: string[]
  constructor(jsonlPath: string) {
    super()
    this.lines = readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean)
  }
  async start() {}
  async submit(_text: string) {
    // Play back all recorded lines synchronously
    for (const line of this.lines) {
      try {
        const msg = JSON.parse(line) as SdkMessage
        if (msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id as string
          this.emit('session_id', this.sessionId)
        }
        this.emit('message', msg)
      } catch {}
    }
  }
  async shutdown() {}
}

async function main() {
  const jsonlPath = process.argv[2]
  if (!jsonlPath) {
    console.error('usage: tsx parser_unit_test.ts <path-to-recorded.jsonl>')
    process.exit(1)
  }

  const runner = new MockRunner(jsonlPath)
  // Hijack SessionManager internals for the test
  const sm = new (SessionManager as any)({
    version: 1,
    gateway: { bind: '', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '.' },
    defaults: { model: 'test', permissionMode: 'default' },
    channels: { webchat: { enabled: true } },
  })

  const session: any = {
    sessionKey: 'test',
    agentId: 'main',
    runner,
    ccbSessionId: null,
    lock: Promise.resolve(),
    lastUsedAt: Date.now(),
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,
    toolUseIdToName: new Map<string, string>(),
  }
  runner.on('session_id', (id: string) => {
    session.ccbSessionId = id
  })

  const events: SessionStreamEvent[] = []
  await sm.submit(session, 'unit test', (e: SessionStreamEvent) => {
    events.push(e)
  })

  console.log(`\n── Collected ${events.length} events ──`)
  const textBlocks = events.filter((e) => e.kind === 'block' && (e as any).block.kind === 'text')
  const thinkingBlocks = events.filter(
    (e) => e.kind === 'block' && (e as any).block.kind === 'thinking',
  )
  const toolUseBlocks = events.filter(
    (e) => e.kind === 'block' && (e as any).block.kind === 'tool_use',
  )
  const toolResultBlocks = events.filter(
    (e) => e.kind === 'block' && (e as any).block.kind === 'tool_result',
  )
  const finals = events.filter((e) => e.kind === 'final')
  const errors = events.filter((e) => e.kind === 'error')

  const textJoined = textBlocks.map((e) => (e as any).block.text).join('')
  const thinkingJoined = thinkingBlocks.map((e) => (e as any).block.text).join('')

  console.log(`  text blocks: ${textBlocks.length}, joined: ${JSON.stringify(textJoined)}`)
  console.log(
    `  thinking blocks: ${thinkingBlocks.length}, joined: ${JSON.stringify(thinkingJoined.slice(0, 100))}`,
  )
  console.log(`  tool_use blocks: ${toolUseBlocks.length}`)
  for (const b of toolUseBlocks) console.log(`    - ${(b as any).block.toolName}: ${(b as any).block.inputPreview?.slice(0, 60)}`)
  console.log(`  tool_result blocks: ${toolResultBlocks.length}`)
  for (const b of toolResultBlocks)
    console.log(`    - ${(b as any).block.toolName}: ${(b as any).block.preview?.slice(0, 60)}`)
  console.log(`  final events: ${finals.length}`)
  for (const f of finals) console.log(`    meta: ${JSON.stringify((f as any).meta)}`)
  console.log(`  error events: ${errors.length}`)
  for (const e of errors) console.log(`    - ${(e as any).error}`)

  // Assertions
  const ok = (b: boolean, label: string) => {
    console.log(`  ${b ? '✓' : '✗'} ${label}`)
    return b
  }
  console.log(`\n── Assertions ──`)
  let pass = true
  pass = ok(textBlocks.length > 0, 'text_delta blocks were emitted') && pass
  pass = ok(textJoined.length > 0, 'joined text is non-empty') && pass
  pass = ok(finals.length === 1, 'exactly one final event') && pass
  if (finals.length > 0) {
    const meta = (finals[0] as any).meta
    pass = ok(meta != null, 'final has meta') && pass
    pass = ok(typeof meta?.cost === 'number' && meta.cost > 0, 'meta.cost > 0') && pass
    pass = ok(typeof meta?.inputTokens === 'number', 'meta.inputTokens set') && pass
    pass = ok(typeof meta?.outputTokens === 'number', 'meta.outputTokens set') && pass
  }
  pass = ok(errors.length === 0, 'no error events') && pass

  console.log(`\n${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

main()
