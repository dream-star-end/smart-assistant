import { Ban, Container, ExternalLink, ShieldCheck, ShieldOff, Undo2, Wallet } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Badge, Button, Sheet, Switch, useConfirm, useToast } from '../../../components/ui'
import { KeyValue, LevelBadge, SectionCard, TimeAgo } from '../../components'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import { fmtDateTime, fmtInt, fmtYuan } from './format'
import type { ModelGrant, UserDetail, UserRow } from './types'
import { useLoad } from './useLoad'

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  active: 'success',
  banned: 'danger',
  deleting: 'warning',
  deleted: 'neutral',
}

function errMsg(e: unknown): string {
  return apiErrorMessage(e, '请求失败')
}

export function UserDetailSheet({
  userId,
  reloadKey = 0,
  onClose,
  onChanged,
  onAdjust,
  onNavigate,
}: {
  userId: string | null
  /** 外部（如调账 Modal）改动后 +1，强制重拉详情以刷新余额等字段。 */
  reloadKey?: number
  onClose: () => void
  /** 属性/余额变化后通知父列表刷新。 */
  onChanged: () => void
  /** 打开调账 Modal。 */
  onAdjust: (userId: string, email: string) => void
  /** 深链跳转（会先关闭本抽屉）。 */
  onNavigate: (tab: string, params: Record<string, string>) => void
}) {
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const [busy, setBusy] = useState(false)

  const detail = useLoad<UserDetail>(
    () => adminGet<UserDetail>(`/users/${userId}/detail`),
    [userId, reloadKey],
    { enabled: userId !== null },
  )
  const grants = useLoad<{ rows: ModelGrant[] }>(
    () => adminGet<{ rows: ModelGrant[] }>(`/users/${userId}/model-grants`),
    [userId],
    { enabled: userId !== null },
  )

  const u = detail.data?.user ?? null
  const lc = detail.data?.lifecycle

  const doPatch = async (
    patch: Record<string, unknown>,
    successMsg: string,
    confirmOpts?: Parameters<typeof confirm>[0],
  ) => {
    if (confirmOpts) {
      const ok = await confirm(confirmOpts)
      if (!ok) return
    }
    setBusy(true)
    try {
      await adminSend('PATCH', `/users/${userId}`, patch)
      toast(successMsg, 'success')
      detail.reload()
      onChanged()
    } catch (e) {
      toast(`操作失败：${errMsg(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const go = (tab: string, params: Record<string, string>) => {
    onClose()
    onNavigate(tab, params)
  }

  return (
    <Sheet
      open={userId !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      side="right"
      srTitle="用户详情"
      className="w-[34rem] max-w-[94vw] bg-bg"
      overlayClassName=""
    >
      {confirmEl}
      {/* 头部 */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-5">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-fg">
            {u?.email || (userId ? `用户 #${userId}` : '用户详情')}
          </p>
          {u && <p className="truncate text-[11.5px] text-faint">#{u.id}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {detail.loading && !detail.data ? (
          <div className="flex flex-col gap-3">
            {['a', 'b', 'c', 'd', 'e'].map((k) => (
              <div key={k} className="h-16 w-full animate-pulse rounded-lg bg-hover" />
            ))}
          </div>
        ) : detail.error ? (
          <div className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-6 text-center text-[13px] text-danger">
            加载失败：{errMsg(detail.error)}
          </div>
        ) : u ? (
          <div className="flex flex-col gap-4">
            {/* 基本信息 */}
            <SectionCard title="基本信息" bodyClassName="py-2">
              <KeyValue
                label="邮箱"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    {u.email}
                    {u.email_verified ? (
                      <Badge tone="success">已验证</Badge>
                    ) : (
                      <Badge tone="warning">未验证</Badge>
                    )}
                  </span>
                }
              />
              <KeyValue
                label="显示名"
                value={u.display_name || <span className="text-faint">—</span>}
              />
              <KeyValue
                label="角色 / 状态"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <Badge tone={u.role === 'admin' ? 'warning' : 'neutral'}>{u.role}</Badge>
                    <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{u.status}</Badge>
                  </span>
                }
              />
              <KeyValue
                label="余额"
                value={<span className="tabular-nums">{fmtYuan(u.credits)}</span>}
              />
              <KeyValue
                label="累计充值"
                value={<span className="tabular-nums">{fmtYuan(u.total_topup_cents)}</span>}
              />
              <KeyValue label="注册时间" value={fmtDateTime(u.created_at)} />
              <KeyValue
                label="首次充值"
                value={
                  lc?.first_topup_at ? (
                    fmtDateTime(lc.first_topup_at)
                  ) : (
                    <span className="text-faint">从未</span>
                  )
                }
              />
              <KeyValue
                label="首次请求"
                value={
                  lc?.first_request_at ? (
                    fmtDateTime(lc.first_request_at)
                  ) : (
                    <span className="text-faint">从未</span>
                  )
                }
              />
              <KeyValue
                label="最近活跃"
                value={
                  lc?.last_active_at ? (
                    <TimeAgo value={lc.last_active_at} />
                  ) : (
                    <span className="text-faint">从未</span>
                  )
                }
              />
            </SectionCard>

            {/* 账号操作 */}
            <SectionCard title="账号操作" hint="破坏性操作需二次确认">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => onAdjust(u.id, u.email)}
                    disabled={busy}
                    className="gap-1.5"
                  >
                    <Wallet size={14} /> 调整余额
                  </Button>
                  {u.status === 'active' ? (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      className="gap-1.5"
                      onClick={() =>
                        doPatch({ status: 'banned' }, '已封禁该用户', {
                          title: '确认封禁该用户？',
                          body: '封号将即时撤销该用户全部活跃 session（登录续签令牌立即失效）。',
                          danger: true,
                          confirmText: '封禁',
                        })
                      }
                    >
                      <Ban size={14} /> 封禁
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      className="gap-1.5"
                      onClick={() =>
                        doPatch({ status: 'active' }, '已恢复该用户为 active', {
                          title: '恢复该用户为 active？',
                          body: '账号将重新可用（不会自动重发历史令牌，用户需重新登录）。',
                          confirmText: '解封',
                        })
                      }
                    >
                      <Undo2 size={14} /> 解封
                    </Button>
                  )}
                  {u.role === 'admin' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      className="gap-1.5"
                      onClick={() =>
                        doPatch({ role: 'user' }, '已取消管理员', {
                          title: '取消该用户的管理员权限？',
                          body: '该用户将失去管理后台访问权限。',
                          danger: true,
                          confirmText: '取消管理员',
                        })
                      }
                    >
                      <ShieldOff size={14} /> 取消管理员
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      className="gap-1.5"
                      onClick={() =>
                        doPatch({ role: 'admin' }, '已设为管理员', {
                          title: '将该用户设为管理员？',
                          body: '该用户将获得管理后台的全部权限，请谨慎授予。',
                          danger: true,
                          confirmText: '设为管理员',
                        })
                      }
                    >
                      <ShieldCheck size={14} /> 设为管理员
                    </Button>
                  )}
                </div>
                <div className="flex items-center justify-between rounded-lg bg-hover px-3 py-2">
                  <span className="text-[12.5px] text-muted">标记邮箱已验证</span>
                  <Switch
                    checked={u.email_verified}
                    disabled={busy}
                    onCheckedChange={(v) =>
                      doPatch(
                        { email_verified: v },
                        v ? '已标记邮箱为已验证' : '已取消邮箱验证标记',
                      )
                    }
                    aria-label="邮箱已验证"
                  />
                </div>
              </div>
            </SectionCard>

            {/* 关联数据深链 */}
            <SectionCard title="关联数据">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  disabled={u.containers_active <= 0}
                  onClick={() => go('containers', { user_email: u.email })}
                >
                  <Container size={14} /> 容器
                  {u.containers_active > 0 && <Badge tone="accent">{u.containers_active}</Badge>}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => go('ledger', { user: u.id })}
                >
                  <ExternalLink size={14} /> 积分流水
                </Button>
              </div>
            </SectionCard>

            {/* 模型授权列表 */}
            <SectionCard title="模型授权" hint="该用户被显式授予的模型（白名单外额外授权）">
              {grants.loading && !grants.data ? (
                <div className="h-10 w-full animate-pulse rounded-lg bg-hover" />
              ) : grants.error ? (
                <p className="text-[12.5px] text-danger">加载失败：{errMsg(grants.error)}</p>
              ) : (grants.data?.rows.length ?? 0) === 0 ? (
                <p className="text-[12.5px] text-faint">无额外模型授权</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/60">
                  {grants.data?.rows.map((g) => (
                    <li key={g.id} className="flex items-center justify-between gap-2 py-2">
                      <code className="truncate text-[12.5px] text-fg">{g.model_id}</code>
                      <TimeAgo value={g.granted_at} className="shrink-0 text-[11.5px] text-faint" />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            {/* 最近充值 */}
            <MiniTableCard
              title={`最近充值（${detail.data?.topups.length ?? 0}）`}
              empty="暂无充值记录"
              rows={detail.data?.topups ?? []}
            >
              {(t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]"
                >
                  <span className="shrink-0 text-faint tabular-nums">
                    {fmtDateTime(t.created_at)}
                  </span>
                  <span className="tabular-nums text-success">+{fmtYuan(t.delta)}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-muted">
                    {t.memo || '—'}
                  </span>
                </div>
              )}
            </MiniTableCard>

            {/* 最近请求 */}
            <MiniTableCard
              title={`最近请求（${detail.data?.recent_requests.length ?? 0}）`}
              empty="暂无请求记录"
              rows={detail.data?.recent_requests ?? []}
            >
              {(r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]"
                >
                  <span className="shrink-0 text-faint tabular-nums">
                    {fmtDateTime(r.created_at)}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-fg">{r.model || '—'}</code>
                  <span className="tabular-nums text-muted">{fmtYuan(r.cost_credits)}</span>
                  <LevelBadge
                    level={r.status === 'success' ? 'success' : 'warning'}
                    label={r.status}
                  />
                </div>
              )}
            </MiniTableCard>

            {/* 最近会话（90 天摘要） */}
            <MiniTableCard
              title={`最近会话 · 90 天（${detail.data?.recent_sessions.length ?? 0}）`}
              empty="90 天内暂无会话"
              rows={detail.data?.recent_sessions ?? []}
            >
              {(s) => (
                <div
                  key={s.session_id}
                  className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]"
                >
                  <span className="min-w-0 flex-1 truncate text-fg" title={s.title}>
                    {s.title || <span className="text-faint">(无标题)</span>}
                  </span>
                  <code className="shrink-0 text-faint">{s.agent_id || '—'}</code>
                  <span className="shrink-0 tabular-nums text-muted">
                    {fmtInt(s.message_count)} 条
                  </span>
                  <TimeAgo value={s.last_at} className="shrink-0 text-faint" />
                </div>
              )}
            </MiniTableCard>
          </div>
        ) : null}
      </div>
    </Sheet>
  )
}

function MiniTableCard<T>({
  title,
  empty,
  rows,
  children,
}: {
  title: string
  empty: string
  rows: T[]
  children: (row: T) => ReactNode
}) {
  return (
    <SectionCard title={title} bodyClassName="py-2">
      {rows.length === 0 ? (
        <p className="py-1 text-[12.5px] text-faint">{empty}</p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {rows.map((r) => children(r))}
        </div>
      )}
    </SectionCard>
  )
}
