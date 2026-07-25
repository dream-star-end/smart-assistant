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

function finding(capabilityId: string) {
  return {
    taxonomy: 'usability_friction',
    capabilityId,
    severity: 'medium' as const,
    title: `易用性阻力 · ${capabilityId}`,
    problem: '聚合信号显示现有使用路径存在重复阻力。',
    impact: '可能增加完成任务的步骤。',
    recommendation: `结合匿名聚合信号审查 ${capabilityId}，验证根因后规划最小充分改进。`,
    signalCount: 1,
    evidenceHash: 'b'.repeat(64),
  }
}

describe('AutoDreamOptimizerClient platform finding outbox', () => {
  it('whitelists admission fields when passed a runtime-shaped object with a large prompt', async () => {
    let admissionBody = ''
    const fetcher = (async (url: string, options: { body: string }) => {
      assert.equal(new URL(url).pathname, '/internal/v3/auto-dream/admit')
      admissionBody = options.body
      return response(200, {
        requestId: '9'.repeat(32),
        engineSessionId: 'engine-session',
        routeFrame: { baseUrl: 'https://relay.invalid' },
      })
    }) as any
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      fetcher,
    )
    const runtimeInput = {
      runId: '00000000-0000-4000-8000-000000000000',
      callId: '00000000-0000-4000-8000-000000000000:0',
      agentId: 'main',
      model: 'gpt-5.6-terra',
      phase: 'map',
      prompt: 'x'.repeat(129 * 1024),
    }
    assert.ok(Buffer.byteLength(JSON.stringify(runtimeInput)) > 128 * 1024)

    await client.admit(runtimeInput)

    assert.ok(Buffer.byteLength(admissionBody) < 128 * 1024)
    assert.deepEqual(JSON.parse(admissionBody), {
      runId: runtimeInput.runId,
      callId: runtimeInput.callId,
      agentId: runtimeInput.agentId,
      model: runtimeInput.model,
    })
  })

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

  it('persists independent raw/theme cursors and never replays acknowledged raw batches', async () => {
    const calls: Array<Record<string, unknown>> = []
    let rejectFirstTheme = true
    const fetcher = (async (url: string, options: { body: string }) => {
      const path = new URL(url).pathname
      const body = JSON.parse(options.body) as Record<string, unknown>
      if (path.endsWith('/findings')) {
        calls.push(body)
        if ((body.findings as unknown[]).length > 0 && rejectFirstTheme) {
          rejectFirstTheme = false
          throw new Error('theme outage after raw acknowledgement')
        }
      }
      if (path.endsWith('/admit')) {
        return response(200, {
          requestId: '7'.repeat(32),
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
    const agentId = 'raw-theme-cursors'
    const rawFindings = Array.from({ length: 129 }, (_, index) => finding(`manage.raw.${index}`))
    const findings = Array.from({ length: 129 }, (_, index) => finding(`manage.theme.${index}`))
    await client.reportFindings({
      runId: '00000000-0000-4000-8000-000000000011',
      agentId,
      findings,
      rawFindings,
    })
    const queued = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerFindings(agentId), 'utf8'),
    ) as {
      schemaVersion: number
      pending: Array<{ nextOffset: number; rawNextOffset: number }>
    }
    assert.equal(queued.schemaVersion, 2)
    assert.equal(queued.pending[0]?.nextOffset, 0)
    assert.equal(queued.pending[0]?.rawNextOffset, 129)

    await client.admit({
      runId: '00000000-0000-4000-8000-000000000012',
      callId: '00000000-0000-4000-8000-000000000012:0',
      agentId,
      model: 'gpt-5.6-terra',
    })
    const rawCalls = calls.filter((body) => (body.rawFindings as unknown[]).length > 0)
    const themeCalls = calls.filter((body) => (body.findings as unknown[]).length > 0)
    assert.deepEqual(
      rawCalls.map((body) => (body.rawFindings as unknown[]).length),
      [128, 1],
    )
    assert.deepEqual(
      themeCalls.map((body) => (body.findings as unknown[]).length),
      [128, 128, 1],
    )
    const drained = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerFindings(agentId), 'utf8'),
    ) as { schemaVersion: number; pending: unknown[] }
    assert.equal(drained.schemaVersion, 2)
    assert.deepEqual(drained.pending, [])
  })

  it('migrates a durable v1 theme-only queue before retrying it', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fetcher = (async (url: string, options: { body: string }) => {
      const path = new URL(url).pathname
      const body = JSON.parse(options.body) as Record<string, unknown>
      if (path.endsWith('/findings')) calls.push(body)
      if (path.endsWith('/admit')) {
        return response(200, {
          requestId: '8'.repeat(32),
          engineSessionId: 'engine-session',
          routeFrame: { baseUrl: 'https://relay.invalid' },
        })
      }
      return response(200, { accepted: 1 })
    }) as any
    const agentId = 'legacy-finding-queue'
    const path = paths.agentAutoDreamOptimizerFindings(agentId)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        pending: [
          {
            runId: '00000000-0000-4000-8000-000000000013',
            agentId,
            findings: [finding('manage.legacy')],
            nextOffset: 0,
          },
        ],
      }),
    )
    const client = new AutoDreamOptimizerClient(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      },
      fetcher,
    )
    await client.admit({
      runId: '00000000-0000-4000-8000-000000000014',
      callId: '00000000-0000-4000-8000-000000000014:0',
      agentId,
      model: 'gpt-5.6-terra',
    })
    assert.equal(calls.length, 1)
    assert.equal((calls[0]?.findings as unknown[]).length, 1)
    assert.deepEqual(calls[0]?.rawFindings, [])
    const migrated = JSON.parse(await readFile(path, 'utf8')) as {
      schemaVersion: number
      pending: unknown[]
    }
    assert.deepEqual(migrated, { schemaVersion: 2, pending: [] })
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

  it('serializes concurrent billing journals and retries only the request whose first settlement failed', async () => {
    const failedRequestId = '4'.repeat(32)
    const successfulSettlements = new Map<string, number>()
    const settlementAttempts = new Map<string, number>()
    let failOnce = true
    const fetcher = (async (url: string, options: { body: string }) => {
      assert.equal(new URL(url).pathname, '/internal/v3/auto-dream/settle')
      const billing = JSON.parse(options.body) as { requestId: string }
      settlementAttempts.set(
        billing.requestId,
        (settlementAttempts.get(billing.requestId) ?? 0) + 1,
      )
      if (billing.requestId === failedRequestId && failOnce) {
        failOnce = false
        throw new Error('injected first settlement failure')
      }
      successfulSettlements.set(
        billing.requestId,
        (successfulSettlements.get(billing.requestId) ?? 0) + 1,
      )
      return response(200, { settled: true })
    }) as any
    const env = {
      OPENCLAUDE_V3_MASTER_BASE_URL: 'https://master.invalid',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
    }
    const agentId = 'billing-concurrent'
    const billings = ['2', '3', '4', '5'].map((digit, index) => ({
      requestId: digit.repeat(32),
      engineSessionId: `engine-${index}`,
      status: 'success' as const,
      durationMs: 100,
      usage: { input_tokens: index + 1, output_tokens: 1 },
    }))
    const client = new AutoDreamOptimizerClient(env, fetcher)
    const stages = await Promise.all(
      billings.map(async (billing) => ({
        billing,
        stage: await client.stageBilling(agentId, billing),
      })),
    )
    const firstSettlements = await Promise.allSettled(
      stages.map(({ billing, stage }) => client.settleStaged(agentId, billing, stage)),
    )
    assert.equal(firstSettlements.filter((result) => result.status === 'rejected').length, 1)
    const pending = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerBilling(agentId), 'utf8'),
    ) as { pending: Array<{ requestId: string }> }
    assert.deepEqual(
      pending.pending.map((billing) => billing.requestId),
      [failedRequestId],
    )

    const restarted = new AutoDreamOptimizerClient(env, fetcher)
    await restarted.retryPending(agentId)
    const drained = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerBilling(agentId), 'utf8'),
    ) as { pending: unknown[] }
    assert.deepEqual(drained.pending, [])
    for (const billing of billings) {
      assert.equal(successfulSettlements.get(billing.requestId), 1)
    }
    assert.equal(settlementAttempts.get(failedRequestId), 2)
    for (const billing of billings.filter((row) => row.requestId !== failedRequestId)) {
      assert.equal(settlementAttempts.get(billing.requestId), 1)
    }

    const afterRecoveryCalls = [...settlementAttempts.entries()]
    await restarted.retryPending(agentId)
    assert.deepEqual([...settlementAttempts.entries()], afterRecoveryCalls)
  })
})
