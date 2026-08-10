import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Modal } from '../../../components/ui'
import { type Column, DataTable, PageHeader } from '../../components'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import { getAdminPage } from '../../registry'

type Finding = {
  id: string
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
}

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
  const [resolvedModel, setResolvedModel] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Finding | null>(null)

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
          limit: 100,
          offset: page * 100,
        },
      )
      setRows(result.rows)
      setTotal(result.total)
      setResolvedModel(result.model)
    } catch (err) {
      setError(apiErrorMessage(err, '无法加载平台优化发现'))
    } finally {
      setLoading(false)
    }
  }, [model, page, status, traffic])

  useEffect(() => {
    void load()
  }, [load])

  const columns: Column<Finding>[] = [
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
      render: (row) => new Date(row.last_seen_at).toLocaleString('zh-CN'),
    },
  ]

  async function updateStatus(next: Finding['status']) {
    if (!selected) return
    setUpdating(true)
    setError(null)
    try {
      await adminSend('PATCH', `/auto-dream-findings/${selected.id}`, { status: next })
      setSelected(null)
      await load()
    } catch (err) {
      setError(apiErrorMessage(err, '更新发现状态失败'))
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={`${meta.desc} · 共 ${total} 项`}
        actions={
          <div className="flex items-center gap-2">
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
              value={model}
              onChange={(event) => {
                setModel(event.target.value)
                setPage(0)
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg"
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
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        loading={loading}
        emptyTitle="暂无平台优化发现"
        emptyHint="用户同意 Auto‑Dream V2 后，匿名发现会自动聚合到这里。"
        onRowClick={setSelected}
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
                onClick={() => void updateStatus('dismissed')}
              >
                忽略
              </Button>
              <Button
                variant="ghost"
                disabled={updating}
                onClick={() => void updateStatus('triaged')}
              >
                已分诊
              </Button>
              <Button
                variant="ghost"
                disabled={updating}
                onClick={() => void updateStatus('planned')}
              >
                纳入计划
              </Button>
              <Button
                variant="primary"
                disabled={updating}
                onClick={() => void updateStatus('resolved')}
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
