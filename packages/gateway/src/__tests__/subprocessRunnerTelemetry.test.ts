/**
 * Tests the subprocessRunner → telemetry-channel split: `_oc_telemetry`
 * lines must be routed to the 'telemetry' listener (never 'message'), and
 * lines missing `session_id` must be silently dropped (drop + count).
 *
 * The real runner spawns a child process; we exercise the stdout-processing
 * pipeline by directly calling the private `_processStdoutChunk` method via
 * a subclass, so we don't need a live subprocess.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/subprocessRunnerTelemetry.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SubprocessRunner } from '../subprocessRunner.js'

// Access private _processStdoutChunk by bracket notation. We use a fresh
// instance with a minimal opts bag; no subprocess is ever spawned.
function createRunner(): SubprocessRunner {
  return new SubprocessRunner({
    sessionKey: 'test',
    agentId: 'test',
    cwd: '/tmp',
    config: {} as any,
  } as any)
}

function feed(runner: SubprocessRunner, line: string): void {
  // chunk must include a newline to be flushed. The private `handleStdout`
  // takes a string (the child is spawned with encoding 'utf8').
  const chunk = line.endsWith('\n') ? line : line + '\n'
  ;(runner as any).handleStdout(chunk)
}

describe('SubprocessRunner._oc_telemetry routing', () => {
  it('routes _oc_telemetry line with valid session_id to telemetry listener, not message', () => {
    const runner = createRunner()
    const telemetryEvents: any[] = []
    const messages: any[] = []
    runner.on('telemetry', ev => telemetryEvents.push(ev))
    runner.on('message', m => messages.push(m))

    const payload = {
      type: '_oc_telemetry',
      schemaVersion: 1,
      event: 'turn.willCallApi',
      session_id: 'sess-abc',
      data: { model: 'opus' },
      ts: 1,
    }
    feed(runner, JSON.stringify(payload))

    assert.equal(telemetryEvents.length, 1)
    assert.equal(telemetryEvents[0].event, 'turn.willCallApi')
    assert.equal(telemetryEvents[0].session_id, 'sess-abc')
    // Must NOT be forwarded as a normal SDK message — parser would choke.
    assert.equal(messages.length, 0)
  })

  it('normal (non-telemetry) message still flows to message listener', () => {
    const runner = createRunner()
    const telemetryEvents: any[] = []
    const messages: any[] = []
    runner.on('telemetry', ev => telemetryEvents.push(ev))
    runner.on('message', m => messages.push(m))

    feed(
      runner,
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        message: { role: 'assistant', content: [] },
      }),
    )

    assert.equal(telemetryEvents.length, 0)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, 'assistant')
  })

  it('_oc_telemetry with missing session_id is silently dropped and counted', () => {
    const runner = createRunner()
    const telemetryEvents: any[] = []
    const messages: any[] = []
    const parseErrors: any[] = []
    runner.on('telemetry', ev => telemetryEvents.push(ev))
    runner.on('message', m => messages.push(m))
    runner.on('parse_error', e => parseErrors.push(e))

    feed(
      runner,
      JSON.stringify({
        type: '_oc_telemetry',
        schemaVersion: 1,
        event: 'turn.willCallApi',
        // no session_id
        data: {},
        ts: 1,
      }),
    )

    // Not emitted anywhere, not counted as parse_error
    assert.equal(telemetryEvents.length, 0)
    assert.equal(messages.length, 0)
    assert.equal(parseErrors.length, 0)
    assert.equal(runner.getTelemetryDiagnostics().missingSessionIdCount, 1)
  })

  it('_oc_telemetry with empty-string session_id is also dropped', () => {
    const runner = createRunner()
    const telemetryEvents: any[] = []
    runner.on('telemetry', ev => telemetryEvents.push(ev))

    feed(
      runner,
      JSON.stringify({
        type: '_oc_telemetry',
        schemaVersion: 1,
        event: 'turn.skipped',
        session_id: '',
        data: {},
        ts: 1,
      }),
    )

    assert.equal(telemetryEvents.length, 0)
    assert.equal(runner.getTelemetryDiagnostics().missingSessionIdCount, 1)
  })

  it('_oc_telemetry does NOT update currentSessionId', () => {
    const runner = createRunner()
    const sessionIdChanges: string[] = []
    runner.on('session_id', id => sessionIdChanges.push(id))

    // First establish a session via a normal message
    feed(
      runner,
      JSON.stringify({ type: 'system', session_id: 'real-sess' }),
    )
    assert.deepEqual(sessionIdChanges, ['real-sess'])

    // A telemetry event with a DIFFERENT session_id must NOT trigger session change
    feed(
      runner,
      JSON.stringify({
        type: '_oc_telemetry',
        schemaVersion: 1,
        event: 'turn.willCallApi',
        session_id: 'different-sess',
        data: {},
        ts: 1,
      }),
    )
    assert.deepEqual(sessionIdChanges, ['real-sess'])
  })

  it('malformed JSON line still goes to parse_error (not telemetry)', () => {
    const runner = createRunner()
    const telemetryEvents: any[] = []
    const parseErrors: any[] = []
    runner.on('telemetry', ev => telemetryEvents.push(ev))
    runner.on('parse_error', e => parseErrors.push(e))

    feed(runner, '{ not valid json')

    assert.equal(telemetryEvents.length, 0)
    assert.equal(parseErrors.length, 1)
  })
})
