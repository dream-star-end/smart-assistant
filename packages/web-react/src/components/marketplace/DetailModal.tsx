import { isMarketplaceCategoryId, marketplaceCategoryLabel } from '@openclaude/protocol'
import {
  Activity,
  ArrowUpCircle,
  Download,
  Layers,
  Loader2,
  ShieldCheck,
  Target,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import { formatInstallCount, marketTrySkillPrefill } from '../../lib/marketplace'
import type {
  AuthSession,
  MarketplaceCapabilityReadiness,
  MarketplaceDetail,
  MarketplaceInstallResult,
  MarketplaceInstalled,
  MarketplaceMyAgent,
} from '../../lib/types'
import { AgentScopePicker, normalizeAgentScope } from '../AgentScopePicker'
import { Markdown } from '../Markdown'
import { Alert, Badge, Button, Modal } from '../ui'

/** 人向商品信息块(适用场景 / 效果示例 / 详细介绍)——description 之后、徽章行之前。 */
function StorefrontInfo({ detail }: { detail: MarketplaceDetail }) {
  const useCases = Array.isArray(detail.useCases) ? detail.useCases.filter((s) => s.trim()) : []
  const outcomes = Array.isArray(detail.outcomeExamples)
    ? detail.outcomeExamples.filter((s) => s.trim())
    : []
  const humanMd = detail.humanMd?.trim()
  if (useCases.length === 0 && outcomes.length === 0 && !humanMd) return null
  return (
    <div className="flex flex-col gap-3">
      {useCases.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <Layers size={13} /> 适用场景
          </div>
          <ul className="flex flex-col gap-1">
            {useCases.map((u, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-fg">
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
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <Target size={13} /> 能达成什么效果
          </div>
          <ul className="flex flex-col gap-1.5">
            {outcomes.map((o, i) => (
              <li
                key={i}
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12.5px] leading-relaxed text-fg"
              >
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}
      {humanMd && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">详细介绍</div>
          <div className="text-[13.5px] leading-relaxed text-fg">
            <Markdown>{humanMd}</Markdown>
          </div>
        </div>
      )}
    </div>
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
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted">模型</div>
          <Badge tone="neutral">{m.model || '平台默认'}</Badge>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted">能力（工具集）</div>
          <div className="flex flex-wrap gap-1">
            {toolsets.length ? (
              toolsets.map((t) => (
                <Badge key={t} tone="accent">
                  {TOOLSET_LABEL[t] ?? t}
                </Badge>
              ))
            ) : (
              <span className="text-[12px] text-faint">—</span>
            )}
          </div>
        </div>
      </div>
      {capabilities.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted">
            组合能力（{capabilities.length} 项，必需能力与智能体原子安装）
          </div>
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
          <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
            能力绑定用于组合与就绪检查，不是逐智能体的插件权限隔离；插件账号仍按当前用户授权。
          </p>
        </div>
      )}
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-muted">人设</div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 text-[12.5px] leading-relaxed text-fg">
          {m.persona || '（无）'}
        </pre>
      </div>
    </div>
  )
}

/** 附属文件查看:路径芯片 → 点击展开内容(安装前看清装的全部内容,含附属文件)。 */
function BundleFilesView({ bundle }: { bundle: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null)
  const paths = Object.keys(bundle).sort()
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-muted">附属文件（{paths.length}）</div>
      <div className="flex flex-wrap gap-1.5">
        {paths.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setOpen(open === p ? null : p)}
            className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
              open === p ? 'bg-accent-soft text-accent' : 'bg-hover text-muted hover:text-fg'
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      {open && (
        <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
          {bundle[open]}
        </pre>
      )}
    </div>
  )
}

/**
 * 市场条目详情 + 安装/更新确认。展示完整 SKILL.md(用户安装前看清「装的到底是什么」),
 * 一键安装；已安装但有新上架版本时给「更新」（复用 install 的幂等替换语义）。
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
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [scopeSaving, setScopeSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [installResult, setInstallResult] = useState<MarketplaceInstallResult | null>(null)
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([])
  const [scopeIds, setScopeIds] = useState<string[]>(['main'])
  const installedManualScopeKey = normalizeAgentScope(
    installed?.manualAgentIds ?? installed?.agentIds,
  ).join('\0')

  useEffect(() => {
    if (!slug) {
      setDetail(null)
      setErr(null)
      setDone(false)
      setInstallResult(null)
      return
    }
    let alive = true
    setLoading(true)
    setErr(null)
    setDone(false)
    setInstallResult(null)
    Promise.all([
      api.getMarketplaceDetail(auth, slug),
      api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[]),
    ])
      .then(([d, a]) => {
        if (!alive) return
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
      .catch((e) => alive && setErr(apiErrorMessage(e, '加载详情失败')))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [slug, auth])

  useEffect(() => {
    setScopeIds(installedManualScopeKey ? installedManualScopeKey.split('\0') : [])
  }, [installedManualScopeKey, slug])

  const install = async () => {
    if (!detail) return
    setInstalling(true)
    setErr(null)
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
      setDone(true)
      onInstalled()
      const managedBrowserAuthorization = result.needsAuthorization.find((slug) =>
        ['knowledge-planet', 'weibo'].includes(slug),
      )
      if (managedBrowserAuthorization) onOpenConnectors?.(managedBrowserAuthorization)
    } catch (e) {
      setErr(apiErrorMessage(e, '安装失败'))
    } finally {
      setInstalling(false)
    }
  }

  const saveScope = async () => {
    if (!detail) return
    setScopeSaving(true)
    setErr(null)
    try {
      await api.updateMarketplaceInstallAgents(auth, detail.slug, scopeIds)
      onInstalled()
      setDone(true)
    } catch (e) {
      setErr(apiErrorMessage(e, '保存归属失败'))
    } finally {
      setScopeSaving(false)
    }
  }

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
  const installNeedsAuthorizationCount = installResult?.needsAuthorization?.length ?? 0
  const installedCapabilityCount = installResult?.installedCapabilities?.length ?? 0
  const skippedOptionalCount = installResult?.skippedOptional?.length ?? 0
  const installNeedsAuthorization = installNeedsAuthorizationCount > 0
  const detailNeedsAuthorization = (detail?.capabilityReadiness?.needsAuthorization.length ?? 0) > 0

  return (
    <Modal
      open={!!slug}
      onOpenChange={(o) => !o && onClose()}
      title={detail?.name ?? '市场详情'}
      description={detail ? `${detail.slug} · v${detail.version}` : undefined}
      footer={
        detail && (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {/* AI 导购次级入口:关市场 → 新会话 → 预填「装好并给上手示例」,发送权仍在用户。 */}
            {onAskAiInChat && detail.kind !== 'connector' && (
              <Button
                variant="secondary"
                onClick={() => onAskAiInChat(marketTrySkillPrefill(detail.name, detail.slug))}
              >
                在对话中试用
              </Button>
            )}
            {isPreset || isPreinstalledConnector ? (
              <>
                <Badge tone="success" className="self-center">
                  <ShieldCheck size={13} />
                  {isPreinstalledConnector ? '官方 API 插件 · 已预装' : '平台预设 · 开箱即用'}
                </Badge>
                {isPreinstalledConnector && onOpenConnectors && (
                  <Button variant="primary" onClick={() => onOpenConnectors()}>
                    去绑定账号
                  </Button>
                )}
              </>
            ) : done ? (
              <Badge
                tone={isAgent && installNeedsAuthorization ? 'warning' : 'success'}
                className="self-center"
              >
                <ShieldCheck size={13} />{' '}
                {isAgent && installNeedsAuthorization
                  ? `${canUpdate ? '更新' : '安装'}完成 · Plugin 待授权`
                  : canUpdate
                    ? '更新成功'
                    : '安装成功'}
              </Badge>
            ) : canUpdate ? (
              <Button variant="primary" onClick={install} disabled={installing}>
                {installing ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <ArrowUpCircle size={15} />
                )}
                更新到 v{detail.version}
              </Button>
            ) : canRepair ? (
              <Button variant="primary" onClick={install} disabled={installing}>
                {installing && <Loader2 size={15} className="animate-spin" />}
                重新安装整包修复
              </Button>
            ) : scopeChanged ? (
              <Button variant="primary" onClick={saveScope} disabled={scopeSaving}>
                {scopeSaving && <Loader2 size={15} className="animate-spin" />}
                保存归属
              </Button>
            ) : installed ? (
              <Badge tone="success" className="self-center">
                <ShieldCheck size={13} /> 已安装
              </Badge>
            ) : (
              <Button variant="primary" onClick={install} disabled={installing}>
                {installing ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Download size={15} />
                )}
                安装
              </Button>
            )}
          </>
        )
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-faint">
          <Loader2 size={16} className="animate-spin" /> 加载详情…
        </div>
      ) : err && !detail ? (
        <Alert tone="danger">{err}</Alert>
      ) : detail ? (
        <div className="flex flex-col gap-3">
          {err && <Alert tone="danger">{err}</Alert>}
          {done && (
            <Alert
              tone={isAgent && installNeedsAuthorization ? 'warning' : 'success'}
              title={
                isAgent && installNeedsAuthorization
                  ? `${canUpdate ? '更新' : '安装'}完成，仍有 Plugin 待授权`
                  : canUpdate
                    ? '已更新'
                    : '已安装'
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {detail.kind === 'connector'
                    ? 'API 连接插件已加入你的能力库，请到管理中心绑定应用账号。'
                    : isAgent
                      ? installNeedsAuthorization
                        ? installResult?.ready
                          ? `智能体已经可用；另有 ${installNeedsAuthorizationCount} 项可选 Plugin 可在绑定账号后启用。`
                          : `智能体与能力已安装；完成 ${installNeedsAuthorizationCount} 项必需 Plugin 的账号授权后即可使用。`
                        : `智能体与 ${installedCapabilityCount} 项能力已完整安装，可在智能体选择器中切换。`
                      : '将在你的下一次会话中对 AI 可用。'}
                </span>
                {(detail.kind === 'connector' || (isAgent && installNeedsAuthorization)) &&
                  onOpenConnectors && (
                    <Button size="sm" variant="secondary" onClick={() => onOpenConnectors()}>
                      {isAgent ? '管理 Plugin 账号' : '去管理中心绑定'}
                    </Button>
                  )}
              </div>
              {isAgent && skippedOptionalCount > 0 && (
                <p className="mt-1 text-[12px]">
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
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {detailNeedsAuthorization
                      ? detail.capabilityReadiness.ready
                        ? `有 ${detail.capabilityReadiness.needsAuthorization.length} 个可选 Plugin 等待账号授权，不影响当前智能体使用。`
                        : `有 ${detail.capabilityReadiness.needsAuthorization.length} 个必需 Plugin 等待账号授权。`
                      : hasRepairableRequiredCapability
                        ? '存在未安装或版本失效的必需能力，可重新安装整包修复。'
                        : '必需能力已被下架或撤销，需等待平台恢复或发布者更新。'}
                  </span>
                  {detailNeedsAuthorization && onOpenConnectors && (
                    <Button size="sm" variant="secondary" onClick={() => onOpenConnectors()}>
                      管理 Plugin 账号
                    </Button>
                  )}
                </div>
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
            <Alert tone="info" title={`有新版本 v${detail.version}`}>
              该 Skill
              当前仅保留在能力库中、未分配给任何智能体。先选择智能体再更新，避免意外重新启用。
            </Alert>
          )}
          <p className="text-[13.5px] leading-relaxed text-fg">{detail.description}</p>

          {/* 人向商品信息:适用场景 / 效果示例 / 详细介绍(缺则整块不渲染) */}
          <StorefrontInfo detail={detail} />

          <div className="flex flex-wrap items-center gap-1.5">
            {isMarketplaceCategoryId(detail.category) && (
              <Badge tone="info">
                <Layers size={12} /> {marketplaceCategoryLabel(detail.category)}
              </Badge>
            )}
            {detail.tags.map((t) => (
              <Badge key={t} tone="accent">
                {t}
              </Badge>
            ))}
            {/* 真实使用信号(旧后端缺字段则整枚不渲染,优雅降级)。使用 > 安装,故
                优先呈现「近30天真的在用」的强信号,安装数作为弱信号如实标注为「已安装」。 */}
            {(detail.usage30d ?? 0) > 0 && (
              <Badge tone="neutral">
                <Activity size={12} /> 30天 {formatInstallCount(detail.usage30d)} 次使用
              </Badge>
            )}
            {(detail.users30d ?? 0) > 0 && (
              <Badge tone="neutral">
                <Users size={12} /> 30天 {formatInstallCount(detail.users30d)} 人在用
              </Badge>
            )}
            <Badge tone="neutral">
              <Download size={12} /> 已安装 {detail.installCount}
            </Badge>
            {/* 评分:服务端已保证样本≥5 才非 null(前端不做二次阈值)。中性徽章 + 诚实
                旁注「来自 N 次使用反馈」,不做背书式好评率大字。 */}
            {detail.rating && (
              <span className="inline-flex items-center gap-1">
                <Badge
                  tone="neutral"
                  title={`来自 ${detail.rating.up + detail.rating.down} 次使用反馈`}
                >
                  👍 {detail.rating.up}/{detail.rating.up + detail.rating.down}
                </Badge>
                <span className="text-[11px] text-faint">
                  来自 {detail.rating.up + detail.rating.down} 次使用反馈
                </span>
              </span>
            )}
            {detail.benchmark && (
              <Badge tone="info">
                实测 {Math.round(detail.benchmark.withoutPassRate * 100)}%→
                {Math.round(detail.benchmark.withPassRate * 100)}%（{detail.benchmark.cases}{' '}
                用例·发布者提供）
              </Badge>
            )}
          </div>

          {detail.rawBundle &&
            Object.keys(detail.rawBundle).some((p) => p.startsWith('scripts/')) && (
              <Alert tone="warning" title="含可执行脚本">
                该技能带{' '}
                {Object.keys(detail.rawBundle).filter((p) => p.startsWith('scripts/')).length}{' '}
                个脚本文件，安装后可能被智能体执行。{scriptReviewCopy(detail.reviewSource)}
                建议安装前点开逐个查看内容。
              </Alert>
            )}
          {detail.rawBundle && Object.keys(detail.rawBundle).length > 0 && (
            <BundleFilesView bundle={detail.rawBundle} />
          )}

          {detail.kind === 'skill' && !isPreset && (
            <AgentScopePicker
              agents={agents}
              selectedIds={scopeIds}
              onChange={setScopeIds}
              disabled={installing || scopeSaving}
              title="安装给哪些智能体"
              hint="默认全能助手，可多选。"
            />
          )}

          {detail.kind === 'agent' ? (
            // 智能体的 manifest 是「装的到底是什么」的核心,保持展开(不折叠)。
            <AgentManifestView manifest={detail.manifest} readiness={detail.capabilityReadiness} />
          ) : detail.kind === 'connector' ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
              <div className="text-[12px] font-medium text-muted">API 插件 · 平台已签安全范围</div>
              {detail.connectorContract ? (
                <>
                  <div className="text-[12.5px] text-fg">
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
                  <div className="text-[11.5px] leading-relaxed text-faint">
                    已批准网络：
                    {detail.connectorContract.approvedOrigins.join('、') || '无外部网络'}
                  </div>
                </>
              ) : (
                <span className="text-[12px] text-warning">
                  当前签名契约不可用，无法安装或绑定。
                </span>
              )}
              <details>
                <summary className="cursor-pointer text-[11.5px] text-faint">
                  查看发布者提交的技术声明
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-code px-3 py-2 font-mono text-[11.5px] text-fg">
                  {detail.rawArtifact}
                </pre>
              </details>
            </div>
          ) : (
            // 技能 SKILL.md 原文归模型、非人向 —— 默认折叠进「技术详情」,想看的人点开。
            <details className="rounded-lg border border-border bg-surface">
              <summary className="cursor-pointer select-none px-3 py-2 text-[12px] font-medium text-muted outline-none hover:text-fg">
                技术详情（SKILL.md 原文）
              </summary>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
                {detail.rawArtifact}
              </pre>
            </details>
          )}
        </div>
      ) : null}
    </Modal>
  )
}
