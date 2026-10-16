/**
 * OCV5-428 — boot auto-resume must not starve the readiness probe.
 *
 * Incident 2026-10-15 04:14Z: u3 container cold start. `server started` at 04:14:33 but the first
 * /healthz was answered at 04:15:02: bootAutoResume pre-warmed 145 webchat sessions back to back
 * right after listen(), and the master's readiness probe (/healthz + WS upgrade, 200ms poll) could
 * not get a turn. The queued phone message waited the whole time. Each iteration now yields a
 * macrotask first, so I/O callbacks (the probe, the user's WS) run between sessions.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/bootAutoResumeYield.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_TS = join(HERE, '..', 'server.ts')

function bootAutoResumeBody(): string {
  const src = readFileSync(SERVER_TS, 'utf8')
  const start = src.indexOf('private async bootAutoResume(): Promise<void> {')
  assert.ok(start >= 0, 'bootAutoResume not found')
  const end = src.indexOf('\n  }\n', start)
  return src.slice(start, end)
}

describe('bootAutoResume yields between sessions (OCV5-428)', () => {
  it('yields a macrotask at the top of every iteration, before any pre-warm work', () => {
    const body = bootAutoResumeBody()
    const loop = body.indexOf('for (const sessionKey of resumableKeys) {')
    assert.ok(loop >= 0, 'pre-warm loop not found')
    const yieldAt = body.indexOf('await new Promise<void>((resolve) => setImmediate(resolve))', loop)
    const firstWork = body.indexOf('this.sessions.getByKey(sessionKey)', loop)
    assert.ok(yieldAt > loop, 'loop must yield with setImmediate')
    assert.ok(yieldAt < firstWork, 'yield must come before the first per-session work (also covers `continue` paths)')
  })

  it('a probe queued before the loop runs before the first pre-warm (deterministic order)', async () => {
    // setImmediate callbacks run FIFO in the check phase: the probe queued first must run before
    // iteration 0 continues. A microtask-only loop would run it only after all iterations.
    const order: string[] = []
    const probe = new Promise<void>((resolve) => setImmediate(() => { order.push('probe'); resolve() }))
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await Promise.resolve()
      order.push(`s${i}`)
    }
    await probe
    assert.equal(order[0], 'probe')
  })
})
