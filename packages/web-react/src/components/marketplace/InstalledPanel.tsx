import {
  AlertTriangle,
  ArrowUpCircle,
  Bot,
  type LucideIcon,
  PackageOpen,
  Plug,
  Settings2,
  Trash2,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import { updateAvailable } from '../../lib/marketplace'
import type { AuthSession, MarketplaceInstalled, MarketplaceMyAgent } from '../../lib/types'
import { cn } from '../../lib/utils'
import { AgentScopePicker, AgentScopeSummary, normalizeAgentScope } from '../AgentScopePicker'
import {
  Alert,
  Badge,
  Button,
  CardRow,
  EmptyState,
  Field,
  IconButton,
  ListSkeleton,
  Modal,
  PanelHeader,
  Select,
  TimeAgo,
  Tooltip,
  useToast,
} from '../ui'

type UninstallReason =
  | 'not_needed'
  | 'poor_quality'
  | 'missing_capability'
  | 'install_error'
  | 'other'
  | 'prefer_not_say'

const UNINSTALL_REASON_OPTIONS: Array<{ value: UninstallReason; label: string }> = [
  { value: 'prefer_not_say', label: '不说明' },
  { value: 'not_needed', label: '暂时不需要' },
  { value: 'poor_quality', label: '效果不好' },
  { value: 'missing_capability', label: '缺少我需要的能力' },
  { value: 'install_error', label: '安装或使用有问题' },
  { value: 'other', label: '其他' },
]

/** 种类 → 图标芯片配色。改造前 skill 与 agent 共用同一枚绿色 ShieldCheck,列表里分不出种类。 */
const KIND_CHIP: Record<string, { icon: LucideIcon; className: string }> = {
  agent: { icon: Bot, className: 'bg-accent-soft text-accent' },
  skill: { icon: Wrench, className: 'bg-info-soft text-info' },
  connector: { icon: Plug, className: 'bg-hover text-muted' },
}

function KindChip({ kind, revoked }: { kind: string; revoked?: boolean }) {
  const chip = KIND_CHIP[kind] ?? KIND_CHIP.skill
  const Icon = revoked ? AlertTriangle : chip.icon
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg',
        revoked ? 'bg-warning-soft text-warning' : chip.className,
      )}
    >
      <Icon size={15} />
    </span>
  )
}

/** 分组:同一种类的条目放在一起,段内保持后端的 installed_at DESC 顺序。 */
function Group({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col">
      <PanelHeader title={title} hint={hint} action={action} />
      <ul className="flex flex-col gap-2 px-4 pb-4">{children}</ul>
    </section>
  )
}

/**
 * 我的已安装：列出当前安装的技能/智能体,可卸载;有新上架版本的给「更新」按钮
 * （复用 install 的幂等替换语义,以后端校验为准）;被平台下架(revoked)的醒目提醒。
 *
 * 反馈契约:弹窗内的失败**必须**在弹窗内就地报(面板顶部的 Alert 被 Radix 遮罩盖住,
 * 等于没有反馈);离开当前上下文的成功(行消失 / 弹窗关闭)走 Toast,留在原地的走内联。
 */
export function InstalledPanel({
  auth,
  onGoBrowse,
  onOpenConnectors,
}: {
  auth: AuthSession
  onGoBrowse: () => void
  onOpenConnectors?: (pluginSlug?: string) => void
}) {
  const toast = useToast()
  const [rows, setRows] = useState<MarketplaceInstalled[] | null>(null)
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([])
  const [loading, setLoading] = useState(true)
  /** 面板级错误只承载「整表加载失败」。 */
  const [err, setErr] = useState<string | null>(null)
  /** 弹窗内操作的错误,渲染在弹窗自己的正文里。 */
  const [modalErr, setModalErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<MarketplaceInstalled | null>(null)
  const [editScope, setEditScope] = useState<string[]>(['main'])
  const [reload, setReload] = useState(0)
  const [pendingUninstall, setPendingUninstall] = useState<{
    slug: string
    name: string
    isAgent: boolean
  } | null>(null)
  const [uninstallReason, setUninstallReason] = useState<UninstallReason>('prefer_not_say')
  const agentRows = rows?.filter((r) => r.kind === 'agent') ?? []
  const skillRows = rows?.filter((r) => r.kind === 'skill') ?? []
  const connectorRows = rows?.filter((r) => r.kind === 'connector') ?? []
  const isEmpty = !rows || rows.length === 0

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr(null)
    Promise.all([
      api.listMarketplaceInstalled(auth),
      api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[]),
    ])
      .then(([r, a]) => {
        if (!alive) return
        setRows(r)
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
      .catch((e) => alive && setErr(apiErrorMessage(e, '加载已安装失败')))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [auth, reload])

  const uninstall = useCallback(async () => {
    if (!pendingUninstall) return
    const name = pendingUninstall.name
    setBusy(pendingUninstall.slug)
    setModalErr(null)
    try {
      await api.uninstallMarketplace(auth, pendingUninstall.slug, uninstallReason)
      setPendingUninstall(null)
      setUninstallReason('prefer_not_say')
      setReload((n) => n + 1)
      // 行会消失、弹窗会关闭 —— 结果离开了当前上下文,只有 Toast 追得上。
      toast(`已卸载「${name}」`, 'success')
    } catch (e) {
      setModalErr(apiErrorMessage(e, '卸载失败'))
    } finally {
      setBusy(null)
    }
  }, [auth, pendingUninstall, uninstallReason, toast])

  // 更新 = 安装 listing 当前上架版本。latestVersionId 可能在打开面板后又变化,
  // 以后端 install 校验为准:失败(非当前版本)则报错并刷新列表。
  // 显式标注类型:回调体内部要引用 update 自己(失败 toast 的「重试」),否则类型推断成环。
  const update: (row: MarketplaceInstalled) => Promise<void> = useCallback(
    async (row: MarketplaceInstalled) => {
      if (!row.latestVersionId) return
      setBusy(row.slug)
      try {
        await api.installMarketplace(
          auth,
          row.latestVersionId,
          row.kind === 'skill'
            ? normalizeAgentScope(row.agentIds ?? row.manualAgentIds)
            : undefined,
          row.kind === 'skill',
        )
        setReload((n) => n + 1)
        // 更新成功在界面上只表现为「新版本」徽章消失,极易被当成没生效而重复点击。
        toast(`「${row.name}」已更新到 v${row.latestVersion ?? ''}`, 'success')
      } catch (e) {
        // 行内动作的失败也必须就近可见:面板顶部的 Alert 在长列表里早已滚出视口。
        toast(apiErrorMessage(e, '更新失败'), 'error', {
          actionLabel: '重试',
          onAction: () => void update(row),
        })
        setReload((n) => n + 1)
      } finally {
        setBusy(null)
      }
    },
    [auth, toast],
  )

  const openScopeEditor = (row: MarketplaceInstalled) => {
    setModalErr(null)
    setEditing(row)
    setEditScope(normalizeAgentScope(row.manualAgentIds ?? row.agentIds))
  }

  const saveScope = async () => {
    if (!editing) return
    setBusy(editing.slug)
    setModalErr(null)
    try {
      await api.updateMarketplaceInstallAgents(auth, editing.slug, editScope)
      setEditing(null)
      setReload((n) => n + 1)
      toast('归属已保存', 'success')
    } catch (e) {
      setModalErr(apiErrorMessage(e, '保存归属失败'))
    } finally {
      setBusy(null)
    }
  }

  const renderRow = (r: MarketplaceInstalled) => {
    const revoked = r.listingState === 'revoked'
    const canUpdate = updateAvailable(r)
    const dormant = r.kind === 'skill' && (r.agentIds?.length ?? 0) === 0
    const needsAuthorization = (r.capabilityReadiness?.needsAuthorization.length ?? 0) > 0
    return (
      <li key={r.slug}>
        <CardRow
          icon={<KindChip kind={r.kind} revoked={revoked} />}
          title={r.name}
          meta={
            <>
              {r.kind === 'agent' ? (
                <Badge tone="accent">智能体</Badge>
              ) : (
                <Badge tone="info">技能</Badge>
              )}
              {r.kind === 'agent' && r.capabilityReadiness?.ready === true && (
                <Badge tone="success">能力已就绪</Badge>
              )}
              {r.kind === 'agent' &&
                r.capabilityReadiness?.ready === true &&
                needsAuthorization && <Badge tone="warning">可选 Plugin 待授权</Badge>}
              {r.kind === 'agent' && r.capabilityReadiness?.ready === false && (
                <Badge tone="warning">{needsAuthorization ? 'Plugin 待授权' : '能力未就绪'}</Badge>
              )}
              <Badge tone="neutral">v{r.version}</Badge>
              {canUpdate &&
                r.latestVersion &&
                // 休眠技能点不了「更新」,徽章就不能用最强调的 accent 喊「有新版本」而不给出口。
                (dormant ? (
                  <Badge tone="neutral">新版本 v{r.latestVersion} · 启用后可更新</Badge>
                ) : (
                  <Badge tone="accent">
                    <ArrowUpCircle size={11} aria-hidden="true" /> 新版本 v{r.latestVersion}
                  </Badge>
                ))}
              {revoked && <Badge tone="warning">已被下架</Badge>}
              <span className="text-meta text-faint">
                安装于 <TimeAgo value={r.installedAt} />
              </span>
            </>
          }
          description={
            revoked
              ? `平台已下架该${r.kind === 'agent' ? '智能体' : '技能'}，将自动从你的会话移除。`
              : r.slug
          }
          actions={
            <>
              {canUpdate && !dormant && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => update(r)}
                  loading={busy === r.slug}
                >
                  {busy === r.slug ? null : <ArrowUpCircle size={14} />}
                  更新
                </Button>
              )}
              {r.kind === 'agent' && needsAuthorization && onOpenConnectors && (
                <Button variant="secondary" size="sm" onClick={() => onOpenConnectors()}>
                  授权 Plugin
                </Button>
              )}
              {r.kind === 'skill' && !revoked && (
                // 休眠技能唯一可行的下一步就是分配智能体 —— 让它成为行内最显著的操作。
                <Button
                  variant={dormant ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => openScopeEditor(r)}
                  disabled={busy === r.slug}
                >
                  <Settings2 size={14} />
                  {dormant ? '启用' : '归属'}
                </Button>
              )}
              <Tooltip content={`卸载「${r.name}」`}>
                <IconButton
                  variant="danger"
                  shape="square"
                  onClick={() => {
                    setModalErr(null)
                    setUninstallReason('prefer_not_say')
                    setPendingUninstall({
                      slug: r.slug,
                      name: r.name,
                      isAgent: r.kind === 'agent',
                    })
                  }}
                  disabled={busy === r.slug}
                  aria-label="卸载"
                >
                  <Trash2 size={15} />
                </IconButton>
              </Tooltip>
            </>
          }
        >
          {r.kind === 'agent' && r.capabilityReadiness && (
            <p className="text-caption text-faint">
              {r.capabilityReadiness.requirements.length === 0
                ? '不依赖额外 Skill / Plugin'
                : `${r.capabilityReadiness.requirements.filter((item) => item.status === 'ready').length}/${r.capabilityReadiness.requirements.length} 项组合能力就绪`}
            </p>
          )}
          {r.kind === 'skill' && !revoked && (
            <div className="flex flex-wrap items-center gap-1.5 text-meta text-muted">
              <span>适用：</span>
              <AgentScopeSummary agentIds={r.agentIds} agents={agents} />
            </div>
          )}
        </CardRow>
      </li>
    )
  }

  return (
    <div className="flex flex-col">
      <Modal
        open={pendingUninstall !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) {
            setPendingUninstall(null)
            setModalErr(null)
          }
        }}
        title={
          pendingUninstall
            ? `卸载${pendingUninstall.isAgent ? '智能体' : '技能'}「${pendingUninstall.name}」?`
            : undefined
        }
        description={
          pendingUninstall?.isAgent
            ? '智能体会被移除；仅由它自动带来的 Skill 会退出。Plugin 会保留到你主动卸载。'
            : '卸载后将不再可用；其他智能体对它的依赖会明确显示为未就绪。'
        }
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setPendingUninstall(null)
                setModalErr(null)
              }}
            >
              取消
            </Button>
            <Button variant="danger" loading={busy !== null} onClick={() => void uninstall()}>
              卸载
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {/* 就地报错:弹窗还开着的时候,面板顶部的 Alert 在遮罩之下,用户什么也看不到。 */}
          {modalErr && (
            <Alert tone="danger" density="compact">
              {modalErr}
            </Alert>
          )}
          <Field label="原因（可不说明）" hint="可选;它只用于改进市场内容，不会通知发布者。">
            <Select
              value={uninstallReason}
              disabled={busy !== null}
              onValueChange={(value) => setUninstallReason(value as UninstallReason)}
              options={UNINSTALL_REASON_OPTIONS}
            />
          </Field>
        </div>
      </Modal>
      <Modal
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null)
            setModalErr(null)
          }
        }}
        title="修改技能归属"
        description={editing ? `选择「${editing.name}」要安装给哪些智能体` : undefined}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null)
                setModalErr(null)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={saveScope}
              loading={!!editing && busy === editing.slug}
              disabled={!editing || editScope.length === 0}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {modalErr && (
            <Alert tone="danger" density="compact">
              {modalErr}
            </Alert>
          )}
          <AgentScopePicker agents={agents} selectedIds={editScope} onChange={setEditScope} />
        </div>
      </Modal>
      {err && (
        <div className="px-4 pt-3">
          <Alert
            tone="danger"
            title="已安装列表没能加载出来"
            action={
              <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        </div>
      )}
      {/* 加载失败时不再叠一句「还没有安装任何技能」—— 那是把故障说成了空;此时只留上方
          带「重试」的 Alert。 */}
      {loading ? (
        <ListSkeleton rows={4} className="px-4 py-4" />
      ) : err && !rows ? null : isEmpty ? (
        <EmptyState
          icon={PackageOpen}
          title="还没有安装任何技能或智能体"
          hint="去市场发现别人沉淀好的能力，一键安装即可使用。"
          action={
            <Button variant="secondary" size="sm" onClick={onGoBrowse}>
              去市场看看
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-1 pb-2">
          {agentRows.length > 0 && (
            <Group title={`智能体（${agentRows.length}）`} hint="人格入口:在输入框上方切换。">
              {agentRows.map(renderRow)}
            </Group>
          )}
          {skillRows.length > 0 && (
            <Group title={`技能（${skillRows.length}）`} hint="按归属分配给智能体后在会话中生效。">
              {skillRows.map(renderRow)}
            </Group>
          )}
          {connectorRows.length > 0 && (
            // 只读镜像:绑定账号/更新/卸载的权威在管理中心,这里不重复提供,免得两处争权威。
            <Group
              title={`API 连接插件（${connectorRows.length}）`}
              hint="在管理中心统一绑定账号、更新与卸载。"
              action={
                onOpenConnectors ? (
                  <Button size="sm" variant="secondary" onClick={() => onOpenConnectors()}>
                    去管理插件
                  </Button>
                ) : undefined
              }
            >
              {connectorRows.map((r) => (
                <li key={r.slug}>
                  <CardRow
                    icon={<KindChip kind="connector" revoked={r.listingState === 'revoked'} />}
                    title={r.name}
                    description={r.slug}
                    meta={
                      <>
                        <Badge tone="neutral">API 插件</Badge>
                        <Badge tone="neutral">v{r.version}</Badge>
                        {r.listingState === 'revoked' && <Badge tone="warning">已被下架</Badge>}
                        <span className="text-meta text-faint">
                          安装于 <TimeAgo value={r.installedAt} />
                        </span>
                      </>
                    }
                    actions={
                      onOpenConnectors ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => onOpenConnectors(r.slug)}
                        >
                          去绑定
                        </Button>
                      ) : undefined
                    }
                  />
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  )
}
