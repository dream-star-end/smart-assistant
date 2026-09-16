/**
 * 「AI 市场」审计补充场景（2026-09 A·market 审计 · 只增不改既有 scenes-market.tsx）。
 *
 * 既有 scenes-market.tsx 覆盖四个 Tab 的首屏三态与详情 / 精选管理，但只有「发现 · 技能」
 * 「发布 · 技能表单」给了移动端视口，且没有任何**点一下才到达的状态**（安装成功 / 安装失败 /
 * 卸载确认 / 归属编辑 / 分类筛选 / 加载更多 / 表单校验 / 批量选择 / 拒绝理由）。本文件补三类：
 *  1. 其余首屏场景的移动端视口（直接派生既有场景对象，同一份 mock）；
 *  2. 安装 / 更新 / 卸载 / 发布 / 审核这些**写动作的反馈态**；
 *  3. 长列表（60 张卡 → 「加载更多」翻页）与未登录空态。
 *
 * 二级状态靠 <AutoClick> 在挂载后按顺序模拟点击到达（预览台是静态挂载，没有交互驱动）。
 */
import { type ReactNode, useEffect } from 'react'

import { MarketplaceCenter } from '../../src/components/MarketplaceCenter'
import type { MarketplaceCard } from '../../src/lib/types'
import { ApiError } from './api-stub'
// 带扩展名：shoot.mjs 的 scene-groups 插件会把裸的 `./scenes-market` 重定向到虚拟聚合模块，
// 这里要的是那份真实文件里导出的场景数组。
import { marketScenes } from './scenes-market.tsx'
import type { ApiMockTable, Scene } from './types'

// ── 通用工具 ────────────────────────────────────────────────────────────────

const fail = (status: number, message: string, code?: string) => () =>
  Promise.reject(new ApiError({ status, message, code, requestId: 'req_audit_9b3e2c11' }))

/** 挂载后按顺序模拟点击（selector 或按钮文案子串），把静态预览台推进到二级状态。 */
type ClickStep = { selector?: string; text?: string; delay?: number }

function findClickTarget(step: ClickStep): HTMLElement | null {
  if (step.selector) return document.querySelector<HTMLElement>(step.selector)
  if (step.text) {
    const candidates = [...document.querySelectorAll<HTMLElement>('button,[role="tab"],label')]
    // 先找全等（「拒绝」不能命中前面的「批量拒绝」），再退回子串。
    return (
      candidates.find((el) => el.textContent?.trim() === step.text) ??
      candidates.find((el) => el.textContent?.includes(step.text ?? '')) ??
      null
    )
  }
  return null
}

function AutoClick({ steps, children }: { steps: ClickStep[]; children: ReactNode }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 步骤表是场景常量，只在挂载时跑一次
  useEffect(() => {
    let cancelled = false
    const timers: number[] = []
    let at = 0
    for (const step of steps) {
      at += step.delay ?? 220
      // 数据异步到达：每一步都轮询到目标出现为止（最多 3s），不依赖固定等待。
      const scheduled = at
      const poll = (round: number) => {
        if (cancelled) return
        const target = findClickTarget(step)
        if (target) {
          target.click()
          return
        }
        if (round < 60) timers.push(window.setTimeout(() => poll(round + 1), 50))
        else console.warn('[audit-scene] 点击目标未找到', step)
      }
      timers.push(window.setTimeout(() => poll(0), scheduled))
    }
    return () => {
      cancelled = true
      for (const t of timers) window.clearTimeout(t)
    }
  }, [])
  return <>{children}</>
}

function baseScene(id: string): Scene {
  const scene = marketScenes.find((s) => s.id === id)
  if (!scene) throw new Error(`scenes-market-audit: 找不到既有场景 ${id}`)
  return scene
}

/** 派生既有场景的移动端视口（同一份 mock，只换视口）。 */
function mobileOnly(id: string): Scene {
  const base = baseScene(id)
  return {
    ...base,
    id: `${id}-mobile`,
    label: `${base.label} · 移动端`,
    viewports: ['mobile'],
  }
}

/** 在既有场景之上叠加点击步骤 / 打桩覆盖，得到一个二级状态场景。 */
function derive(
  id: string,
  over: {
    id: string
    label: string
    steps?: ClickStep[]
    api?: ApiMockTable
    viewports?: Scene['viewports']
  },
): Scene {
  const base = baseScene(id)
  return {
    id: over.id,
    label: over.label,
    group: '市场',
    viewports: over.viewports ?? ['desktop', 'mobile'],
    api: { ...base.api, ...(over.api ?? {}) },
    render: () =>
      over.steps ? <AutoClick steps={over.steps}>{base.render()}</AutoClick> : base.render(),
  }
}

// ── 长列表：60 张技能卡，覆盖全部分类，装满一页（PAGE_SIZE=50）触发「加载更多」 ──

const LONG_CATEGORIES = [
  'office-docs',
  'data-analysis',
  'coding-dev',
  'research-academic',
  'design-creative',
  'finance-business',
  'daily-tools',
  'skill-pack',
] as const
const LONG_NAMES = [
  '周报自动汇总',
  'Excel 清洗与透视',
  '接口联调助手',
  '文献综述起草',
  '海报排版建议',
  '行业研报速读',
  '会议纪要整理',
  '技能包 · 内容运营全家桶',
]

function longListCards(total: number): MarketplaceCard[] {
  const cards: MarketplaceCard[] = []
  for (let i = 0; i < total; i += 1) {
    const cat = LONG_CATEGORIES[i % LONG_CATEGORIES.length]
    const base = LONG_NAMES[i % LONG_NAMES.length]
    cards.push({
      slug: `long-${cat}-${String(i + 1).padStart(2, '0')}`,
      kind: 'skill',
      name:
        i % 7 === 0
          ? `${base}（增强版 · 支持批量与定时，输出可直接投递到群聊）`
          : `${base} ${i + 1}`,
      description:
        i % 5 === 0
          ? '把一周内的会话产出、待办与阻塞项按项目归并成一页周报，附上下周计划；支持自定义模板与飞书 / 钉钉投递。'
          : '按模板整理输入，产出结构化结果。',
      tags: i % 3 === 0 ? ['效率', '模板', '团队'] : ['效率'],
      installCount: (i * 137) % 2600,
      category: cat,
      featuredRank: i < 2 ? i + 1 : null,
      users30d: i % 4 === 0 ? (i * 31) % 900 : 0,
      rating: i % 6 === 0 ? { up: 40 + i, down: 3 } : null,
      benchmark: i % 9 === 0 ? { withPassRate: 0.86, withoutPassRate: 0.52, cases: 5 } : null,
    })
  }
  return cards
}

const LONG_CARDS = longListCards(60)

/** 与 BrowsePanel 的 searchMarketplace(auth, q, kind, limit) 签名一致，按 limit 截断。 */
const longListSearch = async (_auth: unknown, _q = '', kind = 'skill', limit = 50) => ({
  results: kind === 'skill' ? LONG_CARDS.slice(0, limit) : ([] as MarketplaceCard[]),
  method: 'all' as const,
})

// ── 未登录 ─────────────────────────────────────────────────────────────────

function UnauthMarket() {
  return (
    <MarketplaceCenter
      open
      tab="browse"
      auth={null}
      isAdmin={false}
      onTabChange={() => {}}
      onClose={() => {}}
    />
  )
}

// ── 场景 ────────────────────────────────────────────────────────────────────

export const marketAuditScenes: Scene[] = [
  // ── 移动端视口补齐（复用既有 mock） ──
  mobileOnly('market-browse-agent'),
  mobileOnly('market-browse-plugin'),
  mobileOnly('market-browse-search'),
  mobileOnly('market-browse-empty'),
  mobileOnly('market-browse-error'),
  mobileOnly('market-detail'),
  mobileOnly('market-detail-risky'),
  mobileOnly('market-detail-agent'),
  mobileOnly('market-installed'),
  mobileOnly('market-installed-empty'),
  mobileOnly('market-publish-list'),
  mobileOnly('market-publish-agent'),
  mobileOnly('market-publish-plugin'),
  mobileOnly('market-review'),
  mobileOnly('market-review-detail'),

  // ── 发现：分类筛选 / 长列表翻页 ──
  derive('market-browse-skill', {
    id: 'market-browse-category',
    label: '发现 · 选中一个分类筛选片（平铺该类 + 返回全部）',
    steps: [{ selector: 'section[aria-label^="市场分类"] button:nth-of-type(2)', delay: 500 }],
  }),
  derive('market-browse-skill', {
    id: 'market-browse-longlist',
    label: '发现 · 长列表（60 条，首页装满 50 → 底部「加载更多」）',
    api: { searchMarketplace: longListSearch },
  }),
  derive('market-browse-skill', {
    id: 'market-browse-longlist-more',
    label: '发现 · 长列表点过「加载更多」（全部 60 条到位，按钮消失）',
    api: { searchMarketplace: longListSearch },
    steps: [{ text: '加载更多', delay: 700 }],
  }),

  // ── 详情：安装成功 / 安装失败 ──
  derive('market-detail', {
    id: 'market-detail-install-done',
    label: '详情 · 点「安装」成功后的完成态（顶部 Alert + 底栏徽章）',
    steps: [{ selector: '[role="dialog"] button.bg-primary', delay: 500 }],
  }),
  derive('market-detail', {
    id: 'market-detail-install-error',
    label: '详情 · 安装失败（错误贴在 footer 旁，可重试）',
    api: {
      installMarketplace: fail(409, '该版本已不是当前上架版本，请刷新后重试', 'VERSION_STALE'),
    },
    steps: [{ selector: '[role="dialog"] button.bg-primary', delay: 500 }],
  }),

  // ── 已安装：卸载确认 / 归属编辑 ──
  derive('market-installed', {
    id: 'market-installed-uninstall',
    label: '已安装 · 卸载确认弹层（原因选择）',
    steps: [{ selector: 'button[aria-label="卸载"]', delay: 500 }],
  }),
  derive('market-installed', {
    id: 'market-installed-scope',
    label: '已安装 · 修改技能归属弹层',
    steps: [{ text: '归属', delay: 500 }],
  }),

  // ── 发布：空表单直接提交 → 校验定位 ──
  derive('market-publish', {
    id: 'market-publish-validation',
    label: '发布 · 空表单点「发布到市场」（缺项播报 + 首个字段错误）',
    steps: [{ text: '发布到市场', delay: 500 }],
  }),

  // ── 审核：全选进入批量态 / 拒绝理由输入框 ──
  derive('market-review', {
    id: 'market-review-batch',
    label: '审核 · 全选后的批量条（含 API 插件不能批量批准的提示）',
    steps: [{ text: '全选', delay: 500 }],
  }),
  derive('market-review', {
    id: 'market-review-reject',
    label: '审核 · 点「拒绝」弹出理由输入框',
    steps: [{ text: '拒绝', delay: 500 }],
  }),

  // ── 未登录 ──
  {
    id: 'market-unauth',
    label: '未登录 · 空态与出口',
    group: '市场',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <UnauthMarket />,
  },
]
