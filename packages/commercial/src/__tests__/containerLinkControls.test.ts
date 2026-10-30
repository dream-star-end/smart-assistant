import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { ContainerLinkControls } from '../ws/containerLinkControls.js'
import type { ContainerLinkRegistry } from '../ws/containerLink.js'
import { containerLinkControlDelivered, resetMetricsForTest } from '../admin/metrics.js'

test('PG-selected carrier IDs are claimed once; missing carriers wake without claiming', async () => {
  resetMetricsForTest()
  const pending = new Map([['control-a', 7], ['control-b', 8]])
  const transports = new Map<number, WebSocket>()
  const sent: string[] = []
  const claims: string[][] = []
  const wakes: number[] = []
  const transport = (cid: number) => ({ readyState: WebSocket.OPEN,
    send: (raw: string, _opts: unknown, callback: () => void) => {
      sent.push(`${cid}:${JSON.parse(raw).controlId}`); callback()
    } }) as unknown as WebSocket
  transports.set(7, transport(7))
  const pool = { query: async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT DISTINCT user_id')) return { rows: pending.size ? [{ user_id: '42' }] : [] }
    if (sql.includes('SELECT c.control_id')) return { rows: [...pending].map(([control_id, container_id]) => ({ control_id, container_id })) }
    if (sql.includes('WITH due')) {
      const ids = params[4] as string[]
      claims.push(ids)
      const rows = ids.filter(id => pending.has(id)).map(id => ({
        control_id: id, user_id: '42', session_id: 's', root_client_message_id: 'm', kind: 'stop',
        request_id: null, payload_json: { type: 'inbound.control.stop' }, lease_epoch: '1', delivery_attempt: 1,
      }))
      for (const row of rows) pending.delete(row.control_id)
      return { rows }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  } } as unknown as Pool
  const delivery = new ContainerLinkControls({ pool, channel: 'v5', legacy: new Map(),
    links: { controlTransport: (_uid: bigint, cid: number) => transports.get(cid) ?? null } as unknown as ContainerLinkRegistry,
    wake: async carrier => { wakes.push(carrier.containerId); transports.set(carrier.containerId, transport(carrier.containerId)) },
  })
  try {
    await Promise.all([delivery.scan(), delivery.scan(), delivery.drain(42n)])
    await delivery.scan()
    await delivery.scan()
    assert.deepEqual(wakes, [8])
    assert.deepEqual(claims, [['control-a'], ['control-b']])
    assert.deepEqual(sent, ['7:control-a', '8:control-b'])
    const metrics: string[] = []; containerLinkControlDelivered.render(metrics)
    assert.ok(metrics.includes('container_link_control_delivered_total{via="link"} 2'))
  } finally { await delivery.stop() }
})

test('transport lost after claim releases its exact owner/epoch; failed writes do not count delivery', async () => {
  resetMetricsForTest()
  for (const failSend of [false, true]) {
    let open = true
    const releases: unknown[][] = []
    const pool = { query: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT c.control_id')) return { rows: [{ control_id: 'control-a', container_id: 7 }] }
      if (sql.includes('WITH due')) {
        open = failSend
        return { rows: [{ control_id: 'control-a', user_id: '42', session_id: 's', kind: 'permission', payload_json: {}, lease_epoch: '4', delivery_attempt: 3 }] }
      }
      if (sql.includes("SET status='pending'")) { releases.push(params); return { rowCount: 1 } }
      throw new Error(`unexpected SQL: ${sql}`)
    } } as unknown as Pool
    const socket = { readyState: WebSocket.OPEN, send: (_raw: string, _opts: unknown, cb: (error: Error) => void) => cb(new Error('closed')) } as unknown as WebSocket
    const delivery = new ContainerLinkControls({ pool, channel: 'v5', legacy: new Map(),
      links: { controlTransport: () => open ? socket : null } as unknown as ContainerLinkRegistry,
    })
    try {
      await delivery.drain(42n)
      assert.equal(releases.length, 1)
      assert.equal(releases[0]![0], 'control-a')
      assert.match(String(releases[0]![1]), /^master:/)
      assert.equal(releases[0]![2], 4)
    } finally { await delivery.stop() }
  }
  const metrics: string[] = []; containerLinkControlDelivered.render(metrics)
  assert.ok(!metrics.some(line => line.startsWith('container_link_control_delivered_total{')))
})
