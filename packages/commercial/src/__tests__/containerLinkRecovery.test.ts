import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContainerLinkRecovery, type ContainerLinkRecoveryOptions } from '../ws/containerLinkRecovery.js'
import type { Queryable } from '../dispatch/turnDispatchStore.js'
import { containerLinkReconnect, resetMetricsForTest } from '../admin/metrics.js'

const carrier = { uid: '42', containerId: 7 }
const row = { session_id: 's', client_message_id: 'm', agent_id: 'main', dispatch_id: 'd', attempt_no: 1, lease_epoch: '2' }
const pool = { query: async (sql: string) => ({ rows: sql.includes('SELECT DISTINCT') ? [{ user_id: '42', container_id: 7 }] : [row] }) } as unknown as Queryable
const options = (attach: ContainerLinkRecoveryOptions['attach']): ContainerLinkRecoveryOptions => ({ pool, channel: 'v5', attach, drain: async () => {}, retryMs: 1, spacingMs: 1, maxAttempts: 3 })
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!predicate()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

test('startup scans open carriers and restores exact dispatch identity after draining', async () => {
  const calls: string[] = []
  const recovery = new ContainerLinkRecovery({ ...options(async (got, rows) => {
    assert.deepEqual(got, carrier)
    assert.deepEqual(rows, [{ sessionId: 's', clientMessageId: 'm', agentId: 'main', dispatchId: 'd', attemptNo: 1, leaseEpoch: 2 }])
    calls.push('attach'); return 'rebuilt'
  }), drain: async () => { calls.push('drain') } })
  try { await Promise.all([recovery.start(), recovery.start()]); assert.deepEqual(calls, ['drain', 'attach']) }
  finally { recovery.stop(); await recovery.drain() }
})

test('transport flapping has a lifetime retry cap, including successful TCP reconnects', async () => {
  resetMetricsForTest()
  let attempts = 0
  const recovery = new ContainerLinkRecovery(options(async () => {
    attempts++; recovery.lost(42n, 7); return 'rebuilt'
  }))
  try {
    recovery.lost(42n, 7)
    await until(() => {
      const lines: string[] = []; containerLinkReconnect.render(lines)
      return lines.some(line => line.includes('outcome="exhausted"') && line.endsWith(' 1'))
    })
    recovery.lost(42n, 7)
    await recovery.drain()
    assert.equal(attempts, 3)
  } finally { recovery.stop(); await recovery.drain() }
})

test('vanished carrier never retries; closed dispatch never dials', async () => {
  let attempts = 0
  const recovery = new ContainerLinkRecovery(options(async () => { attempts++; return 'vanished' }))
  await recovery.start(); await recovery.drain()
  assert.equal(attempts, 1)
  recovery.stop()
  const closed = new ContainerLinkRecovery({ ...options(async () => { throw new Error('must not dial') }), pool: { query: async () => ({ rows: [] }) } as unknown as Queryable })
  closed.lost(42n, 7); await closed.drain(); closed.stop()
})

test('shutdown fences late startup scan and reconnect dispatch lookup', async () => {
  for (const startup of [true, false]) {
    let release!: () => void
    let queried = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    let attached = false
    const recovery = new ContainerLinkRecovery({ ...options(async () => { attached = true; return 'rebuilt' }),
      pool: { query: async () => { queried = true; await barrier; return { rows: startup ? [{ user_id: '42', container_id: 7 }] : [row] } } } as unknown as Queryable })
    if (startup) void recovery.start(); else recovery.lost(42n, 7)
    await until(() => queried)
    recovery.stop(); release(); await recovery.drain()
    assert.equal(attached, false)
  }
})

test('recovery failures retry serially and stop cancels the pending backoff', async () => {
  let attempts = 0
  const recovery = new ContainerLinkRecovery({ ...options(async () => { attempts++; throw new Error('dial failed') }), retryMs: 1000 })
  await recovery.start()
  recovery.stop(); await recovery.drain()
  assert.equal(attempts, 1)
})
