import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-auto-dream-client-'))
process.env.OPENCLAUDE_HOME = testHome

const { paths } = await import('@openclaude/storage')
const { AutoDreamOptimizerClient } = await import('../autoDreamOptimizerClient.js')

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body))
      },
    },
  }
}

describe('AutoDreamOptimizerClient platform finding outbox', () => {
  it('durably resumes acknowledged batches with the same run id before a new admission', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    let rejectFirstFinding = true
    const fetcher = (async (url: string, options: { body: string }) => {
      const path = new URL(url).pathname
      const body = JSON.parse(options.body) as Record<string, unknown>
      calls.push({ path, body })
      if (path.endsWith('/findings') && rejectFirstFinding) {
        rejectFirstFinding = false
        throw new Error('temporary master outage')
      }
      if (path.endsWith('/admit')) {
        return response(200, {
          requestId: 'a'.repeat(32),
          engineSessionId: 'engine-session',
          routeFrame: { baseUrl: 'https://relay.invalid' },
        })
      }
      return response(200, { accepted: 1 })
    }) as any
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      fetcher,
    )
    const finding = {
      taxonomy: 'usability_friction',
      capabilityId: 'manage.skills',
      severity: 'medium' as const,
      title: '易用性阻力 · manage.skills',
      problem: '聚合信号显示现有使用路径存在重复阻力。',
      impact: '可能增加完成任务的步骤。',
      recommendation: '结合匿名聚合信号审查 manage.skills，验证根因后规划最小充分改进。',
      signalCount: 1,
      evidenceHash: 'b'.repeat(64),
    }
    await client.reportFindings({
      runId: '00000000-0000-4000-8000-000000000001',
      agentId: 'main',
      findings: Array.from({ length: 129 }, (_, index) => ({
        ...finding,
        capabilityId: `manage.skills.${index}`,
      })),
    })
    const queued = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerFindings('main'), 'utf8'),
    ) as { pending: Array<{ runId: string; nextOffset: number }> }
    assert.equal(queued.pending[0]?.runId, '00000000-0000-4000-8000-000000000001')
    assert.equal(queued.pending[0]?.nextOffset, 0)

    await client.admit({
      runId: '00000000-0000-4000-8000-000000000002',
      callId: '00000000-0000-4000-8000-000000000002:0',
      agentId: 'main',
      model: 'gpt-5.6-terra',
    })
    const findingCalls = calls.filter((call) => call.path.endsWith('/findings'))
    assert.equal(findingCalls.length, 3)
    assert.equal((findingCalls[1]?.body.findings as unknown[]).length, 128)
    assert.equal((findingCalls[2]?.body.findings as unknown[]).length, 1)
    assert.equal(findingCalls[1]?.body.runId, '00000000-0000-4000-8000-000000000001')
    const drained = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerFindings('main'), 'utf8'),
    ) as { pending: unknown[] }
    assert.deepEqual(drained.pending, [])
  })

  it('settles directly with master when the local billing journal cannot be staged', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(new URL(url).pathname)
      return response(200, { settled: true })
    }) as any
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      fetcher,
    )
    await mkdir(paths.agentAutoDreamOptimizerBilling('billing-fallback'), { recursive: true })
    const stage = await client.stageBilling('billing-fallback', {
      requestId: 'c'.repeat(32),
      engineSessionId: 'engine',
      status: 'success',
      durationMs: 100,
      usage: { input_tokens: 2, output_tokens: 1 },
    })
    assert.equal(stage, 'settled')
    assert.deepEqual(calls, ['/internal/v3/auto-dream/settle'])
  })

  it('retains an uncommitted billing frame in process memory and blocks admission until recovery', async () => {
    const pathsCalled: string[] = []
    let masterAvailable = false
    const fetcher = (async (url: string) => {
      const path = new URL(url).pathname
      pathsCalled.push(path)
      if (path.endsWith('/settle') && !masterAvailable) {
        throw new Error('master unavailable')
      }
      if (path.endsWith('/admit')) {
        return response(200, {
          requestId: 'd'.repeat(32),
          engineSessionId: 'engine-session',
          routeFrame: { baseUrl: 'https://relay.invalid' },
        })
      }
      return response(200, { settled: true })
    }) as any
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      fetcher,
    )
    const agentId = 'billing-memory-recovery'
    const queuePath = paths.agentAutoDreamOptimizerBilling(agentId)
    await mkdir(queuePath, { recursive: true })
    await assert.rejects(
      () =>
        client.stageBilling(agentId, {
          requestId: 'e'.repeat(32),
          engineSessionId: 'engine',
          status: 'success',
          durationMs: 100,
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
      /AUTO_DREAM_BILLING_EVIDENCE_UNCOMMITTED/,
    )
    await assert.rejects(
      () =>
        client.admit({
          runId: '00000000-0000-4000-8000-000000000003',
          callId: '00000000-0000-4000-8000-000000000003:0',
          agentId,
          model: 'gpt-5.6-terra',
        }),
      /AUTO_DREAM_BILLING_RECOVERY_PENDING/,
    )
    assert.equal(
      pathsCalled.some((path) => path.endsWith('/admit')),
      false,
    )

    await rm(queuePath, { recursive: true })
    masterAvailable = true
    await client.admit({
      runId: '00000000-0000-4000-8000-000000000003',
      callId: '00000000-0000-4000-8000-000000000003:0',
      agentId,
      model: 'gpt-5.6-terra',
    })
    assert.equal(pathsCalled.filter((path) => path.endsWith('/settle')).length, 3)
    assert.equal(pathsCalled.filter((path) => path.endsWith('/admit')).length, 1)
    const recovered = JSON.parse(await readFile(queuePath, 'utf8')) as {
      pending: unknown[]
    }
    assert.deepEqual(recovered.pending, [])
  })

  it('serializes timer-style recovery with new billing staging so a stale snapshot cannot erase it', async () => {
    let releaseOldSettlement!: () => void
    let oldSettlementStarted!: () => void
    const oldSettlementEntered = new Promise<void>((resolve) => {
      oldSettlementStarted = resolve
    })
    const oldSettlementRelease = new Promise<void>((resolve) => {
      releaseOldSettlement = resolve
    })
    const fetcher = (async (_url: string, options: { body: string }) => {
      const billing = JSON.parse(options.body) as { requestId?: string }
      if (billing.requestId === 'f'.repeat(32)) {
        oldSettlementStarted()
        await oldSettlementRelease
      }
      return response(200, { settled: true })
    }) as any
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      fetcher,
    )
    const agentId = 'billing-serialized'
    const oldBilling = {
      requestId: 'f'.repeat(32),
      engineSessionId: 'old-engine',
      status: 'success' as const,
      durationMs: 100,
      usage: { input_tokens: 2, output_tokens: 1 },
    }
    const newBilling = {
      requestId: '1'.repeat(32),
      engineSessionId: 'new-engine',
      status: 'success' as const,
      durationMs: 100,
      usage: { input_tokens: 3, output_tokens: 2 },
    }
    assert.equal(await client.stageBilling(agentId, oldBilling), 'durable')
    const recovery = client.retryPending(agentId)
    await oldSettlementEntered
    let newStageFinished = false
    const newStage = client.stageBilling(agentId, newBilling).then((stage) => {
      newStageFinished = true
      return stage
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(newStageFinished, false)

    releaseOldSettlement()
    await recovery
    assert.equal(await newStage, 'durable')
    const queue = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerBilling(agentId), 'utf8'),
    ) as { pending: Array<{ requestId: string }> }
    assert.deepEqual(
      queue.pending.map((billing) => billing.requestId),
      [newBilling.requestId],
    )
  })

  it('fails closed instead of replacing a corrupt durable billing queue with an empty one', async () => {
    const path = paths.agentAutoDreamOptimizerBilling('billing-corrupt')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{not-json')
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      (async () => response(200, {})) as any,
    )
    await assert.rejects(() => client.retryPending('billing-corrupt'), SyntaxError)
    assert.equal(await readFile(path, 'utf8'), '{not-json')
  })
})
