import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import type {
  KnowledgePlanetAutomationRule,
  KnowledgePlanetAutomationView,
  RuntimePluginAccount,
} from '../../lib/connectors'
import { ToastProvider, TooltipProvider } from '../ui'

const mocks = vi.hoisted(() => ({
  getKnowledgePlanetAutomation: vi.fn(),
  setKnowledgePlanetAutomation: vi.fn(),
  listKnowledgePlanetAutomationGroups: vi.fn(),
  createKnowledgePlanetAutomationRulesBatch: vi.fn(),
  patchKnowledgePlanetAutomationRule: vi.fn(),
  deleteKnowledgePlanetAutomationRule: vi.fn(),
}))
vi.mock('../../lib/api', () => ({
  api: {
    getKnowledgePlanetAutomation: (...a: unknown[]) => mocks.getKnowledgePlanetAutomation(...a),
    setKnowledgePlanetAutomation: (...a: unknown[]) => mocks.setKnowledgePlanetAutomation(...a),
    listKnowledgePlanetAutomationGroups: (...a: unknown[]) =>
      mocks.listKnowledgePlanetAutomationGroups(...a),
    createKnowledgePlanetAutomationRulesBatch: (...a: unknown[]) =>
      mocks.createKnowledgePlanetAutomationRulesBatch(...a),
    patchKnowledgePlanetAutomationRule: (...a: unknown[]) =>
      mocks.patchKnowledgePlanetAutomationRule(...a),
    deleteKnowledgePlanetAutomationRule: (...a: unknown[]) =>
      mocks.deleteKnowledgePlanetAutomationRule(...a),
  },
  apiErrorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error && cause.message ? cause.message : fallback,
}))

import { KnowledgePlanetAutomationPanel, validateAccountLimit, validateRuleDraft } from './KnowledgePlanetAutomationPanel'

const auth = createMemoryAuthSession(() => {}, 'tok')

const account: RuntimePluginAccount = {
  id: 'acc_1',
  provider: 'knowledge-planet',
  pluginType: 'managed-browser',
  displayName: '小林',
  accountHint: 'wx_****88',
  status: 'active',
  actions: [],
  versionId: 'ver_1',
  executable: true,
  writeControl: {
    available: true,
    enabled: true,
    disclaimerVersion: 1,
    acceptedVersion: 1,
    acceptedAt: '2026-09-01T00:00:00.000Z',
    disclaimerText: '手动写入声明',
  },
}

function rule(over: Partial<KnowledgePlanetAutomationRule> = {}): KnowledgePlanetAutomationRule {
  return {
    id: 'rule_1',
    groupId: 'g1',
    name: '产品经理营 · 新提问自动答疑',
    instructions: '只回答与产品方法论相关的提问。',
    triggerKind: 'new_question',
    enabled: true,
    dailyLimit: 5,
    cooldownMinutes: 15,
    maxReplyChars: 600,
    consecutiveFailures: 0,
    pausedReason: null,
    lastCursorAt: null,
    nextRunAt: '2026-09-16T13:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  }
}

function view(over: Partial<KnowledgePlanetAutomationView> = {}): KnowledgePlanetAutomationView {
  return {
    control: {
      available: true,
      enabled: true,
      disclaimerVersion: 2,
      acceptedVersion: 2,
      acceptedAt: '2026-09-01T00:00:00.000Z',
      disclaimerText: '免责声明正文',
      accountDailyLimit: 10,
      pausedReason: null,
    },
    rules: [rule(), rule({ id: 'rule_2', groupId: 'g2', name: '出海圈 · 欢迎新主题', enabled: false })],
    recentRuns: [
      {
        id: 'run_1',
        ruleId: 'rule_1',
        sourceTopicId: '588521',
        status: 'succeeded',
        reasonCode: null,
        upstreamCommentId: 'c1',
        createdAt: '2026-09-16T12:00:00.000Z',
        finishedAt: '2026-09-16T12:00:30.000Z',
      },
      {
        id: 'run_2',
        ruleId: 'rule_gone',
        sourceTopicId: '588522',
        status: 'failed',
        reasonCode: 'CURSOR_NOT_FOUND',
        upstreamCommentId: null,
        createdAt: '2026-09-15T12:00:00.000Z',
        finishedAt: '2026-09-15T12:00:05.000Z',
      },
      {
        id: 'run_3',
        ruleId: 'rule_1',
        sourceTopicId: '588523',
        status: 'skipped',
        reasonCode: 'DAILY_LIMIT',
        upstreamCommentId: null,
        createdAt: '2026-09-14T12:00:00.000Z',
        finishedAt: '2026-09-14T12:00:01.000Z',
      },
    ],
    ...over,
  }
}

const GROUPS = [
  { id: 'g1', name: 'AI 产品经理成长营', memberCount: 1284 },
  { id: 'g2', name: '独立开发者出海圈', memberCount: 466 },
  { id: 'g3', name: '周报写作陪跑', memberCount: 98 },
]

function renderPanel(acc: RuntimePluginAccount = account) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <KnowledgePlanetAutomationPanel auth={auth} account={acc} />
      </TooltipProvider>
    </ToastProvider>,
  )
}

beforeEach(() => {
  mocks.getKnowledgePlanetAutomation.mockReset().mockResolvedValue(view())
  mocks.setKnowledgePlanetAutomation.mockReset().mockResolvedValue(view().control)
  mocks.listKnowledgePlanetAutomationGroups.mockReset().mockResolvedValue(GROUPS)
  mocks.createKnowledgePlanetAutomationRulesBatch.mockReset().mockResolvedValue([rule()])
  mocks.patchKnowledgePlanetAutomationRule.mockReset().mockResolvedValue(rule())
  mocks.deleteKnowledgePlanetAutomationRule.mockReset().mockResolvedValue(undefined)
})
afterEach(cleanup)

test('加载失败给「重试」出口,点击后重新拉取并渲染(KP-03)', async () => {
  mocks.getKnowledgePlanetAutomation.mockRejectedValueOnce(new Error('插件运行时暂时不可用'))
  renderPanel()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('没能加载无人值守自动回复设置')
  expect(alert).toHaveTextContent('插件运行时暂时不可用')
  fireEvent.click(within(alert).getByRole('button', { name: /重试/ }))

  expect(await screen.findByText('出海圈 · 欢迎新主题')).toBeInTheDocument()
  expect(mocks.getKnowledgePlanetAutomation).toHaveBeenCalledTimes(2)
})

test('同意弹层:上限越界先在输入框下报错且不发请求;服务端拒绝时错误在弹层内可见(KP-01)', async () => {
  mocks.getKnowledgePlanetAutomation.mockResolvedValue(
    view({ control: { ...view().control, enabled: false, acceptedVersion: null }, rules: [] }),
  )
  renderPanel()
  await screen.findByText('还没有自动回复规则')

  fireEvent.click(screen.getByRole('switch', { name: '知识星球无人值守自动回复' }))
  const dialog = await screen.findByRole('dialog')
  const limit = within(dialog).getByLabelText(/每账号每日最多自动回复/)
  fireEvent.change(limit, { target: { value: '0' } })
  fireEvent.click(within(dialog).getByRole('checkbox'))
  fireEvent.click(within(dialog).getByRole('button', { name: '同意并开启' }))

  // 客户端先拦:错误挂在字段上(aria-invalid + 文案),接口一次都没调
  expect(limit).toHaveAttribute('aria-invalid', 'true')
  expect(within(dialog).getByText('每账号每日上限必须是 1–30 的整数')).toBeInTheDocument()
  expect(mocks.setKnowledgePlanetAutomation).not.toHaveBeenCalled()

  // 改回合法值 → 服务端拒绝 → 错误必须出现在弹层里,弹层保持打开
  fireEvent.change(limit, { target: { value: '12' } })
  expect(limit).not.toHaveAttribute('aria-invalid')
  mocks.setKnowledgePlanetAutomation.mockRejectedValueOnce(new Error('免责声明版本已更新'))
  fireEvent.click(within(dialog).getByRole('button', { name: '同意并开启' }))
  expect(await within(dialog).findByText('免责声明版本已更新')).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(mocks.setKnowledgePlanetAutomation).toHaveBeenCalledWith(auth, 'acc_1', {
    enabled: true,
    accepted: true,
    disclaimerVersion: 2,
    accountDailyLimit: 12,
  })
})

test('规则表单:校验失败落到出错字段(aria-invalid + 聚焦),不提交;范围提示常驻(KP-07)', async () => {
  renderPanel()
  await screen.findByText('出海圈 · 欢迎新主题')
  fireEvent.click(screen.getAllByRole('button', { name: /编辑/ })[0])
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('编辑自动回复规则')).toBeInTheDocument()
  // 编辑态描述不再说"新规则"
  expect(within(dialog).getByText(/修改保存后立即生效/)).toBeInTheDocument()
  // 范围提示不必等到报错才知道
  expect(within(dialog).getByText('1–10')).toBeInTheDocument()
  expect(within(dialog).getByText('5–1440')).toBeInTheDocument()
  expect(within(dialog).getByText('100–1200')).toBeInTheDocument()

  const name = within(dialog).getByLabelText(/规则名称/)
  fireEvent.change(name, { target: { value: '   ' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))

  expect(name).toHaveAttribute('aria-invalid', 'true')
  expect(name).toHaveFocus()
  expect(within(dialog).getByText('请输入规则名称')).toBeInTheDocument()
  expect(mocks.patchKnowledgePlanetAutomationRule).not.toHaveBeenCalled()

  // 一改字段,过时的错误就撤
  fireEvent.change(name, { target: { value: '新名字' } })
  expect(name).not.toHaveAttribute('aria-invalid')

  const daily = within(dialog).getByLabelText(/每日上限/)
  fireEvent.change(daily, { target: { value: '11' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存规则' }))
  expect(daily).toHaveAttribute('aria-invalid', 'true')
  expect(within(dialog).getByText('每日上限必须是 1–10 的整数')).toBeInTheDocument()
  expect(mocks.patchKnowledgePlanetAutomationRule).not.toHaveBeenCalled()
})

test('批量新建:星球选项以 aria-pressed 表达选中态,已配置的不可选;整枚芯片即「移除」(KP-05 / KP-06)', async () => {
  renderPanel()
  await screen.findByText('出海圈 · 欢迎新主题')
  fireEvent.click(screen.getByRole('button', { name: /添加规则/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: /从当前账号已加入的星球中选择/ }))

  const option = await screen.findByRole('button', { name: /周报写作陪跑/ })
  expect(option).toHaveAttribute('aria-pressed', 'false')
  // g1 / g2 已有规则 → 禁用并标「已配置」
  expect(screen.getByRole('button', { name: /AI 产品经理成长营/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: /AI 产品经理成长营/ })).toHaveTextContent('已配置')
  // 「选择可用」改名「全选可用」
  expect(screen.getByRole('button', { name: '全选可用' })).toBeInTheDocument()

  fireEvent.click(option)
  expect(option).toHaveAttribute('aria-pressed', 'true')
  expect(within(dialog).getByRole('button', { name: /保存并启用 1 条规则/ })).toBeEnabled()

  // 芯片本身就是移除按钮(触控靶由 Chip 原语保证),不再是 11px 的 ✕
  const chip = within(dialog).getByRole('button', { name: '移除 周报写作陪跑' })
  expect(chip).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(chip)
  expect(within(dialog).queryByRole('button', { name: '移除 周报写作陪跑' })).not.toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: /保存并启用 0 条规则/ })).toBeDisabled()
})

test('空态用 EmptyState 给出下一步;总开关关着时说明为什么不能添加(KP-08)', async () => {
  mocks.getKnowledgePlanetAutomation.mockResolvedValueOnce(view({ rules: [], recentRuns: [] }))
  renderPanel()
  expect(await screen.findByText('还没有自动回复规则')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /添加第一条规则/ }))
  expect(await screen.findByText('批量添加自动回复规则')).toBeInTheDocument()
  cleanup()

  mocks.getKnowledgePlanetAutomation.mockResolvedValueOnce(
    view({ control: { ...view().control, enabled: false }, rules: [], recentRuns: [] }),
  )
  renderPanel()
  expect(await screen.findByText('还没有自动回复规则')).toBeInTheDocument()
  expect(screen.getByText('先开启上方总开关，再添加规则。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /添加规则/ })).toBeDisabled()
  expect(screen.queryByRole('button', { name: /添加第一条规则/ })).not.toBeInTheDocument()
})

test('运行记录:summary 带计数,每条给状态徽章 + 规则名 + 时间 + 原因,规则已删的如实标注(KP-04)', async () => {
  renderPanel()
  await screen.findByText('出海圈 · 欢迎新主题')

  const summary = screen.getByText('最近执行记录（3）')
  fireEvent.click(summary)
  const list = summary.parentElement?.querySelector('ul') as HTMLElement
  const items = within(list).getAllByRole('listitem')
  expect(items).toHaveLength(3)
  expect(items[0]).toHaveTextContent('已回复')
  expect(items[0]).toHaveTextContent('产品经理营 · 新提问自动答疑')
  expect(items[0]).toHaveTextContent('主题 588521')
  expect(items[1]).toHaveTextContent('失败')
  expect(items[1]).toHaveTextContent('（规则已删除）')
  expect(items[1]).toHaveTextContent('主题游标失效，已暂停规则')
  expect(items[2]).toHaveTextContent('已跳过')
  expect(items[2]).toHaveTextContent('达到当日限额')
  // 每条都有时间(TimeAgo 的相对时间 span)
  for (const item of items) expect(item.querySelector('.tabular-nums')).not.toBeNull()
})

test('规则行走 CardRow:操作区在窄屏落到第二行整行右对齐,主名不再被开关挤成六个字(KP-02)', async () => {
  renderPanel()
  await screen.findByText('出海圈 · 欢迎新主题')
  // 第一处是 CardRow 的主名(运行记录里还会再出现规则名)
  const title = screen.getAllByText('产品经理营 · 新提问自动答疑')[0]
  expect(title).toHaveClass('truncate')
  const toggle = screen.getByRole('switch', { name: /产品经理营 · 新提问自动答疑/ })
  expect(toggle.parentElement).toHaveClass('max-sm:w-full', 'max-sm:justify-end')
  // 状态徽章:启用且总开关开 → 运行中;停用 → 已停用
  expect(screen.getByText('运行中')).toBeInTheDocument()
  expect(screen.getByText('已停用')).toBeInTheDocument()
})

test('只锁正在操作的那一行:切换第一条时第二条的开关仍可用;失败走 toast 带重试(KP-14)', async () => {
  let release: (v: unknown) => void = () => {}
  mocks.patchKnowledgePlanetAutomationRule.mockImplementationOnce(
    () => new Promise((resolve) => { release = resolve }),
  )
  renderPanel()
  await screen.findByText('出海圈 · 欢迎新主题')
  const [first, second] = screen.getAllByRole('switch').slice(1)
  fireEvent.click(first)
  await waitFor(() => expect(first).toBeDisabled())
  expect(second).toBeEnabled()
  release(rule())
  await waitFor(() => expect(first).toBeEnabled())

  mocks.patchKnowledgePlanetAutomationRule.mockRejectedValueOnce(new Error('规则已被删除'))
  fireEvent.click(second)
  expect(await screen.findByText('规则已被删除')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
})

test('文案:删除确认标题全角问号;写入能力提示不再指向已不存在的"上方"(KP-10 / KP-11)', async () => {
  const writeControl = account.writeControl ? { ...account.writeControl, enabled: false } : null
  renderPanel({ ...account, writeControl })
  await screen.findByText('出海圈 · 欢迎新主题')
  expect(
    screen.getByText('请先在插件账号里开启「写入能力」，再单独同意并开启无人值守自动回复。'),
  ).toBeInTheDocument()

  fireEvent.click(screen.getAllByRole('button', { name: /删除/ })[0])
  expect(await screen.findByText('删除规则「产品经理营 · 新提问自动答疑」？')).toBeInTheDocument()
})

test('纯函数:validateRuleDraft 报出错字段;validateAccountLimit 只认 1–30 的整数', () => {
  const base = {
    groupId: 'g1',
    name: '规则',
    instructions: '要求',
    triggerKind: 'new_topic' as const,
    dailyLimit: '5',
    cooldownMinutes: '15',
    maxReplyChars: '800',
  }
  expect(validateRuleDraft(base)).toMatchObject({ ok: true })
  expect(validateRuleDraft({ ...base, name: ' ' })).toMatchObject({ ok: false, field: 'name' })
  expect(validateRuleDraft({ ...base, instructions: '' })).toMatchObject({ ok: false, field: 'instructions' })
  expect(validateRuleDraft({ ...base, cooldownMinutes: '4' })).toMatchObject({ ok: false, field: 'cooldownMinutes' })
  expect(validateRuleDraft({ ...base, maxReplyChars: '99.5' })).toMatchObject({ ok: false, field: 'maxReplyChars' })

  expect(validateAccountLimit('10')).toEqual({ ok: true, value: 10 })
  expect(validateAccountLimit('')).toMatchObject({ ok: false })
  expect(validateAccountLimit('0')).toMatchObject({ ok: false })
  expect(validateAccountLimit('31')).toMatchObject({ ok: false })
  expect(validateAccountLimit('2.5')).toMatchObject({ ok: false })
})
