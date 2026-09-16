import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { MarketplaceCapabilityReadiness, MarketplaceInstalled } from '../../lib/types'
import { TooltipProvider } from '../ui'

const mocks = vi.hoisted(() => ({
  listMarketplaceInstalled: vi.fn(),
  listMyAgents: vi.fn(),
  uninstallMarketplace: vi.fn(),
}))
vi.mock('../../lib/api', () => ({
  api: {
    listMarketplaceInstalled: (...args: unknown[]) => mocks.listMarketplaceInstalled(...args),
    listMyAgents: (...args: unknown[]) => mocks.listMyAgents(...args),
    uninstallMarketplace: (...args: unknown[]) => mocks.uninstallMarketplace(...args),
  },
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
}))

import { InstalledPanel } from './InstalledPanel'

const auth = createMemoryAuthSession(() => {}, 'tok')
const installed: MarketplaceInstalled = {
  slug: 'research-helper',
  kind: 'skill',
  version: '1.0.0',
  versionId: 'v1',
  name: '研究助手',
  artifactHash: 'hash',
  agentIds: ['main'],
  installedAt: '2026-07-25T00:00:00.000Z',
  listingState: 'active',
}

beforeEach(() => {
  mocks.listMarketplaceInstalled.mockReset().mockResolvedValue([installed])
  mocks.listMyAgents.mockReset().mockResolvedValue([])
  mocks.uninstallMarketplace.mockReset().mockResolvedValue({ ok: true })
})
afterEach(cleanup)

test('卸载前可选原因并随请求提交', async () => {
  render(
    <TooltipProvider>
      <InstalledPanel auth={auth} onGoBrowse={() => {}} />
    </TooltipProvider>,
  )
  await screen.findByText('研究助手')
  fireEvent.click(screen.getByRole('button', { name: '卸载' }))

  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('原因（可不说明）'), {
    target: { value: 'missing_capability' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '卸载' }))

  await waitFor(() =>
    expect(mocks.uninstallMarketplace).toHaveBeenCalledWith(
      auth,
      'research-helper',
      'missing_capability',
    ),
  )
})

test('卸载失败时错误就地渲染在弹窗里(面板顶部会被遮罩盖住)', async () => {
  mocks.uninstallMarketplace.mockRejectedValue(new Error('boom'))
  render(
    <TooltipProvider>
      <InstalledPanel auth={auth} onGoBrowse={() => {}} />
    </TooltipProvider>,
  )
  await screen.findByText('研究助手')
  fireEvent.click(screen.getByRole('button', { name: '卸载' }))

  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '卸载' }))

  expect(await within(dialog).findByText('卸载失败')).toBeInTheDocument()
  // 弹窗保持打开:失败没有关闭它,用户在原地就能读到原因并重试
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('列表按 kind 分组;行内不再重复挂与分组同名的种类徽章,slug 以等宽小字进 meta 行(K-22)', async () => {
  mocks.listMarketplaceInstalled.mockResolvedValue([
    installed,
    {
      ...installed,
      slug: 'writer-agent',
      kind: 'agent',
      name: '写作智能体',
      agentIds: undefined,
    },
    {
      ...installed,
      slug: 'notion',
      kind: 'connector',
      name: 'Notion',
      agentIds: undefined,
    },
  ] as MarketplaceInstalled[])
  render(
    <TooltipProvider>
      <InstalledPanel auth={auth} onGoBrowse={() => {}} onOpenConnectors={() => {}} />
    </TooltipProvider>,
  )

  expect(await screen.findByText('智能体（1）')).toBeInTheDocument()
  expect(screen.getByText('技能（1）')).toBeInTheDocument()
  expect(screen.getByText('API 连接插件（1）')).toBeInTheDocument()
  // 分组标题已经说明了种类,行内那枚「技能」「智能体」「API 插件」徽章是重复信息
  expect(screen.queryByText('技能')).not.toBeInTheDocument()
  expect(screen.queryByText('智能体')).not.toBeInTheDocument()
  expect(screen.queryByText('API 插件')).not.toBeInTheDocument()
  // slug 不再冒充"描述",改为 meta 行里的等宽小字
  for (const slug of ['research-helper', 'writer-agent', 'notion']) {
    expect(screen.getByText(slug)).toHaveClass('font-mono', 'text-caption')
  }
})

test('只剩「卸载」一个动作的行,垃圾桶并进 meta 行右侧而不再独占操作槽(K-08)', async () => {
  mocks.listMarketplaceInstalled.mockResolvedValue([
    // 智能体:无新版本、无待授权 → 只有卸载
    {
      ...installed,
      slug: 'writer-agent',
      kind: 'agent',
      name: '写作智能体',
      agentIds: undefined,
      capabilityReadiness: { installed: true, ready: true, requirements: [], needsAuthorization: [] },
    },
    // 技能:还有「归属」→ 照旧走操作槽
    installed,
  ] as MarketplaceInstalled[])
  render(
    <TooltipProvider>
      <InstalledPanel auth={auth} onGoBrowse={() => {}} onOpenConnectors={() => {}} />
    </TooltipProvider>,
  )
  await screen.findByText('写作智能体')

  const [agentUninstall, skillUninstall] = screen.getAllByRole('button', { name: '卸载' })
  // 智能体行:卸载按钮的直接容器是 meta 行里 ml-auto 的那个 span,不是 CardRow 的窄屏整行操作槽
  expect(agentUninstall.parentElement).toHaveClass('ml-auto')
  expect(agentUninstall.closest('.max-sm\\:w-full')).toBeNull()
  // 技能行:有「归属」作伴,卸载仍在操作槽里
  expect(skillUninstall.parentElement).toHaveClass('max-sm:w-full')
  expect(screen.getByRole('button', { name: '归属' })).toBeInTheDocument()
})

const READINESS_CASES: Array<[string, MarketplaceCapabilityReadiness, string, string]> = [
  [
    '全部就绪',
    {
      installed: true,
      ready: true,
      requirements: [
        { kind: 'skill', slug: 'a', optional: false, installed: true, bound: true, status: 'ready' },
        { kind: 'plugin', slug: 'b', optional: false, installed: true, bound: true, status: 'ready' },
      ],
      needsAuthorization: [],
    },
    '能力已就绪',
    '2/2 项组合能力就绪',
  ],
  [
    '必需就绪 + 1 项可选 Plugin 待授权',
    {
      installed: true,
      ready: true,
      requirements: [
        { kind: 'skill', slug: 'a', optional: false, installed: true, bound: true, status: 'ready' },
        {
          kind: 'plugin',
          slug: 'b',
          optional: true,
          installed: true,
          bound: false,
          status: 'needs_authorization',
        },
      ],
      needsAuthorization: ['b'],
    },
    '必需能力已就绪 · 1 项可选 Plugin 待授权',
    '1/2 项组合能力就绪',
  ],
  [
    '2 项必需未就绪',
    {
      installed: true,
      ready: false,
      requirements: [
        { kind: 'skill', slug: 'a', optional: false, installed: false, bound: false, status: 'missing' },
        { kind: 'plugin', slug: 'b', optional: false, installed: true, bound: true, status: 'revoked' },
        { kind: 'skill', slug: 'c', optional: true, installed: true, bound: true, status: 'ready' },
      ],
      needsAuthorization: [],
    },
    '2 项必需能力未就绪',
    '1/3 项组合能力就绪',
  ],
]

test.each(READINESS_CASES)('智能体就绪状态只留一枚徽章 + 一句注脚:%s(K-09)', async (_label, readiness, badge, caption) => {
  mocks.listMarketplaceInstalled.mockResolvedValue([
    {
      ...installed,
      slug: 'writer-agent',
      kind: 'agent',
      name: '写作智能体',
      agentIds: undefined,
      capabilityReadiness: readiness,
    },
  ] as MarketplaceInstalled[])
  render(
    <TooltipProvider>
      <InstalledPanel auth={auth} onGoBrowse={() => {}} onOpenConnectors={() => {}} />
    </TooltipProvider>,
  )
  await screen.findByText('写作智能体')

  expect(screen.getByText(badge)).toBeInTheDocument()
  expect(screen.getByText(caption)).toBeInTheDocument()
  // 旧版三句打架的另外两句不再同时出现
  for (const stale of ['可选 Plugin 待授权', 'Plugin 待授权', '能力未就绪']) {
    expect(screen.queryByText(stale)).not.toBeInTheDocument()
  }
})
