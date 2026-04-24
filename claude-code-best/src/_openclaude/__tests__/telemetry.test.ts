import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetForTests,
  configureTelemetry,
  emit,
  getDiagnostics,
  type Sink,
} from '../telemetry'

afterEach(() => {
  _resetForTests()
})

describe('emit() gating', () => {
  test('drops when configureTelemetry has not run', () => {
    emit('turn.willCallApi', { model: 'x' })
    // sink=null, so no throw and no counter changes beyond initial zero.
    expect(getDiagnostics().emittedCount).toBe(0)
    expect(getDiagnostics().sinkErrorCount).toBe(0)
    expect(getDiagnostics().configured).toBe(false)
  })

  test('drops when outputFormat is not stream-json', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'json', verbose: true, sink })
    emit('turn.willCallApi', { model: 'x' })
    expect(calls.length).toBe(0)
    expect(getDiagnostics().emittedCount).toBe(0)
  })

  test('drops when verbose is false', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'stream-json', verbose: false, sink })
    emit('turn.willCallApi', { model: 'x' })
    expect(calls.length).toBe(0)
    expect(getDiagnostics().emittedCount).toBe(0)
  })

  test('emits one ndjson line when gates pass', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({
      outputFormat: 'stream-json',
      verbose: true,
      sink,
      sessionIdProvider: () => 'sess-abc',
    })
    emit('turn.willCallApi', { model: 'claude', systemPromptLen: 42 })
    expect(calls.length).toBe(1)
    expect(calls[0]!.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(calls[0]!)
    expect(parsed.type).toBe('_oc_telemetry')
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.event).toBe('turn.willCallApi')
    expect(parsed.session_id).toBe('sess-abc')
    expect(parsed.data.model).toBe('claude')
    expect(parsed.data.systemPromptLen).toBe(42)
    expect(typeof parsed.ts).toBe('number')
    expect(getDiagnostics().emittedCount).toBe(1)
  })
})

describe('size enforcement', () => {
  test('drops events larger than MAX_EVENT_BYTES and increments droppedCount', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink })
    // Each field truncated at 1024B, but with many fields we can exceed 8192B.
    // Use 20 fields of ~900B to exceed cap.
    const big: Record<string, string> = {}
    for (let i = 0; i < 20; i++) big[`k${i}`] = 'a'.repeat(900)
    emit('turn.willCallApi', big)
    expect(calls.length).toBe(0)
    expect(getDiagnostics().droppedCount).toBe(1)
    expect(getDiagnostics().emittedCount).toBe(0)
  })
})

describe('sink failures', () => {
  test('sink throw → sinkErrorCount++ and does not propagate', () => {
    const sink: Sink = () => {
      throw new Error('stdout broken')
    }
    configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink })
    expect(() => emit('turn.willCallApi', {})).not.toThrow()
    expect(getDiagnostics().sinkErrorCount).toBe(1)
    expect(getDiagnostics().emittedCount).toBe(0)
  })
})

describe('sanitizeData', () => {
  test('truncates strings longer than MAX_FIELD_BYTES', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink })
    emit('turn.willCallApi', { secret: 'x'.repeat(5000) })
    expect(calls.length).toBe(1)
    const parsed = JSON.parse(calls[0]!)
    expect(parsed.data.secret.endsWith('…[truncated]')).toBe(true)
    expect(parsed.data.secret.length).toBeLessThan(5000)
  })

  test('truncates arrays longer than MAX_ARRAY_LEN', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink })
    const arr = Array.from({ length: 100 }, (_, i) => i)
    emit('turn.willCallApi', { items: arr })
    const parsed = JSON.parse(calls[0]!)
    expect(parsed.data.items.length).toBe(50)
    expect(parsed.data.items._truncatedFromN).toBe(100)
  })

  test('drops function/symbol values', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink })
    emit('turn.willCallApi', { fn: () => 'nope', sym: Symbol('x'), ok: 1 })
    const parsed = JSON.parse(calls[0]!)
    expect(parsed.data.ok).toBe(1)
    expect(parsed.data.fn).toBeUndefined()
    expect(parsed.data.sym).toBeUndefined()
  })

  test('truncates at depth > 4', () => {
    const calls: string[] = []
    const sink: Sink = (line) => calls.push(line)
    configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink })
    const deep: Record<string, unknown> = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } }
    emit('turn.willCallApi', deep)
    const parsed = JSON.parse(calls[0]!)
    // depth 0:root; 1:a; 2:b; 3:c; 4:d; depth 5 returns '[truncated:depth]'
    expect(parsed.data.a.b.c.d.e).toBe('[truncated:depth]')
  })
})

describe('OC_TELEMETRY_DISABLED killswitch', () => {
  test('is evaluated at module load and disables emits', async () => {
    // The DISABLED const is captured at module import, so we have to re-import
    // the module with a fresh module registry entry to exercise the branch.
    process.env.OC_TELEMETRY_DISABLED = '1'
    const modUrl = `${new URL('../telemetry.ts', import.meta.url).pathname}?killswitch=${Date.now()}`
    const mod: typeof import('../telemetry') = await import(modUrl)
    const calls: string[] = []
    mod.configureTelemetry({ outputFormat: 'stream-json', verbose: true, sink: (l) => calls.push(l) })
    mod.emit('turn.willCallApi', { model: 'x' })
    expect(calls.length).toBe(0)
    delete process.env.OC_TELEMETRY_DISABLED
  })
})
