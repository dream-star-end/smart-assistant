import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../lib/api'
import { Landing } from './Landing'

const base = { theme: 'light' as const, onCycleTheme: () => {}, onCreateOrg: () => {} }

beforeEach(() => {
  vi.spyOn(api, 'listOrgPlansPublic').mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('从简 Landing', () => {
  test('完整呈现品牌主张、产品演示、执行路径、核心能力、场景与 FAQ', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)

    expect(screen.getByRole('heading', { name: '让复杂，从简。' })).toBeInTheDocument()
    expect(screen.getAllByText(/全能 Agent 工作台/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('产品能力演示')).toBeInTheDocument()
    expect(screen.getByText('你给目标，从简负责过程。')).toBeInTheDocument()
    expect(screen.getByText('一个人发令，整支团队协作')).toBeInTheDocument()
    expect(screen.getByText('把真实工作，直接交出去。')).toBeInTheDocument()
    expect(screen.getByText('一个入口，调动整支 AI 团队。')).toBeInTheDocument()
    expect(screen.getByText('从简和普通 AI 聊天有什么不同？')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Aurora')
  })

  test('导航登录与主行动按钮分别触发对应入口', () => {
    const onStart = vi.fn()
    const onLogin = vi.fn()
    render(<Landing {...base} onStart={onStart} onLogin={onLogin} />)

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(onLogin).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '开始使用从简' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  test('工作场景卡可以直接进入试用', () => {
    const onStart = vi.fn()
    render(<Landing {...base} onStart={onStart} onLogin={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /调研与决策/ }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})

describe('从简团队版', () => {
  test('呈现团队卖点与组织工作台示意', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)

    expect(screen.getByText('共享积分池')).toBeInTheDocument()
    expect(screen.getByText('成员与角色')).toBeInTheDocument()
    expect(screen.getByText('用量与发票')).toBeInTheDocument()
    expect(screen.getByText('组织级管理')).toBeInTheDocument()
    expect(screen.getByText('增长项目 · 智能体协作')).toBeInTheDocument()
    expect(screen.queryByText(/折扣|优惠|9\s*折/)).toBeNull()
  })

  test('公开档位不可用时展示静态锚点价', async () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(await screen.findByText('¥88/席起')).toBeInTheDocument()
  })

  test('公开档位可用时展示最低每席价', async () => {
    vi.spyOn(api, 'listOrgPlansPublic').mockResolvedValue([
      {
        code: 'org-pro',
        name: '企业·专业',
        seatPriceCents: '9800',
        perSeatCredits: '0',
        minSeats: 3,
        periodDays: 30,
      },
      {
        code: 'org-max',
        name: '企业·旗舰',
        seatPriceCents: '29800',
        perSeatCredits: '0',
        minSeats: 3,
        periodDays: 30,
      },
    ])
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(await screen.findByText('¥98/席起')).toBeInTheDocument()
  })

  test('创建组织 CTA 触发组织入口', () => {
    const onCreateOrg = vi.fn()
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} onCreateOrg={onCreateOrg} />)
    fireEvent.click(screen.getByRole('button', { name: /创建组织/ }))
    expect(onCreateOrg).toHaveBeenCalledTimes(1)
  })
})
