import { Archive, RefreshCw, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Input, Modal } from '../../../components/ui'
import { type Column, DataTable, PageHeader, StatCard, StatCardRow, TimeAgo } from '../../components'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import { getAdminPage } from '../../registry'

type Finding = {
  id: string
  fingerprint: string
  taxonomy: string
  capability_id: string
  severity: 'low' | 'medium' | 'high'
  title: string
  problem: string
  impact: string
  recommendation: string
  status: 'new' | 'triaged' | 'planned' | 'resolved' | 'dismissed'
  occurrence_count: string
  affected_user_count: string
  run_count: string
  evidence_confidence: 'single_source' | 'corroborated'
  first_seen_at: string
  last_seen_at: string
  last_model: string
  owner: string | null
}

type FindingStatus = Finding['status']
type SeenWithin = '1h' | '24h' | '7d' | '30d' | 'all'

const STATUS_LABEL: Record<Finding['status'], string> = {
  new: '新发现',
  triaged: '已分诊',
  planned: '已计划',
  resolved: '已解决',
  dismissed: '已忽略',
}

export default function AutoDreamFindingsPage() {
  const meta = getAdminPage('autoDreamFindings')
  const [rows, setRows] = useState<Finding[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('all')
  const [traffic, setTraffic] = useState('production_user')
  const [model, setModel] = useState('current')
  const [seenWithin, setSeenWithin] = useState<SeenWithin>('30d')
  const [minAffectedUsers, setMinAffectedUsers] = useState('1')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [resolvedModel, setResolvedModel] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Finding | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editOwner, setEditOwner] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await adminGet<{ rows: Finding[]; total: number; model: string | null }>(
        '/auto-dream-findings',
        {
          status,
          traffic_class: traffic,
          model,
          seen_within: seenWithin,
          min_affected_users: minAffectedUsers,
          owner: ownerFilter || undefined,
          limit: 100,
          offset: page * 100,
        },
      )
      setRows(result.rows)
      setSelectedIds(new Set())
      setTotal(result.total)
      setResolvedModel(result.model)
    } catch (err) {
      setError(apiErrorMessage(err, '无法加载平台优化发现'))
    } finally {
      setLoading(false)
    }
  }, [minAffectedUsers, model, ownerFilter, page, seenWithin, status, traffic])

  useEffect(() => {
    void load()
  }, [load])

  const visibleRows = useMemo(
    () => [...rows].sort((a, b) => {
      const recency = new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime()
      if (recency !== 0) return recency
      return Number(b.affected_user_count) - Number(a.affected_user_count)
    }),
    [rows],
  )
  const summary = useMemo(() => ({
    affected: visibleRows.reduce((sum, row) => sum + Number(row.affected_user_count), 0),
    corroborated: visibleRows.filter((row) => row.evidence_confidence === 'corroborated').length,
    unowned: visibleRows.filter((row) => !row.owner).length,
  }), [visibleRows])

  const columns: Column<Finding>[] = [
    {
      key: 'selected',
      title: (
        <input
          type="checkbox"
          aria-label="选择当前页全部发现"
          checked={visibleRows.length > 0 && visibleRows.every((row) => selectedIds.has(row.id))}
          onChange={(event) => setSelectedIds(
            event.target.checked ? new Set(visibleRows.map((row) => row.id)) : new Set(),
          )}
          className="h-4 w-4 accent-accent"
        />
      ),
      width: 44,
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择发现 ${row.title}`}
          checked={selectedIds.has(row.id)}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setSelectedIds((current) => {
            const next = new Set(current)
            if (event.target.checked) next.add(row.id)
            else next.delete(row.id)
            return next
          })}
          className="h-4 w-4 accent-accent"
        />
      ),
    },
    {
      key: 'severity',
      title: '级别',
      width: 72,
      render: (row) => (
        <Badge
          tone={row.severity === 'high' ? 'danger' : row.severity === 'medium' ? 'warning' : 'info'}
        >
          {row.severity}
        </Badge>
      ),
    },
    {
      key: 'title',
      title: '平台优化发现',
      render: (row) => (
        <div className="min-w-[18rem]">
          <div className="font-medium">{row.title}</div>
          <div className="mt-0.5 text-[11.5px] text-faint">
            {row.capability_id} · {row.taxonomy}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-faint" title={row.fingerprint}>
            cluster {row.fingerprint.slice(0, 12)}
          </div>
        </div>
      ),
    },
    {
      key: 'evidence_confidence',
      title: '证据',
      width: 96,
      render: (row) => (
        <Badge tone={row.evidence_confidence === 'corroborated' ? 'success' : 'neutral'}>
          {row.evidence_confidence === 'corroborated' ? '多源印证' : '单一来源'}
        </Badge>
      ),
    },
    {
      key: 'affected_user_count',
      title: '影响用户',
      align: 'right',
      render: (row) => <span className="tabular-nums">{row.affected_user_count}</span>,
    },
    {
      key: 'occurrence_count',
      title: '信号',
      align: 'right',
      render: (row) => <span className="tabular-nums">{row.occurrence_count}</span>,
    },
    {
      key: 'owner',
      title: '负责人',
      width: 104,
      render: (row) => row.owner ? <Badge tone="info">{row.owner}</Badge> : <span className="text-faint">未指派</span>,
    },
    {
      key: 'status',
      title: '状态',
      render: (row) => (
        <Badge tone={row.status === 'resolved' ? 'success' : 'neutral'}>
          {STATUS_LABEL[row.status]}
        </Badge>
      ),
    },
    {
      key: 'last_seen_at',
      title: '最近发现',
      render: (row) => <TimeAgo value={row.last_seen_at} />,
    },
  ]

  async function updateFinding(patch: { status?: FindingStatus; owner?: string | null }) {
    if (!selected) return
    setUpdating(true)
    setError(null)
    try {
      await adminSend('PATCH', `/auto-dream-findings/${selected.id}`, patch)
      setSelected(null)
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, '更新发现状态失败'))
    } finally {
      setUpdating(false)
    }
  }

  async function updateBatch(ids: string[], patch: { status?: FindingStatus; owner?: string | null }) {
    if (ids.length === 0 || updating) return
    setUpdating(true)
    setError(null)
    try {
      await adminSend('PATCH', '/auto-dream-findings/batch', { ids, ...patch })
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, '批量更新发现失败'))
    } finally {
      setUpdating(false)
    }
  }

  const staleSingleSourceIds = visibleRows
    .filter((row) => row.evidence_confidence === 'single_source')
    .filter((row) => Date.now() - new Date(row.last_seen_at).getTime() > 30 * 24 * 60 * 60 * 1000)
    .map((row) => row.id)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={`${meta.desc} · 共 ${total} 项`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={traffic}
              onChange={(event) => {
                setTraffic(event.target.value)
                setPage(0)
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg"
            >
              <option value="production_user">真实用户</option>
              <option value="all">全部流量</option>
              <option value="internal_admin">内部管理员</option>
              <option value="synthetic_canary">合成灰度</option>
              <option value="e2e">E2E</option>
            </select>
            <select
              aria-label="发现时间范围"
              value={seenWithin}
              onChange={(event) => {
                setSeenWithin(event.target.value as SeenWithin)
                setPage(0)
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
            >
              <option value="1h">最近 1 小时</option>
              <option value="24h">最近 24 小时</option>
              <option value="7d">最近 7 天</option>
              <option value="30d">最近 30 天</option>
              <option value="all">展开全部历史</option>
            </select>
            <select
              aria-label="最低影响用户数"
              value={minAffectedUsers}
              onChange={(event) => {
                setMinAffectedUsers(event.target.value)
                setPage(0)
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
            >
              <option value="1">至少 1 位用户</option>
              <option value="2">至少 2 位用户</option>
              <option value="5">至少 5 位用户</option>
            </select>
            <Input
              aria-label="按负责人筛选"
              value={ownerFilter}
              onChange={(event) => { setOwnerFilter(event.target.value); setPage(0) }}
              placeholder="负责人筛选"
              className="w-36"
            />
            <select
              value={model}
              onChange={(event) => {
                setModel(event.target.value)
                setPage(0)
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
            >
              <option value="current">当前模型{resolvedModel ? ` · ${resolvedModel}` : ''}</option>
              <option value="all">全部模型（含历史）</option>
            </select>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value)
                setPage(0)
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg"
            >
              <option value="all">全部状态</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <span className="text-xs tabular-nums text-faint">
              {total === 0 ? '0' : `${page * 100 + 1}–${Math.min(total, (page + 1) * 100)}`} /{' '}
              {total}
            </span>
            <Button
              variant="ghost"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              上一页
            </Button>
            <Button
              variant="ghost"
              disabled={(page + 1) * 100 >= total}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </Button>
            <Button variant="ghost" onClick={() => void load()}>
              <RefreshCw size={14} /> 刷新
            </Button>
          </div>
        }
      />
      {error && (
        <div className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {seenWithin === 'all' && (
        <Alert tone="warning">
          已展开全部历史积压。默认视图只看当前模型最近 30 天，避免陈旧单一来源淹没近期多用户信号。
        </Alert>
      )}
      <StatCardRow>
        <StatCard label="当前筛选总数" value={total} icon={RefreshCw} tone="neutral" loading={loading} />
        <StatCard label="当前页影响用户" value={summary.affected} icon={Users} tone="info" hint="聚合计数，可能跨 finding 重复" loading={loading} />
        <StatCard label="多源印证" value={summary.corroborated} icon={Users} tone="success" loading={loading} />
        <StatCard label="当前页未指派" value={summary.unowned} icon={Users} tone={summary.unowned > 0 ? 'warning' : 'success'} loading={loading} />
      </StatCardRow>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
        <span className="text-[12px] text-muted">已选择 {selectedIds.size} 项</span>
        <Button size="sm" variant="secondary" disabled={selectedIds.size === 0 || updating} onClick={() => void updateBatch([...selectedIds], { status: 'triaged' })}>
          批量分诊
        </Button>
        <Button size="sm" variant="secondary" disabled={selectedIds.size === 0 || updating} onClick={() => void updateBatch([...selectedIds], { status: 'dismissed' })}>
          批量忽略
        </Button>
        {seenWithin === 'all' && (
          <Button size="sm" variant="secondary" disabled={staleSingleSourceIds.length === 0 || updating} onClick={() => void updateBatch(staleSingleSourceIds, { status: 'dismissed' })}>
            <Archive size={14} />归档当前页陈旧单源（{staleSingleSourceIds.length}）
          </Button>
        )}
        <span className="text-[11px] text-faint">“归档”复用既有「已忽略」状态，不创建第二套生命周期。</span>
      </div>
      <DataTable
        rows={visibleRows}
        columns={columns}
        rowKey={(row) => row.id}
        loading={loading}
        emptyTitle="暂无平台优化发现"
        emptyHint="用户同意 Auto‑Dream V2 后，匿名发现会自动聚合到这里。"
        onRowClick={(row) => { setSelected(row); setEditOwner(row.owner ?? '') }}
      />
      {selected && (
        <Modal
          open
          onOpenChange={(open) => !open && setSelected(null)}
          title={selected.title}
          description={`${selected.capability_id} · ${selected.affected_user_count} 位用户 · ${selected.run_count} 次运行`}
          className="max-w-2xl"
          footer={
            <>
              <Button
                variant="ghost"
                disabled={updating}
                onClick={() => void updateFinding({ status: 'dismissed' })}
              >
                忽略
              </Button>
              <Button
                variant="ghost"
                disabled={updating}
                onClick={() => void updateFinding({ status: 'triaged' })}
              >
                已分诊
              </Button>
              <Button
                variant="ghost"
                disabled={updating}
                onClick={() => void updateFinding({ status: 'planned' })}
              >
                纳入计划
              </Button>
              <Button
                variant="primary"
                disabled={updating}
                onClick={() => void updateFinding({ status: 'resolved' })}
              >
                标记解决
              </Button>
            </>
          }
        >
          <div className="space-y-4 text-sm leading-relaxed">
            <Field title="问题" value={selected.problem} />
            <Field title="用户影响" value={selected.impact} />
            <Field title="建议" value={selected.recommendation} />
            <Field
              title="证据置信"
              value={
                selected.evidence_confidence === 'corroborated'
                  ? '来自至少 2 位匿名用户、2 次独立运行；与严重级别分开判断。'
                  : '当前仅有单一来源；保留信号但不据此放大结论。'
              }
            />
            <div>
              <div className="mb-1 text-xs font-semibold text-faint">负责人</div>
              <div className="flex gap-2">
                <Input
                  aria-label="发现负责人"
                  value={editOwner}
                  onChange={(event) => setEditOwner(event.target.value)}
                  placeholder="留空取消指派"
                  disabled={updating}
                />
                <Button variant="secondary" disabled={updating || editOwner.trim() === (selected.owner ?? '')} onClick={() => void updateFinding({ owner: editOwner.trim() || null })}>
                  保存负责人
                </Button>
              </div>
            </div>
            <Field title="聚类指纹" value={selected.fingerprint} />
            <p className="text-xs text-faint">
              仅展示匿名闭集摘要，不含用户 ID、原始会话、日志正文、工具参数或凭证。
            </p>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Field({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-faint">{title}</div>
      <p className="text-fg">{value}</p>
    </div>
  )
}
