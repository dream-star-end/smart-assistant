import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import {
  type CostTotals,
  type PipelineStage,
  type PipelineTemplate,
  type Project,
  UNPRICED_ONLY_COPY,
  emptyCostSlice,
  formatCostMoneyLine,
  formatTokenUsage,
  formatUnpricedNote,
  taskboardApi,
} from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { CostStatsView } from './CostStatsView'
import { StageSettings } from './StageSettings'
import { TaskboardView } from './TaskboardView'
import { TemplateLibrary } from './TemplateLibrary'
import { WeeklyReportView } from './WeeklyReportView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const auth = createMemoryAuthSession(() => {}, 'tok-m4')

function wrap(ui: ReactElement) {
  return render(
    <ToastProvider>
      <TooltipProvider>{ui}</TooltipProvider>
    </ToastProvider>,
  )
}

function sampleProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    key: 'OCV5',
    name: '自用',
    description: null,
    workspace: null,
    labels: [],
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function sampleTotals(over: Partial<CostTotals> = {}): CostTotals {
  return {
    runCount: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    priced: emptyCostSlice(),
    unpriced: emptyCostSlice(),
    unknownRunCount: 0,
    coverage: 'none',
    ...over,
  }
}

function sampleTemplate(over: Partial<PipelineTemplate> = {}): PipelineTemplate {
  return {
    id: 'builtin:bug',
    slug: 'builtin:bug',
    name: '问题单默认流水线',
    ticketType: 'bug',
    source: 'builtin',
    stages: [
      {
        ordinal: 0,
        name: '复现确认',
        kind: 'ai',
        agentId: null,
        promptTemplate: null,
        toolsets: null,
        effort: null,
        patrolCron: null,
        patrolEnabled: true,
        patrolTimezone: 'Asia/Shanghai',
        quietHoursStart: null,
        quietHoursEnd: null,
        maxRunsPerDay: 8,
        timeoutSec: 2400,
        maxRetries: 2,
        circuitBreakerThreshold: 3,
        onSuccess: 'advance',
        onFailure: 'retry',
        entryCondition: null,
        exitChecklist: null,
        requireHumanAck: false,
        autoClose: false,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function sampleStage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: 's1',
    pipelineId: 'pipe1',
    ordinal: 0,
    name: '复现确认',
    kind: 'human',
    agentId: null,
    promptTemplate: null,
    toolsets: null,
    effort: null,
    patrolCron: null,
    patrolEnabled: false,
    patrolTimezone: 'Asia/Shanghai',
    quietHoursStart: null,
    quietHoursEnd: null,
    maxRunsPerDay: 8,
    timeoutSec: 2400,
    maxRetries: 0,
    circuitBreakerThreshold: 3,
    onSuccess: 'advance',
    onFailure: 'wait_human',
    autoClose: false,
    entryCondition: null,
    exitChecklist: null,
    requireHumanAck: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('成本覆盖文案', () => {
  test('永远先拼 token；partial / unpriced_only 原文钉死，后者绝不是 $0', () => {
    expect(formatTokenUsage(97419, 8532)).toBe('105,951 token（入 97,419 / 出 8,532）')
    expect(formatUnpricedNote({ runCount: 1, tokensIn: 97419, tokensOut: 8532, costUsd: 0 })).toBe(
      '另有 1 次共 105,951 token 无单价，未计入',
    )
    expect(UNPRICED_ONLY_COPY).toBe('本区间全部无单价，仅有 token 数据')

    const partial = sampleTotals({
      coverage: 'partial',
      runCount: 2,
      tokensIn: 97519,
      tokensOut: 8552,
      costUsd: 0.2,
      priced: { runCount: 1, tokensIn: 100, tokensOut: 20, costUsd: 0.2 },
      unpriced: { runCount: 1, tokensIn: 97419, tokensOut: 8532, costUsd: 0 },
    })
    expect(formatCostMoneyLine(partial)).toBe('$0.2000（另有 1 次共 105,951 token 无单价，未计入）')

    const unpricedOnly = sampleTotals({
      coverage: 'unpriced_only',
      runCount: 1,
      tokensIn: 97419,
      tokensOut: 8532,
      costUsd: 0,
      unpriced: { runCount: 1, tokensIn: 97419, tokensOut: 8532, costUsd: 0 },
    })
    expect(formatCostMoneyLine(unpricedOnly)).toBe(UNPRICED_ONLY_COPY)
    expect(formatCostMoneyLine(unpricedOnly)).not.toMatch(/\$0/)
    expect(formatCostMoneyLine(unpricedOnly)).not.toMatch(/几乎不花钱/)
  })
})

describe('成本统计 API 与界面', () => {
  test('GET /api/board/stats/cost 带 from/to/groupBy/projectId', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        from: '2026-08-12',
        to: '2026-08-18',
        timeZone: 'Asia/Shanghai',
        groupBy: 'day',
        totals: sampleTotals(),
        buckets: [],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    await taskboardApi.getCostStats(auth, {
      from: '2026-08-12',
      to: '2026-08-18',
      groupBy: 'ticket',
      projectId: 'p1',
    })
    const url = String((fetchMock.mock.calls as unknown as [string][])[0]?.[0])
    expect(url).toContain('/api/board/stats/cost?')
    expect(url).toContain('from=2026-08-12')
    expect(url).toContain('to=2026-08-18')
    expect(url).toContain('groupBy=ticket')
    expect(url).toContain('projectId=p1')
  })

  test('partial 先展示 token，金额旁写缺单价说明', async () => {
    vi.spyOn(taskboardApi, 'getCostStats').mockResolvedValue({
      from: '2026-08-12',
      to: '2026-08-18',
      timeZone: 'Asia/Shanghai',
      groupBy: 'ticket',
      totals: sampleTotals({
        coverage: 'partial',
        runCount: 2,
        tokensIn: 97519,
        tokensOut: 8552,
        costUsd: 0.2,
        priced: { runCount: 1, tokensIn: 100, tokensOut: 20, costUsd: 0.2 },
        unpriced: { runCount: 1, tokensIn: 97419, tokensOut: 8532, costUsd: 0 },
      }),
      buckets: [],
    })
    wrap(<CostStatsView auth={auth} projectId="p1" projects={[sampleProject()]} />)
    expect(await screen.findByTestId('cost-coverage-tokens')).toHaveTextContent(
      '106,071 token（入 97,519 / 出 8,552）',
    )
    expect(screen.getByTestId('cost-coverage-money')).toHaveTextContent(
      '$0.2000（另有 1 次共 105,951 token 无单价，未计入）',
    )
    expect(screen.getByTestId('cost-coverage')).toHaveAttribute('data-coverage', 'partial')
  })

  test('unpriced_only 写明全部无单价，界面不出现 $0', async () => {
    vi.spyOn(taskboardApi, 'getCostStats').mockResolvedValue({
      from: '2026-08-18',
      to: '2026-08-18',
      timeZone: 'Asia/Shanghai',
      groupBy: 'day',
      totals: sampleTotals({
        coverage: 'unpriced_only',
        runCount: 1,
        tokensIn: 97419,
        tokensOut: 8532,
        costUsd: 0,
        unpriced: { runCount: 1, tokensIn: 97419, tokensOut: 8532, costUsd: 0 },
      }),
      buckets: [
        {
          key: '2026-08-18',
          label: '2026-08-18',
          ...sampleTotals({
            coverage: 'unpriced_only',
            runCount: 1,
            tokensIn: 97419,
            tokensOut: 8532,
            costUsd: 0,
            unpriced: { runCount: 1, tokensIn: 97419, tokensOut: 8532, costUsd: 0 },
          }),
        },
      ],
    })
    wrap(<CostStatsView auth={auth} projectId={null} projects={[]} />)
    const money = await screen.findByTestId('cost-coverage-money')
    expect(money).toHaveTextContent('本区间全部无单价，仅有 token 数据')
    expect(money).not.toHaveTextContent('$0')
    expect(screen.getByTestId('cost-coverage-tokens')).toHaveTextContent('105,951 token')
    expect(screen.getByTestId('cost-stats').textContent).not.toMatch(/几乎不花钱/)
  })

  test('接口失败给出可读错误而不是白屏', async () => {
    vi.spyOn(taskboardApi, 'getCostStats').mockRejectedValue(new Error('upstream down'))
    wrap(<CostStatsView auth={auth} projectId="p1" projects={[sampleProject()]} />)
    expect(await screen.findByText('成本统计加载失败')).toBeInTheDocument()
    expect(screen.getByText(/upstream down|加载成本统计失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('周报界面', () => {
  const report = {
    period: {
      week: '2026-W34',
      fromYmd: '2026-08-17',
      toYmd: '2026-08-23',
      fromMs: 1,
      toMs: 2,
      timeZone: 'Asia/Shanghai',
    },
    projectId: 'p1',
    flow: {
      created: 3,
      completed: 1,
      canceled: 0,
      waitingHuman: 2,
      blockedNow: 1,
      statusTransitions: [{ from: 'ready', to: 'running', count: 4 }],
    },
    stages: [
      {
        stageId: 's1',
        stageName: '定位根因',
        runCount: 2,
        succeeded: 1,
        failed: 1,
        timeout: 0,
        totalDurationMs: 120000,
        avgDurationMs: 60000,
      },
    ],
    cost: sampleTotals({
      coverage: 'unpriced_only',
      runCount: 1,
      tokensIn: 100,
      tokensOut: 20,
      unpriced: { runCount: 1, tokensIn: 100, tokensOut: 20, costUsd: 0 },
    }),
    blocked: [{ identifier: 'OCV5-1', title: '卡住', blockedReason: '缺复现' }],
    failedRuns: [
      {
        runId: 'r1',
        identifier: 'OCV5-1',
        stageName: '定位根因',
        status: 'failed',
        error: 'boom',
        createdAt: Date.now(),
      },
    ],
  }

  test('展示流转、阶段耗时、缺单价成本、受阻单和失败 run，并可切周/项目', async () => {
    const getWeekly = vi.spyOn(taskboardApi, 'getWeeklyReport').mockResolvedValue(report)
    wrap(<WeeklyReportView auth={auth} projectId="p1" projects={[sampleProject()]} />)
    expect(await screen.findByTestId('weekly-period')).toHaveTextContent('2026-W34')
    expect(screen.getByText('定位根因')).toBeInTheDocument()
    expect(screen.getByTestId('weekly-cost-money')).toHaveTextContent(
      '本区间全部无单价，仅有 token 数据',
    )
    expect(screen.getByTestId('weekly-blocked')).toHaveTextContent('OCV5-1')
    expect(screen.getByTestId('weekly-failed-runs')).toHaveTextContent('boom')
    await act(async () => {
      fireEvent.click(screen.getByTestId('weekly-prev'))
    })
    await waitFor(() => {
      expect(getWeekly).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({ from: '2026-08-10', to: '2026-08-16', projectId: 'p1' }),
      )
    })
  })

  test('周报接口失败有重试', async () => {
    vi.spyOn(taskboardApi, 'getWeeklyReport').mockRejectedValue(new Error('report down'))
    wrap(<WeeklyReportView auth={auth} projectId={null} projects={[]} />)
    expect(await screen.findByText('周报加载失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })
})

describe('流水线模板', () => {
  test('内置不可删、自定义可删；套用打到 apply 接口', async () => {
    vi.spyOn(taskboardApi, 'listTemplates').mockResolvedValue([
      sampleTemplate(),
      sampleTemplate({
        id: 'tpl-custom',
        slug: 'my-spike',
        name: '我的调研线',
        ticketType: 'spike',
        source: 'custom',
      }),
    ])
    const apply = vi.spyOn(taskboardApi, 'applyTemplate').mockResolvedValue({
      ok: true,
      template: sampleTemplate(),
      pipeline: null,
      createdPipelines: 1,
      createdStages: 6,
      skippedPipelines: 0,
      skippedStages: 0,
    })
    wrap(<TemplateLibrary auth={auth} projectId="p1" />)
    fireEvent.click(screen.getByTestId('template-library-open'))
    expect(await screen.findByTestId('template-card-builtin:bug')).toHaveAttribute(
      'data-source',
      'builtin',
    )
    expect(screen.getByTestId('template-card-builtin:bug')).toHaveTextContent('不可删除')
    expect(screen.queryByTestId('template-delete-builtin:bug')).not.toBeInTheDocument()
    expect(screen.getByTestId('template-delete-tpl-custom')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-apply-builtin:bug'))
    })
    await waitFor(() => {
      expect(apply).toHaveBeenCalledWith(auth, 'builtin:bug', {
        projectId: 'p1',
        asDefault: true,
      })
    })
  })

  test('建项目时全选内置线则省略 templateIds；全不选则传空数组', async () => {
    vi.spyOn(taskboardApi, 'listProjects').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'listTickets').mockResolvedValue({ items: [], total: 0 })
    vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
    vi.spyOn(taskboardApi, 'getProjectBoard').mockResolvedValue({
      project: sampleProject({ id: 'p-new', key: 'NEW1', name: '新' }),
      pipeline: {
        id: 'pipe1',
        projectId: 'p-new',
        name: '问题单默认线',
        ticketType: 'bug',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
      ticketType: 'bug',
      columns: [],
      inbox: [],
    })
    const createProject = vi.spyOn(taskboardApi, 'createProject').mockResolvedValue({
      ok: true,
      project: sampleProject({ id: 'p-new', key: 'NEW1', name: '新' }),
    })
    wrap(
      <TaskboardView
        auth={auth}
        view="board"
        ticketId={null}
        onViewChange={() => {}}
        onOpenTicket={() => {}}
        onOpenMobileNav={() => {}}
      />,
    )
    fireEvent.click(await screen.findByTestId('project-create-open'))
    await screen.findByTestId('project-templates')
    fireEvent.change(screen.getByTestId('project-key'), { target: { value: 'NEW1' } })
    fireEvent.change(screen.getByTestId('project-name'), { target: { value: '新' } })
    fireEvent.click(screen.getByTestId('project-template-builtin:bug'))
    fireEvent.click(screen.getByTestId('project-template-builtin:feature'))
    fireEvent.click(screen.getByTestId('project-template-builtin:spike'))
    fireEvent.click(screen.getByTestId('project-template-builtin:chore'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('project-create-submit'))
    })
    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({ key: 'NEW1', name: '新', templateIds: [] }),
      )
    })
  })
})

describe('阶段拖拽排序', () => {
  test('上移/下移与 drop 都会 PATCH ordinal', async () => {
    const pipeline = {
      id: 'pipe1',
      projectId: 'p1',
      name: '问题单默认线',
      ticketType: 'bug' as const,
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }
    const s1 = sampleStage({ id: 's1', name: '复现确认', ordinal: 0 })
    const s2 = sampleStage({ id: 's2', name: '定位根因', ordinal: 1 })
    vi.spyOn(taskboardApi, 'listPipelines').mockResolvedValue([pipeline])
    vi.spyOn(taskboardApi, 'getPipeline').mockResolvedValue({ pipeline, stages: [s1, s2] })
    vi.spyOn(taskboardApi, 'listAgents').mockResolvedValue([])
    const patchStage = vi
      .spyOn(taskboardApi, 'patchStage')
      .mockImplementation(async (_a, id, body) => ({
        ok: true,
        stage: id === 's1' ? { ...s1, ...body } : { ...s2, ...body },
      }))
    wrap(<StageSettings auth={auth} projectId="p1" />)
    fireEvent.click(screen.getByTestId('stage-settings-open'))
    await screen.findByTestId('stage-row-s1')
    await act(async () => {
      fireEvent.click(screen.getByTestId('stage-down-s1'))
    })
    await waitFor(() => {
      expect(patchStage).toHaveBeenCalled()
    })
    const ordinals = patchStage.mock.calls.map((c) => [
      c[1],
      (c[2] as { ordinal?: number }).ordinal,
    ])
    expect(ordinals.some((row) => row[1] === 0)).toBe(true)
    expect(ordinals.some((row) => row[1] === 1)).toBe(true)

    patchStage.mockClear()
    const dt = {
      data: {} as Record<string, string>,
      effectAllowed: 'move',
      dropEffect: 'move',
      setData(type: string, val: string) {
        this.data[type] = val
      },
      getData(type: string) {
        return this.data[type]
      },
    }
    const source = screen.getByTestId('stage-row-s2')
    const target = screen.getByTestId('stage-row-s1')
    fireEvent.dragStart(source, { dataTransfer: dt })
    fireEvent.dragOver(target, { dataTransfer: dt })
    expect(target).toHaveAttribute('data-drop-target', 'true')
    await act(async () => {
      fireEvent.drop(target, { dataTransfer: dt })
    })
    await waitFor(() => {
      expect(patchStage).toHaveBeenCalled()
    })
  })
})
