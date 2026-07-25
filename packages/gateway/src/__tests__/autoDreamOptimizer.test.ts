import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-auto-dream-optimizer-'))
process.env.OPENCLAUDE_HOME = testHome

const { AutoDreamOptimizerService, packAutoDreamAuditPages } = await import(
  '../autoDreamOptimizer.js'
)
const { paths } = await import('@openclaude/storage')

const enabledPolicy = {
  enabled: true as const,
  mode: 'optimizer_v2' as const,
  modelId: 'gpt-5.6-terra',
  modelName: 'GPT-5.6 Terra',
  minIntervalHours: 168,
  minNewSessions: 5,
  auditContext: { preferences: {}, installedPlugins: [] },
}

describe('AutoDreamOptimizerService', () => {
  it('reduces all evidence pages in one model run and hydrates final before values authoritatively', async () => {
    const phases: string[] = []
    let finished = 0
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['platform skills and settings', 'session actions and logs'],
        sessionsReviewed: 5,
        throughSeq: 9,
      }),
      runModel: async (input) => {
        assert.equal(input.userId, 'user-42')
        phases.push(input.phase)
        if (input.phase === 'map') {
          assert.match(input.prompt, /platform skills and settings/)
          assert.match(input.prompt, /session actions and logs/)
          return JSON.stringify({
            summary: `mapped ${phases.length}`,
            done: true,
            userProposals: [],
            platformFindings: [],
          })
        }
        if (input.phase === 'reduce_ingest') {
          assert.match(input.prompt, /信号索引分片 1\/1/)
          return JSON.stringify({
            summary: 'ingested maps',
            done: true,
            userProposals: [],
            platformFindings: [],
          })
        }
        assert.match(input.prompt, /2 个证据页/)
        return JSON.stringify({
          summary: 'cross-page synthesis',
          done: true,
          userProposals: [
            {
              category: 'rule',
              action: 'rule.replace',
              title: '综合调整规则',
              reason: '技能与行为证据共同支持',
              targetId: 'agent-persona',
              before: 'model supplied value must be ignored',
              after: 'desired rules',
            },
          ],
          platformFindings: [],
        })
      },
      finishModelRun: async () => {
        finished++
      },
      hydrateProposals: async ({ proposals }) =>
        proposals.map((proposal) => ({
          ...proposal,
          before: 'authoritative current rules',
          beforeFingerprint: 'a'.repeat(64),
        })),
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    })

    const state = await service.run('reduce', 'user-42', true)
    assert.deepEqual(phases, ['map', 'reduce_ingest', 'synthesis'])
    assert.equal(finished, 1)
    assert.equal(state.summary, 'cross-page synthesis')
    assert.equal(state.proposals[0]?.before, 'authoritative current rules')
  })

  it('preserves every map candidate and continues synthesis beyond the per-page schema limit', async () => {
    let mapPage = 0
    let synthesisPage = 0
    const proposals = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        category: 'memory',
        action: 'memory.upsert',
        title: `${prefix}-${index}`,
        reason: 'retained evidence',
        targetId: `memory/${prefix}-${index}.md`,
        before: '',
        after: `${prefix}-${index}`,
      }))
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['page one', 'page two'],
        sessionsReviewed: 5,
        throughSeq: 10,
      }),
      runModel: async ({ phase }) => {
        if (phase === 'map') {
          const prefix = `map-${mapPage++}`
          return JSON.stringify({
            summary: prefix,
            done: true,
            userProposals: proposals(prefix, 64),
            platformFindings: [],
          })
        }
        if (phase === 'reduce_ingest') {
          return JSON.stringify({
            summary: 'ingested',
            done: true,
            userProposals: [],
            platformFindings: [],
          })
        }
        const prefix = `synthesis-${synthesisPage++}`
        return JSON.stringify({
          summary: prefix,
          done: synthesisPage === 2,
          userProposals: proposals(prefix, synthesisPage === 1 ? 64 : 1),
          platformFindings: [],
        })
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
      mapBatchChars: 1,
    })

    const state = await service.run('lossless-pagination', 'user-42', true)
    assert.equal(synthesisPage, 2)
    assert.equal(state.proposals.length, 193)
    assert.equal(
      state.proposals.some((proposal) => proposal.targetId === 'memory/map-0-0.md'),
      true,
    )
    assert.equal(
      state.proposals.some((proposal) => proposal.targetId === 'memory/synthesis-1-0.md'),
      true,
    )
  })

  it('packs arbitrary evidence with reversible JSON framing without truncating oversized pages', () => {
    const pages = [
      '',
      '--- evidence page boundary ---',
      '"quoted"\\nline',
      '\ud800',
      '🙂',
      'x'.repeat(257),
    ]
    const batches = packAutoDreamAuditPages(pages, 64)
    const decoded = batches.flatMap((batch) => {
      const framed = JSON.parse(batch.framedEvidence) as { evidencePages: string[] }
      assert.equal(framed.evidencePages.length, batch.sourcePageCount)
      return framed.evidencePages
    })
    assert.deepEqual(decoded, pages)
    assert.ok(
      batches.some((batch) => batch.framedEvidence.length > 64),
      'an oversized source page must pass through intact instead of being truncated',
    )
  })

  it('losslessly batches a 686-page audit, runs at concurrency four, and reduces map output in source order', async () => {
    const pages = Array.from({ length: 686 }, (_, index) =>
      JSON.stringify({ index, content: `${index}:`.padEnd(2_048, String(index % 10)) }),
    )
    const expectedBatches = packAutoDreamAuditPages(pages)
    assert.ok(expectedBatches.length < 80)
    const decodedByBatch: string[][] = []
    const callIds = new Set<string>()
    const reducePrompts: string[] = []
    let active = 0
    let maxActive = 0
    let releaseFirstWave!: () => void
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve
    })
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages,
        sessionsReviewed: 949,
        throughSeq: 686,
      }),
      runModel: async (input) => {
        assert.equal(callIds.has(input.callId), false)
        callIds.add(input.callId)
        if (input.phase === 'map') {
          const batchIndex = Number(input.callId.split(':').at(-1))
          const framed = JSON.parse(input.prompt.slice(input.prompt.lastIndexOf('\n\n') + 2)) as {
            evidencePages: string[]
          }
          decodedByBatch[batchIndex] = framed.evidencePages
          active++
          maxActive = Math.max(maxActive, active)
          if (maxActive === 4) releaseFirstWave()
          if (batchIndex < 4) await firstWave
          active--
          return JSON.stringify({
            summary: `batch-${batchIndex}`,
            done: true,
            userProposals: [
              {
                category: 'memory',
                action: 'memory.upsert',
                title: `batch-${batchIndex}`,
                reason: 'retained batch signal',
                targetId: `memory/batch-${batchIndex}.md`,
                before: '',
                after: `batch-${batchIndex}`,
              },
            ],
            platformFindings: [],
          })
        }
        if (input.phase === 'reduce_ingest') {
          reducePrompts.push(input.prompt)
          return JSON.stringify({
            summary: 'ingested',
            done: true,
            userProposals: [],
            platformFindings: [],
          })
        }
        return JSON.stringify({
          summary: 'complete',
          done: true,
          userProposals: [],
          platformFindings: [],
        })
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    })

    const state = await service.run('scale-686', 'user-42', true)
    assert.equal(state.status, 'success')
    assert.equal(maxActive, 4)
    assert.deepEqual(decodedByBatch.flat(), pages)
    assert.equal(state.pagesReviewed, 686)
    assert.equal(state.sessionsReviewed, 949)
    assert.equal(state.proposals.length, expectedBatches.length)
    const reduceText = reducePrompts.join('')
    const positions = expectedBatches.map((_, index) =>
      reduceText.indexOf(`"summary":"batch-${index}"`),
    )
    for (let index = 0; index < positions.length; index++) {
      assert.ok(positions[index]! >= 0, `batch ${index} must be present in reduce input`)
      if (index > 0) {
        assert.ok(
          positions[index - 1]! < positions[index]!,
          `batch ${index - 1} must precede batch ${index} in reduce input`,
        )
      }
    }
  })

  it('publishes monotonic live progress and stops scheduling after cancellation while in-flight batches settle', async () => {
    let startedCount = 0
    let active = 0
    let finishedModelRun = false
    const releases: Array<() => void> = []
    let bothStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    const deps: ConstructorParameters<typeof AutoDreamOptimizerService>[0] = {
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['one', 'two', 'three', 'four'],
        sessionsReviewed: 4,
        throughSeq: 4,
      }),
      runModel: async ({ phase }) => {
        assert.equal(phase, 'map')
        active++
        startedCount++
        if (startedCount === 2) bothStarted()
        await new Promise<void>((resolve) => releases.push(resolve))
        active--
        return JSON.stringify({
          summary: `done-${startedCount}`,
          done: true,
          userProposals: [
            {
              category: 'memory',
              action: 'memory.upsert',
              title: `done-${startedCount}`,
              reason: 'completed before cancellation converged',
              targetId: `memory/done-${startedCount}.md`,
              before: '',
              after: 'retained',
            },
          ],
          platformFindings: [],
        })
      },
      finishModelRun: async () => {
        assert.equal(active, 0)
        finishedModelRun = true
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
      mapConcurrency: 2,
      mapBatchChars: 1,
    }
    const service = new AutoDreamOptimizerService(deps)
    const canceller = new AutoDreamOptimizerService(deps)
    const run = service.run('cancel-progress', 'user-42', true)
    await started
    const initial = await service.getPublicState('cancel-progress')
    assert.deepEqual(initial.progress, {
      stage: 'mapping',
      sessionsTotal: 4,
      evidencePagesTotal: 4,
      evidencePagesReviewed: 0,
      mapBatchesTotal: 4,
      mapBatchesCompleted: 0,
      reducePagesTotal: 0,
      reducePagesCompleted: 0,
      synthesisPagesCompleted: 0,
    })

    await canceller.cancel('cancel-progress')
    releases.shift()!()
    while (
      (await service.getPublicState('cancel-progress')).progress?.evidencePagesReviewed !== 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    releases.shift()!()
    const state = await run
    assert.equal(startedCount, 2)
    assert.equal(finishedModelRun, true)
    assert.equal(state.status, 'cancelled')
    assert.equal(state.pagesReviewed, 2)
    assert.equal(state.progress, undefined)
  })

  it('waits for every in-flight model lifecycle before failing and never schedules another batch', async () => {
    let startedCount = 0
    let active = 0
    let failFirst!: () => void
    let releaseOthers!: () => void
    let markAllStarted!: () => void
    const firstFailure = new Promise<void>((resolve) => {
      failFirst = resolve
    })
    const othersRelease = new Promise<void>((resolve) => {
      releaseOthers = resolve
    })
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve
    })
    let cleanupActive = -1
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: Array.from({ length: 8 }, (_, index) => `page-${index}`),
        sessionsReviewed: 8,
        throughSeq: 8,
      }),
      runModel: async ({ callId }) => {
        const index = Number(callId.split(':').at(-1))
        active++
        startedCount++
        if (startedCount === 4) markAllStarted()
        if (index === 0) {
          await firstFailure
          active--
          throw new Error('injected model lifecycle failure')
        }
        await othersRelease
        active--
        return JSON.stringify({
          summary: `settled-${index}`,
          done: true,
          userProposals: [],
          platformFindings: [],
        })
      },
      finishModelRun: async () => {
        cleanupActive = active
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
      mapConcurrency: 4,
      mapBatchChars: 1,
    })

    const run = service.run('failure-settle', 'user-42', true)
    await allStarted
    failFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await service.getPublicState('failure-settle')).status, 'running')
    releaseOthers()
    const state = await run
    assert.equal(state.status, 'failed')
    assert.match(state.error ?? '', /injected model lifecycle failure/)
    assert.equal(startedCount, 4)
    assert.equal(cleanupActive, 0)
    assert.equal(state.progress?.evidencePagesReviewed, 3)
  })

  it('persists each audit stage before entering its model or hydration work', async () => {
    let enterMap!: () => void
    let releaseMap!: () => void
    let enterReduce!: () => void
    let releaseReduce!: () => void
    let enterSynthesis!: () => void
    let releaseSynthesis!: () => void
    let enterHydration!: () => void
    let releaseHydration!: () => void
    const mapEntered = new Promise<void>((resolve) => {
      enterMap = resolve
    })
    const mapRelease = new Promise<void>((resolve) => {
      releaseMap = resolve
    })
    const reduceEntered = new Promise<void>((resolve) => {
      enterReduce = resolve
    })
    const reduceRelease = new Promise<void>((resolve) => {
      releaseReduce = resolve
    })
    const synthesisEntered = new Promise<void>((resolve) => {
      enterSynthesis = resolve
    })
    const synthesisRelease = new Promise<void>((resolve) => {
      releaseSynthesis = resolve
    })
    const hydrationEntered = new Promise<void>((resolve) => {
      enterHydration = resolve
    })
    const hydrationRelease = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['one'],
        sessionsReviewed: 1,
        throughSeq: 1,
      }),
      runModel: async ({ phase }) => {
        if (phase === 'map') {
          enterMap()
          await mapRelease
        } else if (phase === 'reduce_ingest') {
          enterReduce()
          await reduceRelease
        } else {
          enterSynthesis()
          await synthesisRelease
        }
        return JSON.stringify({
          summary: phase,
          done: true,
          userProposals: [],
          platformFindings: [],
        })
      },
      hydrateProposals: async ({ proposals }) => {
        enterHydration()
        await hydrationRelease
        return proposals
      },
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    })

    const run = service.run('progress-stages', 'user-42', true)
    await mapEntered
    assert.equal((await service.getPublicState('progress-stages')).progress?.stage, 'mapping')
    releaseMap()
    await reduceEntered
    assert.equal((await service.getPublicState('progress-stages')).progress?.stage, 'reducing')
    releaseReduce()
    await synthesisEntered
    assert.equal((await service.getPublicState('progress-stages')).progress?.stage, 'synthesizing')
    releaseSynthesis()
    await hydrationEntered
    assert.equal((await service.getPublicState('progress-stages')).progress?.stage, 'finalizing')
    releaseHydration()
    const state = await run
    assert.equal(state.status, 'success')
    assert.equal(state.progress, undefined)
  })

  it('linearizes a cancellation during finalizing before the success commit', async () => {
    let enterHydration!: () => void
    let releaseHydration!: () => void
    const hydrationEntered = new Promise<void>((resolve) => {
      enterHydration = resolve
    })
    const hydrationRelease = new Promise<void>((resolve) => {
      releaseHydration = resolve
    })
    const deps: ConstructorParameters<typeof AutoDreamOptimizerService>[0] = {
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['one'],
        sessionsReviewed: 1,
        throughSeq: 99,
      }),
      runModel: async ({ phase }) =>
        JSON.stringify({
          summary: phase,
          done: true,
          userProposals: [],
          platformFindings: [],
        }),
      hydrateProposals: async ({ proposals }) => {
        enterHydration()
        await hydrationRelease
        return proposals
      },
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    }
    const service = new AutoDreamOptimizerService(deps)
    const canceller = new AutoDreamOptimizerService(deps)

    const run = service.run('cancel-finalizing', 'user-42', true)
    await hydrationEntered
    assert.equal((await service.getPublicState('cancel-finalizing')).progress?.stage, 'finalizing')
    const cancelling = await canceller.cancel('cancel-finalizing')
    assert.ok(cancelling.cancelRequestedAt)
    releaseHydration()
    const state = await run
    assert.equal(state.status, 'cancelled')
    assert.equal(state.pagesReviewed, 1)
    assert.equal(state.sessionsProcessedThroughSeq, undefined)
    assert.equal(state.progress, undefined)
    assert.match(state.summary ?? '', /停止前产生的建议/)
  })

  it('stops a done=false synthesis page with no new signal and preserves earlier paid results', async () => {
    let synthesisCalls = 0
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['one evidence page'],
        sessionsReviewed: 5,
        throughSeq: 11,
      }),
      runModel: async ({ phase }) => {
        if (phase === 'map') {
          return JSON.stringify({
            summary: 'mapped',
            done: true,
            userProposals: [
              {
                category: 'memory',
                action: 'memory.upsert',
                title: 'retained',
                reason: 'evidence',
                targetId: 'memory/retained.md',
                before: '',
                after: 'retained',
              },
            ],
            platformFindings: [],
          })
        }
        if (phase === 'reduce_ingest') {
          return JSON.stringify({
            summary: 'ingested',
            done: true,
            userProposals: [],
            platformFindings: [],
          })
        }
        synthesisCalls++
        return JSON.stringify({
          summary: 'no additional signal',
          done: false,
          userProposals: [],
          platformFindings: [],
        })
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    })

    const state = await service.run('fixed-point', 'user-42', true)
    assert.equal(synthesisCalls, 1)
    assert.equal(state.status, 'success')
    assert.equal(state.proposals.length, 1)
    assert.match(state.summary ?? '', /服务端安全停止并完整保留此前结果/)
  })

  it('lets the user cancel between paid pages and retains completed map output', async () => {
    let modelStarted!: () => void
    let releaseModel!: () => void
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    let modelCalls = 0
    const deps: ConstructorParameters<typeof AutoDreamOptimizerService>[0] = {
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['first page', 'second page'],
        sessionsReviewed: 5,
        throughSeq: 12,
      }),
      runModel: async () => {
        modelCalls++
        modelStarted()
        await release
        return JSON.stringify({
          summary: 'first page complete',
          done: true,
          userProposals: [
            {
              category: 'memory',
              action: 'memory.upsert',
              title: 'completed before cancel',
              reason: 'evidence',
              targetId: 'memory/cancelled.md',
              before: '',
              after: 'retained',
            },
          ],
          platformFindings: [],
        })
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    }
    const service = new AutoDreamOptimizerService(deps)
    const canceller = new AutoDreamOptimizerService({
      ...deps,
      runModel: async () => {
        throw new Error('canceller must not run the model')
      },
    })

    const run = service.run('user-cancel', 'user-42', true)
    await started
    const cancelling = await canceller.cancel('user-cancel')
    assert.equal(cancelling.status, 'running')
    assert.ok(cancelling.cancelRequestedAt)
    releaseModel()
    const state = await run
    assert.equal(modelCalls, 1)
    assert.equal(state.status, 'cancelled')
    assert.equal(state.proposals.length, 1)
    assert.match(state.summary ?? '', /停止前产生的建议/)
  })

  it('converges a persisted cancel request after process restart without starting a new run', async () => {
    const agentId = 'orphaned-cancel'
    const statePath = paths.agentAutoDreamOptimizerState(agentId)
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 2,
        status: 'running',
        runId: '00000000-0000-4000-8000-000000000099',
        startedAt: new Date().toISOString(),
        cancelRequestedAt: new Date().toISOString(),
        sessionsReviewed: 5,
        pagesReviewed: 2,
        proposals: [],
      }),
    )
    let modelCalls = 0
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['must not load'],
        sessionsReviewed: 5,
        throughSeq: 13,
      }),
      runModel: async () => {
        modelCalls++
        throw new Error('must not run')
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    })

    const state = await service.startManual(agentId, 'user-42')
    assert.equal(state.status, 'cancelled')
    assert.equal(state.cancelRequestedAt, undefined)
    assert.equal(modelCalls, 0)
  })

  it('creates proposals without mutation and auto-reports only sanitized platform findings', async () => {
    const reported: unknown[] = []
    let applyCalls = 0
    const finding = {
      taxonomy: 'usability_friction',
      capabilityId: 'manage.skills',
      severity: 'medium',
      title: '技能入口不够明显',
      problem: '用户多次寻找技能设置',
      impact: '完成任务需要更多步骤',
      recommendation: '在管理中心强化入口',
      signalCount: 3,
    }
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['complete retained evidence'],
        sessionsReviewed: 8,
        throughSeq: 12,
      }),
      runModel: async () =>
        JSON.stringify({
          summary: '发现一项用户优化和一项平台优化。',
          done: true,
          userProposals: [
            {
              category: 'memory',
              action: 'memory.upsert',
              title: '补充长期偏好',
              reason: '多个会话中保持一致',
              targetId: 'memory/preference.md',
              before: '',
              after: '偏好简洁回答。',
            },
          ],
          platformFindings: [finding],
        }),
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async (input) => {
        reported.push(input)
      },
      applyProposal: async () => {
        applyCalls++
        return { ok: true }
      },
    })

    const state = await service.run('main', 'user-42', true)
    assert.equal(state.status, 'success')
    assert.equal(state.proposals.length, 1)
    assert.equal(state.proposals[0]?.state, 'pending')
    assert.equal(applyCalls, 0, 'model output must never mutate user state')
    assert.equal(reported.length, 1)
    const report = reported[0] as {
      findings: Array<{ title: string; problem: string; evidenceHash: string }>
    }
    assert.equal(report.findings[0]?.title, '易用性阻力 · manage.skills')
    assert.equal(report.findings[0]?.problem, '聚合信号显示现有使用路径存在重复阻力。')
    assert.match(report.findings[0]?.evidenceHash ?? '', /^[0-9a-f]{64}$/)
  })

  it('derives anonymous admin findings from surfaced platform-owned manual reviews', async () => {
    const reported: Array<{
      findings: Array<{
        taxonomy: string
        capabilityId: string
        title: string
        problem: string
        recommendation: string
        signalCount: number
      }>
    }> = []
    const sensitiveTarget = `platform/alice-medical-condition-${'0123456789abcdef'.repeat(10)}`
    const proposals = [
      ['skill', 'platform/browser-cli-argument-contract'],
      ['agent', 'runtime/session-lifecycle/post-completion-crash'],
      ['setting', 'routing/model-context-cache-policy'],
      ['plugin', 'integration/authorized-social-publishing-and-inbox'],
      ['setting', sensitiveTarget],
      ['skill', 'skill/user-owned-review'],
    ].map(([category, targetId], index) => ({
      category,
      action: 'manual.review',
      title: index === 4 ? 'Alice medical condition' : `platform proposal ${index}`,
      reason: index === 4 ? 'private user evidence' : `reason ${index}`,
      targetId,
      before: '',
      after: '',
    }))
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['production-shaped platform optimization evidence'],
        sessionsReviewed: 204,
        throughSeq: 206,
      }),
      runModel: async (input) =>
        JSON.stringify({
          summary: input.phase === 'synthesis' ? '综合完成。' : '发现平台优化候选。',
          done: true,
          userProposals: input.phase === 'map' ? proposals : [],
          platformFindings: [],
        }),
      hydrateProposals: async ({ proposals: rows }) => rows,
      reportPlatformFindings: async (input) => {
        reported.push(input)
      },
      applyProposal: async () => ({ ok: true }),
    })

    const state = await service.run('derived-admin-findings', 'user-42', true)
    assert.equal(state.status, 'success')
    assert.equal(state.proposals.length, proposals.length)
    assert.equal(reported.length, 1)
    assert.deepEqual(
      reported[0]?.findings.map((finding) => finding.taxonomy),
      ['capability_gap', 'reliability', 'performance', 'plugin_ecosystem', 'capability_gap'],
    )
    assert.equal(reported[0]?.findings.length, 5)
    for (const finding of reported[0]!.findings) {
      assert.match(
        finding.capabilityId,
        /^auto_dream\.(platform|runtime|routing|integration)\.[0-9a-f]{32}$/,
      )
      assert.equal(finding.signalCount, 1)
      const adminCopy = JSON.stringify(finding)
      assert.doesNotMatch(adminCopy, /browser-cli|alice|medical|private user evidence/i)
    }
  })

  it('keeps a map signal raw while surfacing the matching derived theme once', async () => {
    const targetId = 'routing/model-context-cache-policy'
    const capabilityId = `auto_dream.routing.${createHash('sha256')
      .update(targetId)
      .digest('hex')
      .slice(0, 32)}`
    const reported: Array<{
      findings: Array<{ capabilityId: string; signalCount: number }>
      rawFindings: Array<{ capabilityId: string; signalCount: number }>
    }> = []
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['explicit and derived finding evidence'],
        sessionsReviewed: 5,
        throughSeq: 11,
      }),
      runModel: async (input) =>
        JSON.stringify({
          summary: '发现路由性能改进。',
          done: true,
          userProposals:
            input.phase === 'map'
              ? [
                  {
                    category: 'setting',
                    action: 'manual.review',
                    title: '审查上下文缓存',
                    reason: '重复证据支持',
                    targetId,
                    before: '',
                    after: '',
                  },
                ]
              : [],
          platformFindings:
            input.phase === 'map'
              ? [
                  {
                    taxonomy: 'performance',
                    capabilityId,
                    severity: 'medium',
                    signalCount: 7,
                  },
                ]
              : [],
        }),
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async (input) => {
        reported.push(input)
      },
      applyProposal: async () => ({ ok: true }),
    })

    const state = await service.run('explicit-derived-dedupe', 'user-42', true)
    assert.equal(state.status, 'success')
    assert.equal(reported.length, 1)
    assert.equal(reported[0]?.findings.length, 1)
    assert.equal(reported[0]?.findings[0]?.capabilityId, capabilityId)
    assert.equal(reported[0]?.findings[0]?.signalCount, 1)
    assert.equal(reported[0]?.rawFindings.length, 1)
    assert.equal(reported[0]?.rawFindings[0]?.capabilityId, capabilityId)
    assert.equal(reported[0]?.rawFindings[0]?.signalCount, 7)
  })

  it('keeps an unsupported Terra target as guided review and still reports its platform finding', async () => {
    const prompts: Array<{ phase: string; prompt: string }> = []
    const reported: Array<{
      findings: Array<{ capabilityId: string }>
      rawFindings: Array<{ capabilityId: string }>
    }> = []
    let applyCalls = 0
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['production evidence for short response latency'],
        sessionsReviewed: 9,
        throughSeq: 32,
      }),
      runModel: async (input) => {
        prompts.push({ phase: input.phase, prompt: input.prompt })
        if (input.phase === 'map') {
          return JSON.stringify({
            summary: '发现短回复路由优化候选。',
            done: true,
            userProposals: [
              {
                category: 'setting',
                action: 'preference.patch',
                targetId: 'model-routing.short-response',
                title: '短回复场景路由候选',
                reason: '多个短回复场景存在不必要的等待。',
                before: '{"enabled":false}',
                after: '{"enabled":true}',
              },
            ],
            platformFindings: [
              {
                taxonomy: 'performance',
                capabilityId: 'short_response_latency',
                severity: 'medium',
                signalCount: 4,
              },
            ],
          })
        }
        return JSON.stringify({
          summary: input.phase === 'synthesis' ? '综合完成。' : '已纳入。',
          done: true,
          userProposals: [],
          platformFindings: [],
        })
      },
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async (input) => {
        reported.push(input)
      },
      applyProposal: async () => {
        applyCalls++
        return { ok: true }
      },
    })

    const state = await service.run('terra-target-contract', 'user-42', true)
    assert.equal(state.status, 'success')
    assert.equal(state.proposals.length, 1)
    assert.equal(state.proposals[0]?.action, 'manual.review')
    assert.equal(state.proposals[0]?.category, 'setting')
    assert.equal(state.proposals[0]?.targetId, 'model-routing.short-response')
    assert.equal(state.proposals[0]?.title, '短回复场景路由候选')
    assert.equal(state.proposals[0]?.reason, '多个短回复场景存在不必要的等待。')
    assert.equal(state.proposals[0]?.before, '{"enabled":false}')
    assert.equal(state.proposals[0]?.after, '{"enabled":true}')
    assert.equal(reported.length, 1)
    assert.equal(reported[0]?.findings.length, 0)
    assert.equal(reported[0]?.rawFindings[0]?.capabilityId, 'short.response.latency')
    assert.match(
      prompts.find((row) => row.phase === 'map')?.prompt ?? '',
      /preferences\.default_effort.*action=manual\.review/s,
    )
    assert.match(
      prompts.find((row) => row.phase === 'synthesis')?.prompt ?? '',
      /preferences\.default_effort.*action=manual\.review/s,
    )
    await assert.rejects(
      () => service.apply('terra-target-contract', state.proposals[0]!.id),
      /AUTO_DREAM_PROPOSAL_REQUIRES_GUIDED_ACTION/,
    )
    assert.equal(applyCalls, 0)
  })

  it('recovers a prepared local action after mutation-before-receipt crash', async () => {
    let desiredApplied = false
    let calls = 0
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['evidence'],
        sessionsReviewed: 5,
        throughSeq: 20,
      }),
      runModel: async () =>
        JSON.stringify({
          summary: 'one proposal',
          done: true,
          userProposals: [
            {
              category: 'rule',
              action: 'rule.replace',
              title: '更新规则',
              reason: '明确偏好',
              targetId: 'agent-persona',
              before: 'old',
              after: 'new',
            },
          ],
          platformFindings: [],
        }),
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => {
        calls++
        if (!desiredApplied) {
          desiredApplied = true
          throw new Error('simulated crash after mutation')
        }
        return { ok: true, result: 'already applied' }
      },
    })
    const initial = await service.run('recover', 'user-42', true)
    const id = initial.proposals[0]!.id
    await assert.rejects(() => service.apply('recover', id), /simulated crash/)
    const recovered = await service.apply('recover', id)
    assert.equal(calls, 2)
    assert.equal(recovered.proposals[0]?.state, 'applied')
  })

  it('discards model-authored text before automatically reporting a platform finding', async () => {
    const reported: Array<{
      findings: Array<{ problem: string; recommendation: string }>
      rawFindings: Array<{ problem: string; recommendation: string }>
    }> = []
    const service = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['evidence'],
        sessionsReviewed: 5,
        throughSeq: 30,
      }),
      runModel: async () =>
        JSON.stringify({
          summary: 'privacy check',
          done: true,
          userProposals: [],
          platformFindings: [
            {
              taxonomy: 'usability_friction',
              capabilityId: 'settings.navigation',
              severity: 'low',
              title: '入口不明显',
              problem: '联系 alice@example.com 后仍未找到入口',
              impact: '需要额外帮助',
              recommendation: '不要展示 Bearer abcdefghijklmnopqrstuvwxyz',
              signalCount: 1,
            },
          ],
        }),
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async (input) => {
        reported.push(input as any)
      },
      applyProposal: async () => ({ ok: true }),
    })

    await service.run('privacy', 'user-42', true)
    assert.equal(reported[0]?.rawFindings[0]?.problem, '聚合信号显示现有使用路径存在重复阻力。')
    assert.equal(
      reported[0]?.rawFindings[0]?.recommendation,
      '结合匿名聚合信号审查 settings.navigation，验证根因后规划最小充分改进。',
    )
  })

  it('reclaims a persisted running state after a process restart', async () => {
    const statePath = paths.agentAutoDreamOptimizerState('stale')
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 2,
        status: 'running',
        runId: 'stale-process-run',
        startedAt: '2026-07-20T00:00:00.000Z',
        sessionsReviewed: 0,
        pagesReviewed: 0,
        proposals: [],
      }),
    )

    const restarted = new AutoDreamOptimizerService({
      policyClient: { get: async () => enabledPolicy } as any,
      loadAuditDataset: async () => ({
        pages: ['evidence'],
        sessionsReviewed: 5,
        throughSeq: 31,
      }),
      runModel: async () =>
        JSON.stringify({
          summary: 'recovered',
          done: true,
          userProposals: [],
          platformFindings: [],
        }),
      hydrateProposals: async ({ proposals }) => proposals,
      reportPlatformFindings: async () => {},
      applyProposal: async () => ({ ok: true }),
    })
    const state = await restarted.run('stale', 'user-42', true)
    assert.equal(state.status, 'success')
    assert.equal(state.summary, 'recovered')
  })
})
