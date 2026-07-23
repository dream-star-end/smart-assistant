import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-auto-dream-optimizer-'))
process.env.OPENCLAUDE_HOME = testHome

const { AutoDreamOptimizerService } = await import('../autoDreamOptimizer.js')
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
        phases.push(input.phase)
        if (input.phase === 'map') {
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

    const state = await service.run('reduce', true)
    assert.deepEqual(phases, ['map', 'map', 'reduce_ingest', 'synthesis'])
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
    })

    const state = await service.run('lossless-pagination', true)
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

    const state = await service.run('fixed-point', true)
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

    const run = service.run('user-cancel', true)
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

    const state = await service.startManual(agentId)
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

    const state = await service.run('main', true)
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

  it('keeps an unsupported Terra target as guided review and still reports its platform finding', async () => {
    const prompts: Array<{ phase: string; prompt: string }> = []
    const reported: Array<{ findings: Array<{ capabilityId: string }> }> = []
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

    const state = await service.run('terra-target-contract', true)
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
    assert.equal(reported[0]?.findings[0]?.capabilityId, 'short_response_latency')
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
    const initial = await service.run('recover', true)
    const id = initial.proposals[0]!.id
    await assert.rejects(() => service.apply('recover', id), /simulated crash/)
    const recovered = await service.apply('recover', id)
    assert.equal(calls, 2)
    assert.equal(recovered.proposals[0]?.state, 'applied')
  })

  it('discards model-authored text before automatically reporting a platform finding', async () => {
    const reported: Array<{ findings: Array<{ problem: string; recommendation: string }> }> = []
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

    await service.run('privacy', true)
    assert.equal(reported[0]?.findings[0]?.problem, '聚合信号显示现有使用路径存在重复阻力。')
    assert.equal(
      reported[0]?.findings[0]?.recommendation,
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
    const state = await restarted.run('stale', true)
    assert.equal(state.status, 'success')
    assert.equal(state.summary, 'recovered')
  })
})
