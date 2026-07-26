import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type {
  AuthSession,
  AutoDreamOptimizerProposal,
  AutoDreamOptimizerState,
} from '../../lib/types'
import { TooltipProvider } from '../ui'
import { OptimizationPanel } from './OptimizationPanel'

const auth: AuthSession = createMemoryAuthSession(() => {}, 'tok')
const agents = [{ id: 'main', name: '全能助手' }]

function proposal(over: Partial<AutoDreamOptimizerProposal> = {}): AutoDreamOptimizerProposal {
  return {
    id: 'p1',
    fingerprint: 'fp1',
    category: 'memory',
    action: 'memory.update',
    title: '合并重复的项目记忆',
    reason: '两条记忆描述同一个项目，合并后检索更准。',
    targetId: 'project.md',
    before: '旧内容',
    after: '新内容',
    beforeFingerprint: 'bf1',
    state: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  }
}

function idleState(over: Partial<AutoDreamOptimizerState> = {}): AutoDreamOptimizerState {
  return {
    schemaVersion: 2,
    status: 'success',
    sessionsReviewed: 3,
    pagesReviewed: 5,
    proposals: [],
    ...over,
  }
}

/**
 * 与 main.tsx 的真实树对齐:TooltipProvider 挂在应用根部,面板内的 TimeAgo 默认带
 * 绝对时间 tooltip。裸 render 会踩 Radix 的 "must be used within TooltipProvider"。
 */
function renderPanel() {
  return render(
    <TooltipProvider>
      <OptimizationPanel auth={auth} agentId="main" agents={agents} />
    </TooltipProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OptimizationPanel live progress', () => {
  test('shows real evidence and batch progress while a comprehensive audit is running', async () => {
    vi.spyOn(api, 'getAutoDreamOptimizer').mockResolvedValue({
      schemaVersion: 2,
      status: 'running',
      runId: 'run-1',
      sessionsReviewed: 0,
      pagesReviewed: 0,
      proposals: [],
      progress: {
        stage: 'mapping',
        sessionsTotal: 949,
        evidencePagesTotal: 686,
        evidencePagesReviewed: 172,
        mapBatchesTotal: 31,
        mapBatchesCompleted: 8,
        reducePagesTotal: 0,
        reducePagesCompleted: 0,
        synthesisPagesCompleted: 0,
      },
    } as AutoDreamOptimizerState & {
      progress: {
        stage: 'mapping'
        sessionsTotal: number
        evidencePagesTotal: number
        evidencePagesReviewed: number
        mapBatchesTotal: number
        mapBatchesCompleted: number
        reducePagesTotal: number
        reducePagesCompleted: number
        synthesisPagesCompleted: number
      }
    })

    renderPanel()

    expect(await screen.findByText(/正在分析证据 172\/686/)).toBeInTheDocument()
    expect(screen.getByText(/模型批次 8\/31/)).toBeInTheDocument()
    expect(screen.getByText('949 个会话')).toBeInTheDocument()
    // 进度条铺满整轮五个阶段(0–100)，不再只画 evidencePages —— 后者在 reducing 起就恒为
    // 满格，用户读到的是"卡在 100%"。mapping 占 8–70 这一段:8 + 62×172/686 = 24。
    const progress = screen.getByRole('progressbar', { name: '全面审计进度' })
    expect(progress).toHaveAttribute('aria-valuenow', '24')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    // 具体在做什么由 aria-valuetext 播报,读屏不会只听到一个孤立的百分数。
    expect(progress).toHaveAttribute(
      'aria-valuetext',
      '第 2/5 步 · 分析证据 · 正在分析证据 172/686（模型批次 8/31）',
    )
    expect(screen.getByText('第 2/5 步 · 分析证据')).toBeInTheDocument()
  })

  test('explains that cancellation waits only for already in-flight batches', async () => {
    vi.spyOn(api, 'getAutoDreamOptimizer').mockResolvedValue({
      schemaVersion: 2,
      status: 'running',
      runId: 'run-2',
      cancelRequestedAt: new Date().toISOString(),
      sessionsReviewed: 0,
      pagesReviewed: 0,
      proposals: [],
      progress: {
        stage: 'mapping',
        sessionsTotal: 12,
        evidencePagesTotal: 12,
        evidencePagesReviewed: 4,
        mapBatchesTotal: 6,
        mapBatchesCompleted: 2,
        reducePagesTotal: 0,
        reducePagesCompleted: 0,
        synthesisPagesCompleted: 0,
      },
    } as AutoDreamOptimizerState & {
      progress: {
        stage: 'mapping'
        sessionsTotal: number
        evidencePagesTotal: number
        evidencePagesReviewed: number
        mapBatchesTotal: number
        mapBatchesCompleted: number
        reducePagesTotal: number
        reducePagesCompleted: number
        synthesisPagesCompleted: number
      }
    })

    renderPanel()

    expect(await screen.findByText('正在等待当前批次安全结束')).toBeInTheDocument()
    expect(
      within(screen.getByRole('button', { name: /正在停止/ })).getByText('正在停止'),
    ).toBeInTheDocument()
  })
})

describe('OptimizationPanel 失败路径', () => {
  test('应用建议失败时错误报在弹窗内并可就地重试（不再被自己的遮罩盖住）', async () => {
    vi.spyOn(api, 'getAutoDreamOptimizer').mockResolvedValue(idleState({ proposals: [proposal()] }))
    const mutate = vi.spyOn(api, 'mutateAutoDreamProposal').mockRejectedValue(new Error('boom'))

    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: /合并重复的项目记忆/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /确认并应用/ }))

    // 关键契约：错误渲染在发起它的容器（弹窗）里，而不是被遮罩盖住的父面板顶部。
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('应用建议失败')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 弹窗必须保持打开，否则用户看不到任何失败线索。
    expect(within(dialog).getByRole('button', { name: /确认并应用/ })).toBeInTheDocument()

    fireEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(mutate).toHaveBeenCalledTimes(2)
  })

  test('整表加载失败只出错误态，不再和「暂无待确认建议」的假空态并存', async () => {
    const get = vi.spyOn(api, 'getAutoDreamOptimizer').mockRejectedValue(new Error('nope'))

    renderPanel()

    expect(await screen.findByText('暂时读不到优化报告')).toBeInTheDocument()
    expect(screen.queryByText('暂无待确认建议')).not.toBeInTheDocument()

    get.mockResolvedValue(idleState())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('暂无待确认建议')).toBeInTheDocument()
    expect(screen.queryByText('暂时读不到优化报告')).not.toBeInTheDocument()
  })
})

describe('OptimizationPanel 状态与历史', () => {
  test('上次失败给出用户语原因与重新审计出口（state.error 不再是死代码）', async () => {
    vi.spyOn(api, 'getAutoDreamOptimizer').mockResolvedValue(
      idleState({ status: 'failed', error: 'upstream request timeout after 900s' }),
    )

    renderPanel()

    expect(await screen.findByText('上次失败')).toBeInTheDocument()
    expect(
      screen.getByText(/上次审计中断：模型响应超时了，重新发起一次通常就能跑完。/),
    ).toBeInTheDocument()
    // 原始英文串不得裸露给用户。
    expect(screen.queryByText(/upstream request timeout/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新审计' })).toBeInTheDocument()
  })

  test('已处理建议带处理时间，且以只读态复用同一个弹层', async () => {
    vi.spyOn(api, 'getAutoDreamOptimizer').mockResolvedValue(
      idleState({
        lastSuccessAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        proposals: [
          proposal({
            state: 'applied',
            appliedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
          }),
        ],
      }),
    )

    renderPanel()

    expect(await screen.findByText(/查看已处理建议（1）/)).toBeInTheDocument()
    // 日期一律走 TimeAgo（顺带证明它在无 TooltipProvider 的子树里也不炸）。
    expect(screen.getByText('3 分钟前')).toBeInTheDocument()
    expect(screen.getByText('2 分钟前')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /合并重复的项目记忆/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: /确认并应用/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: '忽略' })).not.toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: '关闭' }).length).toBeGreaterThan(0)
  })
})
