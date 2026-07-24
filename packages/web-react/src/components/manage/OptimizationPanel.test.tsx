import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { AuthSession, AutoDreamOptimizerState } from '../../lib/types'
import { OptimizationPanel } from './OptimizationPanel'

const auth: AuthSession = createMemoryAuthSession(() => {}, 'tok')
const agents = [{ id: 'main', name: '全能助手' }]

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

    render(<OptimizationPanel auth={auth} agentId="main" agents={agents} />)

    expect(await screen.findByText(/正在分析证据 172\/686/)).toBeInTheDocument()
    expect(screen.getByText(/模型批次 8\/31/)).toBeInTheDocument()
    expect(screen.getByText('949 个会话')).toBeInTheDocument()
    const progress = screen.getByRole('progressbar', { name: '全面审计进度' })
    expect(progress).toHaveAttribute('aria-valuenow', '172')
    expect(progress).toHaveAttribute('aria-valuemax', '686')
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

    render(<OptimizationPanel auth={auth} agentId="main" agents={agents} />)

    expect(await screen.findByText('正在等待当前批次安全结束')).toBeInTheDocument()
    expect(
      within(screen.getByRole('button', { name: /正在停止/ })).getByText('正在停止'),
    ).toBeInTheDocument()
  })
})
