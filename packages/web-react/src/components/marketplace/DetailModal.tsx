import { isMarketplaceCategoryId, marketplaceCategoryLabel } from '@openclaude/protocol'
import {
  Activity,
  ArrowUpCircle,
  Download,
  FileQuestion,
  FileText,
  Layers,
  type LucideIcon,
  ShieldCheck,
  Target,
  Terminal,
  Users,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import { reportClientFriction } from '../../lib/clientFriction'
import {
  benchmarkBadgeLabel,
  formatInstallCount,
  marketTrySkillPrefill,
} from '../../lib/marketplace'
import type {
  AuthSession,
  MarketplaceCapabilityReadiness,
  MarketplaceDetail,
  MarketplaceInstallResult,
  MarketplaceInstalled,
  MarketplaceMyAgent,
} from '../../lib/types'
import { cn } from '../../lib/utils'
import { AgentScopePicker, agentScopeLabels, normalizeAgentScope } from '../AgentScopePicker'
import { Markdown } from '../Markdown'
import { Alert, Badge, Button, EmptyState, Modal, Skeleton, cardVariants } from '../ui'

/**
 * 段标题 —— 全弹层只有三级字号:段标题(text-section semibold fg)/ 正文(text-body fg)/
 * 注脚(text-meta faint)。改造前正文区有 6 档任意像素值、段标题与正文几乎同大,整屏是
 * 一片均质灰字,读不出主次。
 */
function SectionTitle({
  icon: Icon,
  className,
  children,
}: {
  icon?: LucideIcon
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex items-center gap-1.5 text-section font-semibold text-fg', className)}>
      {Icon ? <Icon size={13} className="shrink-0 text-muted" aria-hidden="true" /> : null}
      <span>{children}</span>
    </div>
  )
}

/** 决策漏斗的一段。段间用分隔线而非等距 gap —— 读者要能看出「这里换了一件事」。 */
function Section({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('border-t border-border pt-3', className)}>{children}</section>
}

/** ② 它能帮你做什么:简介 + 适用场景 + 效果示例(缺则整块不渲染)。 */
function WhatItDoes({
  description,
  useCases,
  outcomes,
}: {
  description: string
  useCases: string[]
  outcomes: string[]
}) {
  return (
    <Section className="flex flex-col gap-3">
      <p className="text-section leading-relaxed text-fg">{description}</p>
      {useCases.length > 0 && (
        <div>
          <SectionTitle icon={Layers} className="mb-1.5">
            适用场景
          </SectionTitle>
          <ul className="flex flex-col gap-1">
            {useCases.map((u, i) => (
              <li key={i} className="flex gap-2 text-body leading-relaxed text-fg">
                <span
                  className="mt-1.5 size-1 shrink-0 rounded-full bg-accent"
                  aria-hidden="true"
                />
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcomes.length > 0 && (
        <div>
          <SectionTitle icon={Target} className="mb-1.5">
            能达成什么效果
          </SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {outcomes.map((o, i) => (
              <li
                key={i}
                className={cn(
                  cardVariants({ padding: 'sm', tone: 'sunken' }),
                  'text-body leading-relaxed text-fg',
                )}
              >
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

const TOOLSET_LABEL: Record<string, string> = {
  core: '核心',
  browser: '浏览器',
  research: '研究检索',
  web_context: '网页提取',
}

function scriptReviewCopy(source: MarketplaceDetail['reviewSource']): string {
  if (source === 'manual') return '已通过平台危险模式扫描与管理员人工审核。'
  if (source === 'ai') return '已通过平台危险模式扫描与 AI 自动审核。'
  if (source === 'platform') return '这是平台官方内容，已通过发布校验与危险模式扫描。'
  return '已通过平台危险模式扫描与发布审核。'
}

/** 恒显的审核背书徽章文案(正面信任信号,不外泄任何内部扫描诊断)。 */
function reviewBadgeLabel(source: MarketplaceDetail['reviewSource']): string {
  if (source === 'platform') return '平台官方'
  if (source === 'manual') return '人工审核'
  if (source === 'ai') return 'AI 审核'
  return '已过平台审核'
}

/**
 * 可滚动的原文块。嵌套滚动区必须能被键盘聚焦才滚得动(WCAG 2.1.1),故 tabIndex + 焦点环 +
 * 可读的无障碍名 —— 写法与 BrowsePanel 的横向分类条同构。
 */
function CodeScroll({
  id,
  label,
  className,
  preClassName,
  children,
}: {
  id?: string
  label: string
  className?: string
  preClassName?: string
  children: ReactNode
}) {
  return (
    <section
      id={id}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动的原文块必须能被键盘聚焦并滚动。
      tabIndex={0}
      className={cn(
        'overflow-auto rounded-lg border border-border bg-code outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        className,
      )}
    >
      <pre
        className={cn(
          'whitespace-pre-wrap break-words px-3 py-2 font-mono text-meta leading-relaxed text-fg',
          preClassName,
        )}
      >
        {children}
      </pre>
    </section>
  )
}

/** 字段标签(技术详情区内的键名),属「弱化」档,不与段标题争层级。 */
function FieldLabel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('text-meta font-medium text-muted', className)}>{children}</div>
}

/** Friendly render of an agent manifest (model / toolsets / 依赖技能 / 人设). */
function AgentManifestView({
  manifest,
  readiness,
}: {
  manifest: unknown
  readiness?: MarketplaceCapabilityReadiness
}) {
  const m = (manifest ?? {}) as {
    model?: string
    toolsets?: string[]
    capabilities?: Array<{ kind?: unknown; slug?: unknown; optional?: unknown }>
    skillDeps?: string[]
    persona?: string
  }
  const toolsets = Array.isArray(m.toolsets) ? m.toolsets : []
  const capabilities = Array.isArray(m.capabilities)
    ? m.capabilities.filter(
        (item): item is { kind: 'skill' | 'plugin'; slug: string; optional?: boolean } =>
          (item.kind === 'skill' || item.kind === 'plugin') && typeof item.slug === 'string',
      )
    : (Array.isArray(m.skillDeps) ? m.skillDeps : []).map((slug) => ({
        kind: 'skill' as const,
        slug,
        optional: false,
      }))
  const persona = m.persona?.trim()
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <FieldLabel className="mb-1">模型</FieldLabel>
          <Badge tone="neutral">{m.model || '平台默认'}</Badge>
        </div>
        {/* 无数据不占位不噪音:空工具集此前渲染一个孤零零的「—」,像加载失败。 */}
        {toolsets.length > 0 && (
          <div>
            <FieldLabel className="mb-1">能力（工具集）</FieldLabel>
            <div className="flex flex-wrap gap-1">
              {toolsets.map((t) => (
                <Badge key={t} tone="info">
                  {TOOLSET_LABEL[t] ?? t}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
      {capabilities.length > 0 && (
        <div>
          <FieldLabel className="mb-1">
            组合能力（{capabilities.length} 项，必需能力与智能体原子安装）
          </FieldLabel>
          <div className="flex flex-wrap gap-1">
            {capabilities.map((capability) => {
              const state = readiness?.requirements.find(
                (item) => item.kind === capability.kind && item.slug === capability.slug,
              )
              const stateLabel =
                state?.status === 'ready'
                  ? '已就绪'
                  : state?.status === 'needs_authorization'
                    ? '待授权'
                    : state?.status === 'revoked'
                      ? '已撤销'
                      : state?.status === 'missing'
                        ? '未安装'
                        : null
              return (
                <Badge
                  key={`${capability.kind}:${capability.slug}`}
                  tone={state?.status === 'ready' ? 'success' : stateLabel ? 'warning' : 'neutral'}
                >
                  {capability.kind === 'plugin' ? 'Plugin' : 'Skill'} · {capability.slug}
                  {capability.optional ? ' · 可选' : ' · 必需'}
                  {stateLabel ? ` · ${stateLabel}` : ''}
                </Badge>
              )
            })}
          </div>
          <p className="mt-1.5 text-meta leading-relaxed text-faint">
            能力绑定用于组合与就绪检查，不是逐智能体的插件权限隔离；插件账号仍按当前用户授权。
          </p>
        </div>
      )}
      {persona && (
        <div>
          <FieldLabel className="mb-1.5">人设</FieldLabel>
          <CodeScroll
            label="智能体人设原文"
            className="max-h-56"
            preClassName="font-sans text-body"
          >
            {persona}
          </CodeScroll>
        </div>
      )}
    </div>
  )
}

/**
 * 「包含内容」——附属文件清单与脚本风险合并成同一个视觉块:风险的醒目度由徽章与描边
 * 承担,可核实性由「点开即看」承担。改造前二者被拆成一条 warning Alert 和一排灰芯片,
 * 提示叫用户「逐个查看」却不提供入口。
 */
function BundleFilesView({
  bundle,
  reviewCopy,
}: {
  bundle: Record<string, string>
  reviewCopy: string
}) {
  const [open, setOpen] = useState<string | null>(null)
  // scripts/ 优先:风险最高的文件排在最前,用户不必自己在一堆等宽路径里辨认。
  const paths = Object.keys(bundle).sort((a, b) => {
    const sa = a.startsWith('scripts/') ? 0 : 1
    const sb = b.startsWith('scripts/') ? 0 : 1
    return sa === sb ? a.localeCompare(b) : sa - sb
  })
  const scriptCount = paths.filter((p) => p.startsWith('scripts/')).length
  return (
    <Section>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle icon={FileText}>包含内容（{paths.length} 个文件）</SectionTitle>
        {scriptCount > 0 && (
          <Badge tone="warning">
            <Terminal size={12} aria-hidden="true" />含 {scriptCount} 个可执行脚本
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {paths.map((p) => {
          const isScript = p.startsWith('scripts/')
          const active = open === p
          return (
            <Button
              key={p}
              size="sm"
              variant={active ? 'accent' : 'secondary'}
              aria-expanded={active}
              aria-controls={active ? 'bundle-file-view' : undefined}
              onClick={() => setOpen(active ? null : p)}
              className={cn(
                'max-w-full min-w-0 font-mono',
                isScript && !active && 'border-warning/50 text-warning',
              )}
            >
              {isScript && <Terminal size={12} className="shrink-0" aria-hidden="true" />}
              <span className="truncate">{p}</span>
            </Button>
          )
        })}
      </div>
      {open && (
        <CodeScroll id="bundle-file-view" label={`${open} 的文件内容`} className="mt-2 max-h-56">
          {bundle[open]}
        </CodeScroll>
      )}
      <p className="mt-1.5 text-meta leading-relaxed text-faint">
        {scriptCount > 0 ? (
          <>脚本会在智能体调用技能时执行；{reviewCopy}点开文件名可逐个查看内容。</>
        ) : (
          '点开文件名可查看每个文件的完整内容。'
        )}
      </p>
    </Section>
  )
}

/** 详情加载骨架:占住真实布局(徽章行 + 简介 + 正文块),避免 detail 到达时弹层上下弹跳。 */
function DetailSkeleton() {
  return (
    <output aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">加载详情…</span>
      <div className="flex flex-wrap gap-1.5">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </output>
  )
}

type LastAction = 'install' | 'update' | 'scope'

/** 装完必须去管理中心绑定账号的托管浏览器类插件。 */
const MANAGED_BROWSER_PLUGINS = ['knowledge-planet', 'weibo']

/**
 * 市场条目详情 + 安装/更新确认。展示完整 SKILL.md(用户安装前看清「装的到底是什么」),
 * 一键安装；已安装但有新上架版本时给「更新」（复用 install 的幂等替换语义）。
 *
 * 正文按**购买决策漏斗**排序,而不是按开发者调试顺序:
 * ① 身份与信任(官方/审核/分类/真实使用信号)→ ② 它能帮你做什么(简介 + 场景 + 效果)
 * → ③ 安装设置(归属)→ ④ 详细介绍(长 Markdown)→ 包含内容 → 技术详情。
 */
export function DetailModal({
  slug,
  auth,
  installed,
  onClose,
  onInstalled,
  onAskAiInChat,
  onOpenConnectors,
}: {
  slug: string | null
  auth: AuthSession
  /** 已安装行(含 pin 的版本);未安装为 undefined。 */
  installed?: MarketplaceInstalled
  onClose: () => void
  onInstalled: () => void
  /** AI 导购(批3):「在对话中试用」——关市场 → 新会话 → 预填安装+上手示例;缺省不渲染。 */
  onAskAiInChat?: (text: string) => void
  onOpenConnectors?: (pluginSlug?: string) => void
}) {
  // 加载态由 (!detail && !loadErr) 派生 —— 单一权威,避免 loading 与 detail 两个开关不同步
  // 时出现「转完圈还是空白」。
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null)
  /** 整块加载失败 —— 唯一允许占据正文顶部的错误。 */
  const [loadErr, setLoadErr] = useState<string | null>(null)
  /** 写操作失败 —— 必须贴在发起它的 footer 旁,否则用户在底部点完看不到任何变化。 */
  const [actionErr, setActionErr] = useState<{ message: string; retry: LastAction } | null>(null)
  const [installing, setInstalling] = useState(false)
  const [scopeSaving, setScopeSaving] = useState(false)
  const [lastAction, setLastAction] = useState<LastAction | null>(null)
  const [installResult, setInstallResult] = useState<MarketplaceInstallResult | null>(null)
  /** 安装结果里命中的托管浏览器插件 slug(成功后「去绑定账号」带上它)。 */
  const [pendingConnector, setPendingConnector] = useState<string | null>(null)
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([])
  const [scopeIds, setScopeIds] = useState<string[]>(['main'])
  const [reloadKey, setReloadKey] = useState(0)
  const scopeSectionRef = useRef<HTMLDivElement | null>(null)
  const installedManualScopeKey = normalizeAgentScope(
    installed?.manualAgentIds ?? installed?.agentIds,
  ).join('\0')

  useEffect(() => {
    if (!slug) {
      setDetail(null)
      setLoadErr(null)
      setActionErr(null)
      setLastAction(null)
      setInstallResult(null)
      setPendingConnector(null)
      return
    }
    let alive = true
    setDetail(null)
    setLoadErr(null)
    setActionErr(null)
    setLastAction(null)
    setInstallResult(null)
    setPendingConnector(null)
    Promise.all([
      api.getMarketplaceDetail(auth, slug),
      api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[]),
    ])
      .then(([d, a]) => {
        if (!alive) return
        reportClientFriction(
          {
            surface: 'marketplace',
            stage: 'detail_view',
            code: 'DETAIL_VIEW',
            outcome: 'succeeded',
            entitySlug: slug,
          },
          auth.snapshot().token,
        )
        setDetail(d)
        setAgents(
          a.length
            ? a
            : [
                {
                  id: 'main',
                  slug: 'main',
                  name: '全能助手',
                  description: '',
                  installed: true,
                  isDefault: true,
                },
              ],
        )
      })
      .catch((e) => alive && setLoadErr(apiErrorMessage(e, '加载详情失败')))
    return () => {
      alive = false
    }
  }, [slug, auth, reloadKey])

  useEffect(() => {
    setScopeIds(installedManualScopeKey ? installedManualScopeKey.split('\0') : [])
  }, [installedManualScopeKey, slug])

  const isPreset = !!detail?.preset
  const isPreinstalledConnector = detail?.kind === 'connector' && !!detail.preinstalled
  // detail.versionId 是当前上架版本(最新权威);已安装且 pin 的不是它 → 可更新。
  // 预设/预装不走安装/更新语义(恒为最新上架版本,开箱即用)。官方身份本身不阻断安装：
  // 知识星球等官方 Plugin 仍需要用户显式安装。
  const versionUpdateAvailable =
    !isPreset &&
    !isPreinstalledConnector &&
    !!installed &&
    !!detail &&
    installed.versionId !== detail.versionId
  const dormantSkill =
    detail?.kind === 'skill' && !!installed && normalizeAgentScope(installed.agentIds).length === 0
  const canUpdate = versionUpdateAvailable && (!dormantSkill || scopeIds.length > 0)
  const isAgent = detail?.kind === 'agent'
  const hasRepairableRequiredCapability =
    isAgent &&
    detail.capabilityReadiness?.requirements.some(
      (item) => !item.optional && item.repairable === true,
    ) === true
  const canRepair =
    !!installed &&
    isAgent &&
    detail.capabilityReadiness?.installed === true &&
    detail.capabilityReadiness.ready === false &&
    hasRepairableRequiredCapability &&
    !canUpdate
  const scopeChanged =
    !!installed &&
    !!detail &&
    detail.kind === 'skill' &&
    installedManualScopeKey !== normalizeAgentScope(scopeIds).join('\0')

  const install = async () => {
    if (!detail) return
    // 结果文案按「点击那一刻的意图」定,不受随后 installed 刷新导致的 canUpdate 翻转影响。
    const acting: LastAction = canUpdate ? 'update' : 'install'
    setInstalling(true)
    setActionErr(null)
    try {
      const preserveManualScope = detail.kind === 'skill' && !!installed && !scopeChanged
      const result = preserveManualScope
        ? await api.installMarketplace(
            auth,
            detail.versionId,
            normalizeAgentScope(installed.agentIds ?? installed.manualAgentIds),
            true,
          )
        : await api.installMarketplace(
            auth,
            detail.versionId,
            detail.kind === 'skill' ? scopeIds : undefined,
          )
      setInstallResult(result)
      setLastAction(acting)
      onInstalled()
      // 成功后**不再自动跳转**:改造前这里会无条件关掉整个市场跳去管理中心,成功提示
      // 一帧都看不到。绑定入口改为 footer 上一个显式的「去绑定账号」按钮,导航权还给用户。
      setPendingConnector(
        result.needsAuthorization.find((s) => MANAGED_BROWSER_PLUGINS.includes(s)) ?? null,
      )
    } catch (e) {
      setActionErr({ message: apiErrorMessage(e, '安装失败'), retry: acting })
    } finally {
      setInstalling(false)
    }
  }

  const saveScope = async () => {
    if (!detail) return
    setScopeSaving(true)
    setActionErr(null)
    try {
      await api.updateMarketplaceInstallAgents(auth, detail.slug, scopeIds)
      onInstalled()
      setLastAction('scope')
    } catch (e) {
      setActionErr({ message: apiErrorMessage(e, '保存归属失败'), retry: 'scope' })
    } finally {
      setScopeSaving(false)
    }
  }

  const done = lastAction !== null
  const installNeedsAuthorizationCount = installResult?.needsAuthorization?.length ?? 0
  const installedCapabilityCount = installResult?.installedCapabilities?.length ?? 0
  const skippedOptionalCount = installResult?.skippedOptional?.length ?? 0
  const installNeedsAuthorization = installNeedsAuthorizationCount > 0
  const detailNeedsAuthorization = (detail?.capabilityReadiness?.needsAuthorization.length ?? 0) > 0
  const scopeLabels = agentScopeLabels(scopeIds, agents)
  const rawUseCases = detail?.useCases
  const rawOutcomes = detail?.outcomeExamples
  const useCases = Array.isArray(rawUseCases) ? rawUseCases.filter((s) => s.trim()) : []
  const outcomes = Array.isArray(rawOutcomes) ? rawOutcomes.filter((s) => s.trim()) : []
  const humanMd = detail?.humanMd?.trim()
  const hasStorefront = useCases.length > 0 || outcomes.length > 0 || !!humanMd
  const bench = benchmarkBadgeLabel(detail?.benchmark)
  const ratingTotal = detail?.rating ? detail.rating.up + detail.rating.down : 0

  const scrollToScope = () => {
    scopeSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }

  /** done 态的下一步动作(connector 要绑账号 / Agent 要授权 Plugin);其余种类无强制下一步。 */
  const nextStep =
    onOpenConnectors && detail
      ? detail.kind === 'connector'
        ? {
            label: '去绑定账号',
            onClick: () => onOpenConnectors(pendingConnector ?? detail.slug),
          }
        : isAgent && installNeedsAuthorization
          ? { label: '管理 Plugin 账号', onClick: () => onOpenConnectors() }
          : null
      : null

  const successBadgeLabel =
    lastAction === 'scope'
      ? '归属已更新'
      : isAgent && installNeedsAuthorization
        ? `${lastAction === 'update' ? '更新' : '安装'}完成 · Plugin 待授权`
        : lastAction === 'update'
          ? '更新成功'
          : '安装成功'

  const primaryAction = (): ReactNode => {
    if (!detail) {
      if (loadErr)
        return (
          <Button variant="primary" onClick={() => setReloadKey((n) => n + 1)}>
            重新加载
          </Button>
        )
      // 底栏高度从第一帧就固定:改造前 footer 整块在 detail 到达后才长出来,居中弹层会跳一次。
      return <Skeleton className="h-10 w-28 rounded-lg" />
    }
    if (done)
      return (
        <>
          <Badge
            tone={isAgent && installNeedsAuthorization ? 'warning' : 'success'}
            className="self-center max-sm:justify-center"
          >
            <ShieldCheck size={13} /> {successBadgeLabel}
          </Badge>
          {nextStep && (
            <Button variant="primary" onClick={nextStep.onClick}>
              {nextStep.label}
            </Button>
          )}
        </>
      )
    if (isPreset) return null
    if (isPreinstalledConnector)
      return onOpenConnectors ? (
        <Button variant="primary" onClick={() => onOpenConnectors()}>
          去绑定账号
        </Button>
      ) : null
    if (canUpdate)
      return (
        <Button variant="primary" loading={installing} onClick={install}>
          {installing ? null : <ArrowUpCircle size={15} />}
          更新到 v{detail.version}
        </Button>
      )
    // 休眠 Skill(未分配给任何智能体)有新版本时:按钮常在、禁用可解释 —— 改造前顶部提示
    // 让用户「先选智能体再更新」,底部却连更新按钮都不渲染,提示指向一个不存在的控件。
    if (versionUpdateAvailable && dormantSkill)
      return (
        <Button variant="primary" disabled title="请先在下方「安装给哪些智能体」中至少选择一个">
          更新到 v{detail.version}
        </Button>
      )
    if (canRepair)
      return (
        <Button variant="primary" loading={installing} onClick={install}>
          重新安装整包修复
        </Button>
      )
    if (scopeChanged)
      return (
        <Button variant="primary" loading={scopeSaving} onClick={saveScope}>
          保存归属
        </Button>
      )
    if (installed)
      return (
        <Badge tone="success" className="self-center max-sm:justify-center">
          <ShieldCheck size={13} /> 已安装
        </Badge>
      )
    return (
      <Button variant="primary" loading={installing} onClick={install}>
        {installing ? null : <Download size={15} />}
        安装
      </Button>
    )
  }

  return (
    <Modal
      open={!!slug}
      onOpenChange={(o) => !o && onClose()}
      // 全站信息密度最高的弹层之一(富介绍 + 徽章行 + 双栏 manifest + 代码块),
      // 与同为「浏览并选择」的 AgentPicker 对齐到 lg(max-w-2xl)。
      size="lg"
      title={detail?.name ?? '市场详情'}
      description={detail ? `${detail.slug} · v${detail.version}` : undefined}
      footer={
        // 单个 flex item 拿满宽后可在内部分两行:第一行是就近的失败提示,第二行才是动作组。
        <div className="flex w-full flex-col gap-2">
          {actionErr && (
            <Alert
              tone="danger"
              density="compact"
              title="操作没有完成"
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => (actionErr.retry === 'scope' ? saveScope() : install())}
                >
                  重试
                </Button>
              }
              onDismiss={() => setActionErr(null)}
            >
              {actionErr.message}
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 max-sm:flex-col-reverse max-sm:flex-nowrap max-sm:[&>*]:w-full">
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {/* AI 导购次级入口:关市场 → 新会话 → 预填「装好并给上手示例」,发送权仍在用户。 */}
            {onAskAiInChat && detail && detail.kind !== 'connector' && (
              <Button
                variant="secondary"
                onClick={() => onAskAiInChat(marketTrySkillPrefill(detail.name, detail.slug))}
              >
                在对话中试用
              </Button>
            )}
            {primaryAction()}
          </div>
        </div>
      }
    >
      {!detail && !loadErr ? (
        <DetailSkeleton />
      ) : loadErr && !detail ? (
        <Alert
          tone="danger"
          title="详情没能加载出来"
          action={
            <Button size="sm" variant="secondary" onClick={() => setReloadKey((n) => n + 1)}>
              重新加载
            </Button>
          }
        >
          {loadErr}
        </Alert>
      ) : detail ? (
        <div className="flex flex-col gap-3">
          {done && (
            <Alert
              tone={isAgent && installNeedsAuthorization ? 'warning' : 'success'}
              title={
                lastAction === 'scope'
                  ? '已更新归属'
                  : isAgent && installNeedsAuthorization
                    ? `${lastAction === 'update' ? '更新' : '安装'}完成，仍有 Plugin 待授权`
                    : lastAction === 'update'
                      ? '已更新'
                      : '已安装'
              }
            >
              <span>
                {lastAction === 'scope'
                  ? scopeLabels.length > 0
                    ? `现在由 ${scopeLabels.join('、')} 使用，下一次会话生效。`
                    : '已从所有智能体上移除，技能仍保留在能力库中。'
                  : detail.kind === 'connector'
                    ? 'API 连接插件已加入你的能力库，请到管理中心绑定应用账号。'
                    : isAgent
                      ? installNeedsAuthorization
                        ? installResult?.ready
                          ? `智能体已经可用；另有 ${installNeedsAuthorizationCount} 项可选 Plugin 可在绑定账号后启用。`
                          : `智能体与能力已安装；完成 ${installNeedsAuthorizationCount} 项必需 Plugin 的账号授权后即可使用。`
                        : `智能体与 ${installedCapabilityCount} 项能力已完整安装，可在智能体选择器中切换。`
                      : '将在你的下一次会话中对 AI 可用。'}
              </span>
              {isAgent && skippedOptionalCount > 0 && (
                <p className="mt-1 text-meta">
                  已明确跳过 {skippedOptionalCount} 项当前不可用的可选能力。
                </p>
              )}
            </Alert>
          )}
          {!done &&
            isAgent &&
            detail.capabilityReadiness?.installed &&
            (!detail.capabilityReadiness.ready || detailNeedsAuthorization) && (
              <Alert
                tone="warning"
                title={
                  detail.capabilityReadiness.ready
                    ? '该智能体可用，仍有可选 Plugin 待授权'
                    : '该智能体尚未完全就绪'
                }
                action={
                  detailNeedsAuthorization && onOpenConnectors ? (
                    <Button size="sm" variant="secondary" onClick={() => onOpenConnectors()}>
                      管理 Plugin 账号
                    </Button>
                  ) : undefined
                }
              >
                {detailNeedsAuthorization
                  ? detail.capabilityReadiness.ready
                    ? `有 ${detail.capabilityReadiness.needsAuthorization.length} 个可选 Plugin 等待账号授权，不影响当前智能体使用。`
                    : `有 ${detail.capabilityReadiness.needsAuthorization.length} 个必需 Plugin 等待账号授权。`
                  : hasRepairableRequiredCapability
                    ? '存在未安装或版本失效的必需能力，可重新安装整包修复。'
                    : '必需能力已被下架或撤销，需等待平台恢复或发布者更新。'}
              </Alert>
            )}
          {isPreset && (
            <Alert tone="info" title="平台预设智能体">
              无需安装,所有用户开箱即用;在输入框上方的智能体选择器中直接切换。
            </Alert>
          )}
          {isPreinstalledConnector && (
            <Alert tone="info" title="官方预装 API 插件">
              无需安装；可直接到管理中心绑定你的应用账号。
            </Alert>
          )}
          {!done && canUpdate && installed && (
            <Alert tone="info" title={`有新版本 v${detail.version}`}>
              你当前安装的是 v{installed.version}，更新后下一次会话生效。
            </Alert>
          )}
          {!done && versionUpdateAvailable && dormantSkill && scopeIds.length === 0 && (
            <Alert
              tone="info"
              title={`有新版本 v${detail.version}`}
              action={
                <Button size="sm" variant="secondary" onClick={scrollToScope}>
                  去选择智能体
                </Button>
              }
            >
              该 Skill
              当前仅保留在能力库中、未分配给任何智能体。先选择智能体再更新，避免意外重新启用。
            </Alert>
          )}

          {/* ① 身份与信任 + 真实使用信号:驱动「装不装」的东西必须紧贴标题,不能压在长介绍之后。
              色彩预算按语义分配:身份/信任 success、分类 info、标签与统计一律 neutral。 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {isPreset && (
                <Badge tone="success">
                  <ShieldCheck size={12} aria-hidden="true" />
                  平台预设 · 开箱即用
                </Badge>
              )}
              {isPreinstalledConnector ? (
                <Badge tone="success">
                  <ShieldCheck size={12} aria-hidden="true" />
                  官方 API 插件 · 已预装
                </Badge>
              ) : detail.official ? (
                <Badge tone="success">
                  <ShieldCheck size={12} aria-hidden="true" />
                  官方
                </Badge>
              ) : null}
              <Badge tone="neutral" title={scriptReviewCopy(detail.reviewSource)}>
                <ShieldCheck size={12} aria-hidden="true" />
                {reviewBadgeLabel(detail.reviewSource)}
              </Badge>
              {isMarketplaceCategoryId(detail.category) && (
                <Badge tone="info">
                  <Layers size={12} aria-hidden="true" />{' '}
                  {marketplaceCategoryLabel(detail.category)}
                </Badge>
              )}
              {detail.tags.map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
              {/* 真实使用信号(旧后端缺字段则整枚不渲染,优雅降级)。使用 > 安装,故
                  优先呈现「近30天真的在用」的强信号,安装数作为弱信号如实标注为「已安装」。 */}
              {(detail.usage30d ?? 0) > 0 && (
                <Badge tone="neutral">
                  <Activity size={12} aria-hidden="true" /> 30天{' '}
                  {formatInstallCount(detail.usage30d)} 次使用
                </Badge>
              )}
              {(detail.users30d ?? 0) > 0 && (
                <Badge tone="neutral">
                  <Users size={12} aria-hidden="true" /> 30天 {formatInstallCount(detail.users30d)}{' '}
                  人在用
                </Badge>
              )}
              <Badge tone="neutral">
                <Download size={12} aria-hidden="true" /> 已安装 {detail.installCount}
              </Badge>
              {/* 评分:服务端已保证样本≥5 才非 null(前端不做二次阈值),不做背书式好评率大字。 */}
              {detail.rating && (
                <Badge
                  tone="neutral"
                  title={`来自 ${ratingTotal} 次使用反馈`}
                  aria-label={`好评 ${detail.rating.up}，共 ${ratingTotal} 次反馈`}
                >
                  👍 {detail.rating.up}/{ratingTotal}
                </Badge>
              )}
              {bench && (
                <Badge tone="info" title={bench.title}>
                  {bench.label}
                </Badge>
              )}
            </div>
            {/* 免责与出处落地成明文注脚 —— 详情页正是用户最容易把自报数据当平台背书的地方。 */}
            {(detail.rating || bench) && (
              <div className="flex flex-col gap-0.5">
                {detail.rating && (
                  <p className="text-meta text-faint">来自 {ratingTotal} 次使用反馈</p>
                )}
                {bench && detail.benchmark && (
                  <p className="text-meta text-faint">
                    实测 {detail.benchmark.cases} 个用例，由发布者提供、未经平台验证
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ② 它能帮你做什么 */}
          <WhatItDoes description={detail.description} useCases={useCases} outcomes={outcomes} />

          {/* ③ 安装设置:安装动作的参数,紧跟在「要不要装」的判断之后 */}
          {detail.kind === 'skill' && !isPreset && (
            <Section>
              <div ref={scopeSectionRef}>
                <AgentScopePicker
                  agents={agents}
                  selectedIds={scopeIds}
                  onChange={setScopeIds}
                  disabled={installing || scopeSaving}
                  title="安装给哪些智能体"
                  hint="默认全能助手，可多选。"
                />
              </div>
            </Section>
          )}

          {/* ④ 详细介绍(长 Markdown 放在决策信息之后) */}
          {humanMd && (
            <Section>
              <SectionTitle className="mb-1.5">详细介绍</SectionTitle>
              <div className="text-body leading-relaxed text-fg">
                <Markdown>{humanMd}</Markdown>
              </div>
            </Section>
          )}

          {detail.rawBundle && Object.keys(detail.rawBundle).length > 0 && (
            <BundleFilesView
              bundle={detail.rawBundle}
              reviewCopy={scriptReviewCopy(detail.reviewSource)}
            />
          )}

          {detail.kind === 'agent' ? (
            // 智能体的 manifest 是「装的到底是什么」的核心,保持展开(不折叠)。
            <Section>
              <SectionTitle className="mb-2">技术详情</SectionTitle>
              <AgentManifestView
                manifest={detail.manifest}
                readiness={detail.capabilityReadiness}
              />
            </Section>
          ) : detail.kind === 'connector' ? (
            <Section>
              <SectionTitle className="mb-1.5">API 插件 · 平台已签安全范围</SectionTitle>
              <div
                className={cn(
                  cardVariants({ padding: 'sm', tone: 'sunken' }),
                  'flex flex-col gap-2',
                )}
              >
                {detail.connectorContract ? (
                  <>
                    <div className="text-body text-fg">
                      认证方式：{detail.connectorContract.authMode}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {detail.connectorContract.actions.map((a) => (
                        <Badge key={a.id} tone={a.effect === 'read' ? 'neutral' : 'warning'}>
                          {a.id} ·{' '}
                          {a.effect === 'read' ? '读取' : a.effect === 'send' ? '发送' : '写入'}
                        </Badge>
                      ))}
                    </div>
                    <div className="text-meta leading-relaxed text-faint">
                      已批准网络：
                      {detail.connectorContract.approvedOrigins.join('、') || '无外部网络'}
                    </div>
                  </>
                ) : (
                  <span className="text-meta text-warning">
                    当前签名契约不可用，无法安装或绑定。
                  </span>
                )}
                <details>
                  {/* 触控档只加 min-h + py,**不**套 flex/list-none:这几处折叠区靠原生
                      marker(三角)指示"可展开",去掉它就只剩一行看不出能点的文字。
                      summary 是 list-item,min-height 照常生效,整行可点。 */}
                  <summary className="cursor-pointer rounded-md text-meta text-faint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-2">
                    查看发布者提交的技术声明
                  </summary>
                  <CodeScroll label="发布者提交的技术声明" className="mt-2 max-h-72">
                    {detail.rawArtifact}
                  </CodeScroll>
                </details>
              </div>
            </Section>
          ) : detail.rawArtifact?.trim() ? (
            // 技能 SKILL.md 原文归模型、非人向 —— 默认折叠进「技术详情」,想看的人点开;
            // 但发布者一句商品介绍都没写时,不能让用户对着空白弹层做决定 → 默认展开原文。
            <Section>
              <details
                open={!hasStorefront}
                className={cn(cardVariants({ tone: 'sunken' }), 'overflow-hidden')}
              >
                <summary className="cursor-pointer select-none rounded-md px-3 py-2 text-section font-semibold text-fg outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-3">
                  {hasStorefront
                    ? '技术详情（SKILL.md 原文）'
                    : '技能说明（发布者未填写商品介绍，以下为原文）'}
                </summary>
                <CodeScroll
                  label="SKILL.md 原文"
                  className="max-h-72 rounded-none border-x-0 border-b-0"
                >
                  {detail.rawArtifact}
                </CodeScroll>
              </details>
            </Section>
          ) : !hasStorefront ? (
            // 连原文都没有:空态必须给出口,而不是把用户留在一屏空白里。
            <Section>
              <EmptyState
                icon={FileQuestion}
                title="发布者暂未提供介绍"
                hint="你仍可以先安装，或让 AI 在对话里带你上手。"
                action={
                  onAskAiInChat ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onAskAiInChat(marketTrySkillPrefill(detail.name, detail.slug))}
                    >
                      在对话中试用
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={onClose}>
                      返回市场
                    </Button>
                  )
                }
              />
            </Section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
