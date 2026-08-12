import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

import type { MediaJobRow } from '../media-generation/store.js'
import { MediaWorkerClient } from '../media-generation/workerClient.js'

test('worker cancel bypasses the global proxy and sends the resource class', async () => {
  const job = {
    id: 'direct-egress-job',
    attemptId: 'direct-egress-attempt',
    fenceVersion: 1,
    resourceClass: 'gpu-h3',
  } as MediaJobRow
  let resolveRequest!: (value: { url: string; method: string; body: string }) => void
  const received = new Promise<{ url: string; method: string; body: string }>((resolve) => {
    resolveRequest = resolve
  })
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      resolveRequest({
        url: req.url ?? '',
        method: req.method ?? '',
        body: Buffer.concat(chunks).toString(),
      })
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          job_id: job.id,
          attempt_id: job.attemptId,
          fence_version: job.fenceVersion,
          origin_release: 'test-release',
          resource_class: job.resourceClass,
          status: 'canceled',
          phase: 'canceled',
          request_digest: null,
          current_step: null,
          total_steps: null,
          result_sha256: null,
          result_size: null,
          error_code: null,
          error_message: null,
          recovery_disposition: 'unknown',
          cleanup_proven: 0,
          result_ready: false,
        }),
      )
    })
  })
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve))
  const address = worker.address()
  assert.ok(address && typeof address === 'object')
  const previousDispatcher = getGlobalDispatcher()
  const proxyTrap = new MockAgent()
  proxyTrap.disableNetConnect()
  setGlobalDispatcher(proxyTrap)
  try {
    const client = new MediaWorkerClient(
      `http://127.0.0.1:${address.port}`,
      'test-worker-token-that-is-long-enough',
    )
    const status = await client.cancel(job)
    assert.equal(status.status, 'canceled')
    assert.deepEqual(await received, {
      url: '/v1/attempts/direct-egress-job/direct-egress-attempt/cancel',
      method: 'POST',
      body: JSON.stringify({ resource_class: 'gpu-h3' }),
    })
  } finally {
    setGlobalDispatcher(previousDispatcher)
    await proxyTrap.close()
    worker.closeAllConnections()
    await new Promise<void>((resolve) => worker.close(() => resolve()))
  }
})
