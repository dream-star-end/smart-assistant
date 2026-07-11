import { isMarketplaceCategoryId, marketplaceCategoryLabel } from '@openclaude/protocol'
import { Activity, ArrowUpCircle, Download, Layers, Loader2, ShieldCheck, Target, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import { formatInstallCount, marketTrySkillPrefill } from '../../lib/marketplace'
import type { AuthSession, MarketplaceDetail, MarketplaceInstalled, MarketplaceMyAgent } from '../../lib/types'
import { AgentScopePicker, normalizeAgentScope } from '../AgentScopePicker'
import { Markdown } from '../Markdown'
import { Alert, Badge, Button, Modal } from '../ui'
import { friendlyRiskFlags } from './riskFlags'

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
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
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

/** Friendly render of an agent manifest (model / toolsets / 依赖技能 / 人设). */
function AgentManifestView({ manifest }: { manifest: unknown }) {
  const m = (manifest ?? {}) as {
    model?: string
    toolsets?: string[]
    skillDeps?: string[]
    persona?: string
  }
  const toolsets = Array.isArray(m.toolsets) ? m.toolsets : []
  const deps = Array.isArray(m.skillDeps) ? m.skillDeps : []
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
      {deps.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted">
            依赖技能（安装时将一并加入 {deps.length} 个）
          </div>
          <div className="flex flex-wrap gap-1">
            {deps.map((d) => (
              <Badge key={d} tone="neutral">
                {d}
              </Badge>
            ))}
          </div>
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
}: {
  slug: string | null
  auth: AuthSession
  /** 已安装行(含 pin 的版本);未安装为 undefined。 */
  installed?: MarketplaceInstalled
  onClose: () => void
  onInstalled: () => void
  /** AI 导购(批3):「在对话中试用」——关市场 → 新会话 → 预填安装+上手示例;缺省不渲染。 */
  onAskAiInChat?: (text: string) => void
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [scopeSaving, setScopeSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([])
  const [scopeIds, setScopeIds] = useState<string[]>(['main'])

  useEffect(() => {
    if (!slug) {
      setDetail(null)
      setErr(null)
      setDone(false)
      return
    }
    let alive = true
    setLoading(true)
    setErr(null)
    setDone(false)
    Promise.all([api.getMarketplaceDetail(auth, slug), api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[])])
      .then(([d, a]) => {
        if (!alive) return
        setDetail(d)
        setAgents(a.length ? a : [{ id: 'main', slug: 'main', name: '全能助手', description: '', installed: true, isDefault: true }])
        setScopeIds(normalizeAgentScope(installed?.agentIds))
      })
      .catch((e) => alive && setErr((e as Error).message || '加载详情失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [slug, auth])

  useEffect(() => {
    setScopeIds(normalizeAgentScope(installed?.agentIds))
  }, [installed?.slug, installed?.agentIds?.join(',')])

  const install = async () => {
    if (!detail) return
    setInstalling(true)
    setErr(null)
    try {
      await api.installMarketplace(auth, detail.versionId, detail.kind === 'skill' ? scopeIds : undefined)
      setDone(true)
      onInstalled()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message || '安装失败')
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
      setErr(e instanceof ApiError ? e.message : (e as Error).message || '保存归属失败')
    } finally {
      setScopeSaving(false)
    }
  }

  const warns = friendlyRiskFlags(detail?.riskFlags)
  const isPreset = !!detail?.preset
  // detail.versionId 是当前上架版本(最新权威);已安装且 pin 的不是它 → 可更新。
  // 预设不走安装/更新语义(恒为最新上架版本,开箱即用)。
  const canUpdate = !isPreset && !!installed && !!detail && installed.versionId !== detail.versionId
  const isAgent = detail?.kind === 'agent'
  const scopeChanged =
    !!installed &&
    !!detail &&
    detail.kind === 'skill' &&
    normalizeAgentScope(installed.agentIds).join('\0') !== normalizeAgentScope(scopeIds).join('\0')

  return (
    <Modal
      open={!!slug}
      onOpenChange={(o) => !o && onClose()}
      title={detail?.name ?? '技能详情'}
      description={detail ? `${detail.slug} · v${detail.version}` : undefined}
      footer={
        detail && (
          <>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
            {/* AI 导购次级入口:关市场 → 新会话 → 预填「装好并给上手示例」,发送权仍在用户。 */}
            {onAskAiInChat && (
              <Button
                variant="secondary"
                onClick={() => onAskAiInChat(marketTrySkillPrefill(detail.name, detail.slug))}
              >
                在对话中试用
              </Button>
            )}
            {isPreset ? (
              <Badge tone="success" className="self-center">
                <ShieldCheck size={13} /> 平台预设 · 开箱即用
              </Badge>
            ) : done ? (
              <Badge tone="success" className="self-center">
                <ShieldCheck size={13} /> {canUpdate ? '更新成功' : '安装成功'}
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
            <Alert tone="success" title={canUpdate ? '已更新' : '已安装'}>
              {isAgent
                ? '可在输入框上方的智能体选择器中切换使用。'
                : '将在你的下一次会话中对 AI 可用。'}
            </Alert>
          )}
          {isPreset && (
            <Alert tone="info" title="平台预设智能体">
              无需安装,所有用户开箱即用;在输入框上方的智能体选择器中直接切换。
            </Alert>
          )}
          {!done && canUpdate && installed && (
            <Alert tone="info" title={`有新版本 v${detail.version}`}>
              你当前安装的是 v{installed.version}，更新后下一次会话生效。
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
                {Math.round(detail.benchmark.withPassRate * 100)}%（{detail.benchmark.cases} 用例·发布者提供）
              </Badge>
            )}
          </div>

          {warns.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {warns.map((w) => (
                <Alert key={w.label} tone={w.tone}>
                  <span className="font-medium">{w.label}：</span>
                  {w.message}
                </Alert>
              ))}
            </div>
          )}

          {detail.rawBundle &&
            Object.keys(detail.rawBundle).some((p) => p.startsWith('scripts/')) && (
              <Alert tone="warning" title="含可执行脚本">
                该技能带 {Object.keys(detail.rawBundle).filter((p) => p.startsWith('scripts/')).length}{' '}
                个脚本文件,安装后可能被智能体执行。脚本已过平台危险模式扫描与人工审核,
                但建议安装前点开逐个查看内容。
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
            <AgentManifestView manifest={detail.manifest} />
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
