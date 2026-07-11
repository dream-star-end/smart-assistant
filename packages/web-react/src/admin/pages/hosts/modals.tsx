import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Badge, Button, Input, Modal, Spinner } from '../../../components/ui'
import { KeyValue, SelectFilter } from '../../components'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import {
  distributeOutcomeTone,
  hostStatusTone,
  isoToShanghaiInput,
  shanghaiInputToIso,
} from './helpers'
import type { BootstrapLogView, DistributeResult, HostDiagnostic, HostRow } from './types'

function errMsg(e: unknown): string {
  return apiErrorMessage(e, '请求失败')
}

/**
 * 写操作但后端返回 204 No Content（如 expires-at）。地基 adminSend→jsonOrThrow 对 2xx
 * 空体仍调 res.json() → 抛 SyntaxError（见报告「地基缺口」）。这里精确吞掉 SyntaxError
 * （空体解析 = 成功），保留 ApiError（真实 HTTP 错）与 TypeError（网络错）继续抛。
 * 地基一旦让 jsonOrThrow 对 204 返回 undefined，本函数自然退化为直通，无需改动。
 */
async function sendVoid(method: 'POST', path: string, body?: unknown): Promise<void> {
  try {
    await adminSend(method, path, body)
  } catch (e) {
    if (e instanceof SyntaxError) return
    throw e
  }
}

// ─── 添加虚机 ──────────────────────────────────────────────────────────

const FIELD_LABEL = 'text-[12px] font-medium text-faint'

/** 表单字段：label(htmlFor) 绑定内部控件 id，满足 a11y + biome noLabelWithoutControl。 */
function Field({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string
  label: string
  hint?: string
  className?: string
  children: ReactNode
}) {
  return (
    <label htmlFor={id} className={className ?? 'flex flex-col gap-1'}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  )
}

/**
 * 添加虚机表单。master SSH 到目标机装 node-agent、签证书、起代理，
 * 成功后回调 onAdded(hostId, name) 让父页打开 bootstrap 日志看进度。
 */
export function AddHostModal({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onAdded: (hostId: string, name: string) => void
}) {
  const [f, setF] = useState({
    name: '',
    host: '',
    ssh_port: '22',
    ssh_user: 'root',
    password: '',
    agent_port: '9443',
    bridge_cidr: '',
    max_containers: '20',
    expires: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }))

  // 打开时重置。
  useEffect(() => {
    if (open) {
      setF({
        name: '',
        host: '',
        ssh_port: '22',
        ssh_user: 'root',
        password: '',
        agent_port: '9443',
        bridge_cidr: '',
        max_containers: '20',
        expires: '',
      })
      setErr(null)
    }
  }, [open])

  const submit = async () => {
    if (!f.name.trim() || !f.host.trim() || !f.password || !f.bridge_cidr.trim()) {
      setErr('请填完必填项：name / host / password / bridge_cidr')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const r = await adminSend<{ hostId?: string; status?: string }>(
        'POST',
        '/v3/compute-hosts/add',
        {
          name: f.name.trim(),
          host: f.host.trim(),
          ssh_port: Number(f.ssh_port),
          ssh_user: f.ssh_user.trim(),
          password: f.password,
          agent_port: Number(f.agent_port),
          bridge_cidr: f.bridge_cidr.trim(),
          max_containers: Number(f.max_containers),
          expires_at: shanghaiInputToIso(f.expires),
        },
      )
      onOpenChange(false)
      if (r?.hostId) onAdded(r.hostId, f.name.trim())
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="添加虚机"
      description="master 会 SSH 到目标机装 node-agent、签证书、起代理。完成后可看 bootstrap 进度。"
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy && <Spinner size={14} />}
            添加并 Bootstrap
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="nh-name" label="name *">
          <Input
            id="nh-name"
            value={f.name}
            onChange={set('name')}
            placeholder="tk-01"
            maxLength={64}
          />
        </Field>
        <Field id="nh-host" label="host *">
          <Input
            id="nh-host"
            value={f.host}
            onChange={set('host')}
            placeholder="1.2.3.4 或 host.example.com"
          />
        </Field>
        <Field id="nh-ssh-port" label="ssh_port">
          <Input id="nh-ssh-port" type="number" value={f.ssh_port} onChange={set('ssh_port')} />
        </Field>
        <Field id="nh-ssh-user" label="ssh_user">
          <Input id="nh-ssh-user" value={f.ssh_user} onChange={set('ssh_user')} maxLength={64} />
        </Field>
        <Field id="nh-password" label="password *">
          <Input
            id="nh-password"
            type="password"
            value={f.password}
            onChange={set('password')}
            placeholder="SSH 密码（AES-GCM 存库）"
            autoComplete="new-password"
          />
        </Field>
        <Field id="nh-agent-port" label="agent_port">
          <Input
            id="nh-agent-port"
            type="number"
            value={f.agent_port}
            onChange={set('agent_port')}
          />
        </Field>
        <Field id="nh-bridge-cidr" label="bridge_cidr *" hint="容器网段，各虚机不能重叠">
          <Input
            id="nh-bridge-cidr"
            value={f.bridge_cidr}
            onChange={set('bridge_cidr')}
            placeholder="172.30.1.0/24"
          />
        </Field>
        <Field id="nh-max" label="max_containers">
          <Input
            id="nh-max"
            type="number"
            value={f.max_containers}
            onChange={set('max_containers')}
          />
        </Field>
        <Field
          id="nh-expires"
          label="VPS 到期（北京时间，可留空）"
          className="flex flex-col gap-1 sm:col-span-2"
        >
          <Input
            id="nh-expires"
            type="datetime-local"
            value={f.expires}
            onChange={set('expires')}
          />
        </Field>
      </div>
      {err && <p className="mt-3 text-[13px] text-danger">{err}</p>}
    </Modal>
  )
}

// ─── Bootstrap 日志（带 3s 轮询） ──────────────────────────────────────

export function BootstrapLogModal({
  hostId,
  name,
  onClose,
}: {
  /** null = 关闭。 */
  hostId: string | null
  name: string
  onClose: () => void
}) {
  const [data, setData] = useState<BootstrapLogView | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (hostId === null) return
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    setData(null)
    setErr(null)

    const tick = async () => {
      try {
        const d = await adminGet<BootstrapLogView>(
          `/v3/compute-hosts/${encodeURIComponent(hostId)}/bootstrap-log`,
        )
        if (!alive) return
        setData(d)
        // bootstrapping 继续轮询，终态停。
        if (d.status !== 'bootstrapping' && timer) {
          clearInterval(timer)
          timer = undefined
        }
      } catch (e) {
        if (!alive) return
        setErr(errMsg(e))
        if (timer) {
          clearInterval(timer)
          timer = undefined
        }
      }
    }
    void tick()
    timer = setInterval(tick, 3000)
    return () => {
      alive = false
      if (timer) clearInterval(timer)
    }
  }, [hostId])

  return (
    <Modal
      open={hostId !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="Bootstrap 日志"
      description={name}
      className="max-w-xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {err ? (
        <p className="text-[13px] text-danger">读取失败：{err}</p>
      ) : !data ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> 加载中…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-faint">状态</span>
            <Badge tone={hostStatusTone(data.status)}>{data.status}</Badge>
            {data.failed_step && <Badge tone="danger">失败步骤: {data.failed_step}</Badge>}
          </div>
          <KeyValue
            label="最近 bootstrap 时间"
            value={
              data.last_bootstrap_at
                ? new Date(data.last_bootstrap_at).toLocaleString('zh-CN')
                : '—'
            }
          />
          <div>
            <p className="mb-1 text-[12px] text-faint">最近错误</p>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-hover p-3 font-mono text-[12px] text-fg">
              {data.last_bootstrap_err || '(无)'}
            </pre>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ─── 诊断 ──────────────────────────────────────────────────────────────

export function DiagnosticModal({
  hostId,
  name,
  onClose,
}: {
  hostId: string | null
  name: string
  onClose: () => void
}) {
  const [data, setData] = useState<HostDiagnostic | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (hostId === null) return
    let alive = true
    setData(null)
    setErr(null)
    adminGet<HostDiagnostic>(`/v3/compute-hosts/${encodeURIComponent(hostId)}/diagnostic`, {
      limit: 80,
    })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(errMsg(e)))
    return () => {
      alive = false
    }
  }, [hostId])

  const host = data?.host ?? {}
  const gate =
    host.placement_gate_open === true
      ? 'open'
      : host.placement_gate_open === false
        ? 'closed'
        : 'unknown'
  const audit = (data?.audit ?? []).slice(0, 20)

  return (
    <Modal
      open={hostId !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="Host 诊断"
      description={name}
      className="max-w-2xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {err ? (
        <p className="text-[13px] text-danger">读取失败：{err}</p>
      ) : !data ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> 加载中…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-[12px] text-faint">调度状态</p>
              <div className="mt-1.5 flex items-center gap-2">
                <Badge tone={hostStatusTone(String(host.status ?? 'unknown'))}>
                  {String(host.status ?? 'unknown')}
                </Badge>
                <Badge
                  tone={gate === 'open' ? 'success' : gate === 'closed' ? 'warning' : 'neutral'}
                >
                  gate {gate}
                </Badge>
              </div>
              <p className="mt-2 break-all font-mono text-[11px] text-faint">
                {String(host.id ?? hostId)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-[12px] text-faint">运行镜像</p>
              <p className="mt-1.5 break-all font-mono text-[11px] text-muted">
                desired: {String(data.pool.desiredImageId ?? host.desired_image_id ?? '—')}
              </p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted">
                loaded: {String(host.loaded_image_id ?? '—')}
              </p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[12px] text-faint">最近 host audit（最多 20 条）</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-[12px]">
                <thead className="bg-surface">
                  <tr className="border-b border-border text-faint">
                    <th className="px-2 py-1.5 text-left font-medium">时间</th>
                    <th className="px-2 py-1.5 text-left font-medium">事件</th>
                    <th className="px-2 py-1.5 text-left font-medium">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-2 py-3 text-center text-faint">
                        暂无 audit
                      </td>
                    </tr>
                  ) : (
                    audit.map((a, i) => {
                      const details = JSON.stringify(a.details ?? a.after ?? a.before ?? {})
                      const rowKey = `${a.created_at || a.createdAt || ''}-${a.action || a.event || ''}-${i}`
                      return (
                        <tr key={rowKey} className="border-b border-border/60 last:border-0">
                          <td className="px-2 py-1.5 font-mono text-faint">
                            {a.created_at || a.createdAt || ''}
                          </td>
                          <td className="px-2 py-1.5 text-fg">{a.action || a.event || ''}</td>
                          <td className="px-2 py-1.5 font-mono text-muted">
                            {details.slice(0, 300)}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <details>
            <summary className="cursor-pointer text-[12px] text-muted">原始诊断 JSON</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-hover p-3 font-mono text-[11px] text-fg">
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </Modal>
  )
}

// ─── 设置 VPS 到期 ─────────────────────────────────────────────────────

export function SetExpiresModal({
  target,
  onClose,
  onSaved,
}: {
  /** null = 关闭。 */
  target: { id: string; name: string; current: string | null } | null
  onClose: () => void
  onSaved: () => void
}) {
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (target) {
      setVal(isoToShanghaiInput(target.current))
      setErr(null)
    }
  }, [target])

  const submit = async (expiresAt: string | null) => {
    if (!target) return
    setBusy(true)
    setErr(null)
    try {
      await sendVoid('POST', `/v3/compute-hosts/${encodeURIComponent(target.id)}/expires-at`, {
        expires_at: expiresAt,
      })
      onSaved()
      onClose()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title="设置 VPS 到期"
      description={`${target?.name ?? ''} · 北京时间（UTC+8）`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="secondary" onClick={() => submit(null)} disabled={busy}>
            清空
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              const iso = shanghaiInputToIso(val)
              if (!iso) {
                setErr('请先填写到期时间，或点"清空"')
                return
              }
              void submit(iso)
            }}
          >
            {busy && <Spinner size={14} />}
            保存
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[12px] text-muted">
        清空（永久/未填）请点"清空"按钮，直接留空保存会被拒绝。
      </p>
      <Field id="he-input" label="到期时间">
        <Input
          id="he-input"
          type="datetime-local"
          value={val}
          onChange={(e) => setVal(e.target.value)}
        />
      </Field>
      {err && <p className="mt-3 text-[13px] text-danger">{err}</p>}
    </Modal>
  )
}

// ─── 镜像分发 ──────────────────────────────────────────────────────────

/**
 * 把 OC_RUNTIME_IMAGE 分发到指定 host 或全部 ready host。
 * 3.5GB 慢链路可能数分钟，分发中禁用按钮 + spinner；返回 per-host outcome。
 */
export function DistributeImageModal({
  open,
  onOpenChange,
  hosts,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  hosts: HostRow[]
  onDone: () => void
}) {
  // 可分发目标：非 self、非 revoked。
  const targets = hosts.filter((h) => h.name !== 'self' && h.status !== 'revoked')
  const [target, setTarget] = useState<string>('__all__')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<DistributeResult[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    if (open) {
      setTarget('__all__')
      setResults(null)
      setErr(null)
    }
  }, [open])

  const options = [
    { label: '所有 ready host', value: '__all__' },
    ...targets.map((h) => ({ label: h.name, value: h.id })),
  ]

  const run = async () => {
    const mySeq = ++seqRef.current
    setBusy(true)
    setErr(null)
    setResults(null)
    try {
      if (target === '__all__') {
        const r = await adminSend<{ results: DistributeResult[] }>('POST', '/v3/distribute-image')
        if (mySeq === seqRef.current) setResults(r.results ?? [])
      } else {
        const r = await adminSend<{ result: DistributeResult }>(
          'POST',
          `/v3/compute-hosts/${encodeURIComponent(target)}/distribute-image`,
        )
        if (mySeq === seqRef.current) setResults(r.result ? [r.result] : [])
      }
      onDone()
    } catch (e) {
      if (mySeq === seqRef.current) setErr(errMsg(e))
    } finally {
      if (mySeq === seqRef.current) setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (busy) return // 分发中不许关（在飞请求）
        onOpenChange(o)
      }}
      title="分发运行镜像"
      description="把 OC_RUNTIME_IMAGE 推到目标 host。3.5GB 慢链路可能耗时数分钟。"
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            关闭
          </Button>
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy && <Spinner size={14} />}
            {busy ? '分发中…' : '开始分发'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-faint">目标</span>
          <SelectFilter value={target} options={options} onChange={setTarget} />
        </div>

        {busy && <p className="text-[12px] text-muted">正在通过 SSH stream 镜像，请勿关闭页面…</p>}
        {err && <p className="text-[13px] text-danger">分发失败：{err}</p>}

        {results && (
          <div className="flex flex-col gap-2">
            {results.length === 0 ? (
              <p className="text-[13px] text-faint">无可分发 host（0 ready）。</p>
            ) : (
              results.map((r) => (
                <div
                  key={r.hostId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]"
                >
                  <span className="truncate font-medium text-fg">{r.hostName}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-faint tabular-nums">
                      {(r.durationMs / 1000).toFixed(1)}s
                      {r.bytes ? ` · ${(r.bytes / 1e9).toFixed(2)}GB` : ''}
                    </span>
                    <Badge tone={distributeOutcomeTone(r.outcome)}>{r.outcome}</Badge>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
