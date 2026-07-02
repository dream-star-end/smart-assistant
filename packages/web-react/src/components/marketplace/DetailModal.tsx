import { ArrowUpCircle, Download, Loader2, ShieldCheck, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError, api } from '../../lib/api'
import type { AuthSession, MarketplaceDetail, MarketplaceInstalled } from '../../lib/types'
import { Alert, Badge, Button, Modal } from '../ui'
import { friendlyRiskFlags } from './riskFlags'

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
}: {
  slug: string | null
  auth: AuthSession
  /** 已安装行(含 pin 的版本);未安装为 undefined。 */
  installed?: MarketplaceInstalled
  onClose: () => void
  onInstalled: () => void
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [done, setDone] = useState(false)

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
    api
      .getMarketplaceDetail(auth, slug)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setErr((e as Error).message || '加载详情失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [slug, auth])

  const install = async () => {
    if (!detail) return
    setInstalling(true)
    setErr(null)
    try {
      await api.installMarketplace(auth, detail.versionId)
      setDone(true)
      onInstalled()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message || '安装失败')
    } finally {
      setInstalling(false)
    }
  }

  const warns = friendlyRiskFlags(detail?.riskFlags)
  const isPreset = !!detail?.preset
  // detail.versionId 是当前上架版本(最新权威);已安装且 pin 的不是它 → 可更新。
  // 预设不走安装/更新语义(恒为最新上架版本,开箱即用)。
  const canUpdate = !isPreset && !!installed && !!detail && installed.versionId !== detail.versionId
  const isAgent = detail?.kind === 'agent'

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

          <div className="flex flex-wrap items-center gap-1.5">
            {detail.tags.map((t) => (
              <Badge key={t} tone="accent">
                {t}
              </Badge>
            ))}
            <Badge tone="neutral">
              <Users size={12} /> {detail.installCount} 人在用
            </Badge>
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

          {detail.kind === 'agent' ? (
            <AgentManifestView manifest={detail.manifest} />
          ) : (
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted">完整内容（SKILL.md）</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
                {detail.rawArtifact}
              </pre>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  )
}
