import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api } from '../lib/api'
import { BRAND } from '../lib/brand'
import { Landing } from './Landing'

const base = { theme: 'light' as const, onCycleTheme: () => {}, onCreateOrg: () => {} }

// 品牌配置是可变的单例对象:页脚用例临时改 icp / contactEmail,用完复原。
const brandSnapshot = { ...BRAND }
type BrandWithContact = typeof BRAND & { contactEmail?: string }

beforeEach(() => {
  vi.spyOn(api, 'listOrgPlansPublic').mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.assign(BRAND, brandSnapshot)
  ;(BRAND as BrandWithContact).contactEmail = undefined
})

describe('从简 Landing', () => {
  test('完整呈现品牌主张、产品演示、执行路径、核心能力、场景与 FAQ', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)

    expect(screen.getByRole('heading', { name: '让复杂，从简。' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('从简 · Clarvy').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Clarvy').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/全能 Agent 工作台/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('产品能力演示')).toBeInTheDocument()
    expect(screen.getByText('你给目标，从简负责过程。')).toBeInTheDocument()
    expect(screen.getByText('一个人发令，整支团队协作')).toBeInTheDocument()
    expect(screen.getByText('把真实工作，直接交出去。')).toBeInTheDocument()
    expect(screen.getByText('一个入口，调动整支 AI 团队。')).toBeInTheDocument()
    expect(screen.getByText('从简和普通 AI 聊天有什么不同？')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Aurora')
  })

  test('落地页挂载快速上手教程区', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(screen.getByRole('heading', { name: '三步开始，一分钟上手' })).toBeInTheDocument()
  })

  test('导航登录与主行动按钮分别触发对应入口', () => {
    const onStart = vi.fn()
    const onLogin = vi.fn()
    render(<Landing {...base} onStart={onStart} onLogin={onLogin} />)

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(onLogin).toHaveBeenCalledTimes(1)

    // L-06:头部 / Hero / 末屏三处主 CTA 统一「免费开始」,同一个动作不再有三种叫法。
    const primaryCtas = screen.getAllByRole('button', { name: '免费开始' })
    expect(primaryCtas).toHaveLength(3)
    for (const cta of primaryCtas) fireEvent.click(cta)
    expect(onStart).toHaveBeenCalledTimes(3)
  })

  test('CTA 文案不许诺点了到不了的地方', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('开始使用从简')
    expect(text).not.toContain('免费开始使用')
    // onStart 落在开始使用 / 登录,不直达市场
    expect(text).not.toContain('浏览智能体市场')
    expect(screen.getByRole('button', { name: /开始使用，再去市场安装/ })).toBeInTheDocument()
  })

  test('工作场景卡可以直接进入试用', () => {
    const onStart = vi.fn()
    render(<Landing {...base} onStart={onStart} onLogin={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /调研与决策/ }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  // L-03:窄屏顶部导航整体隐藏时必须有替代入口;菜单点任一锚点 / Esc 收起。
  test('折叠菜单:打开后列出五个分区锚点,点锚点或按 Esc 收起', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)

    const toggle = screen.getByRole('button', { name: '打开导航' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('landing-mobile-nav')).toBeNull()

    fireEvent.click(toggle)
    const menu = document.getElementById('landing-mobile-nav')
    expect(menu).not.toBeNull()
    expect(screen.getByRole('button', { name: '收起导航' })).toHaveAttribute('aria-expanded', 'true')
    const links = Array.from(menu?.querySelectorAll('a') ?? [])
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#demo',
      '#capabilities',
      '#scenarios',
      '#agents',
      '#enterprise',
    ])
    expect(links.map((a) => a.textContent)).toEqual([
      '产品演示',
      '核心能力',
      '工作场景',
      '智能体',
      '团队版',
    ])

    fireEvent.click(links[0])
    expect(document.getElementById('landing-mobile-nav')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '打开导航' }))
    expect(document.getElementById('landing-mobile-nav')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.getElementById('landing-mobile-nav')).toBeNull()
  })

  test('桌面导航与折叠菜单指向同一组锚点', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    const desktopNav = screen.getByRole('navigation', { name: '首页导航' })
    const desktopHrefs = Array.from(desktopNav.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    fireEvent.click(screen.getByRole('button', { name: '打开导航' }))
    const mobileHrefs = Array.from(
      document.getElementById('landing-mobile-nav')?.querySelectorAll('a') ?? [],
    ).map((a) => a.getAttribute('href'))
    expect(mobileHrefs).toEqual(desktopHrefs)
  })

  // L-07:首页固定深色,主题切换在窄屏收起(触屏看不到 title 说明),桌面保留。
  test('主题切换仍在,但包裹层只在 md 起显示', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    const toggle = screen.getByRole('button', { name: /切换主题/ })
    expect(toggle.parentElement?.className).toContain('hidden')
    expect(toggle.parentElement?.className).toContain('md:block')
  })
})

describe('从简 Landing 页脚', () => {
  // L-02:备案位是法定信息位,占位文案不上页脚;真实备案号按工信部要求外链备案系统。
  test('备案号未就位时不渲染占位文案', () => {
    BRAND.icp = '备案信息更新中'
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(document.body.textContent).not.toContain('备案信息更新中')
    expect(screen.queryByRole('link', { name: /备/ })).toBeNull()
  })

  test('真实备案号渲染为工信部备案系统外链', () => {
    BRAND.icp = '赣ICP备2026123456号-1'
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    const link = screen.getByRole('link', { name: '赣ICP备2026123456号-1' })
    expect(link).toHaveAttribute('href', 'https://beian.miit.gov.cn/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  // L-02:「联系合作」不再是与链接同样式的纯文本 —— 有邮箱才出现,且出现即可点。
  test('无联系邮箱时不渲染「联系合作」;有邮箱时渲染 mailto 链接', () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(screen.queryByText('联系合作')).toBeNull()
    cleanup()

    ;(BRAND as BrandWithContact).contactEmail = 'hello@example.com'
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(screen.getByRole('link', { name: '联系合作' })).toHaveAttribute(
      'href',
      'mailto:hello@example.com',
    )
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

  // L-18:写死的兜底价会在调价后变成错误报价;拿不到公开档位就不报价,只说计费方式。
  test('公开档位不可用时不展示价格,只保留计费方式说明', async () => {
    vi.spyOn(api, 'listOrgPlansPublic').mockRejectedValue(new Error('offline'))
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    expect(await screen.findByText('按席位计费，随需加席')).toBeInTheDocument()
    await waitFor(() => expect(api.listOrgPlansPublic).toHaveBeenCalled())
    expect(screen.queryByText(/¥\s*\d+\/席起/)).toBeNull()
  })

  test('公开档位为空列表时同样不展示价格', async () => {
    render(<Landing {...base} onStart={() => {}} onLogin={() => {}} />)
    await waitFor(() => expect(api.listOrgPlansPublic).toHaveBeenCalled())
    expect(screen.getByText('按席位计费，随需加席')).toBeInTheDocument()
    expect(screen.queryByText(/¥\s*\d+\/席起/)).toBeNull()
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
