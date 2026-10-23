import type { SystemActionDetail, SystemActionPreview, SystemActionSummary } from '@openclaude/protocol/browser'
import { useEffect, useRef, useState } from 'react'
import { useToolCardActions } from '../tool/context'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { Frame } from './shell'

const LABELS: Record<SystemActionSummary['state'], string> = {
  prepared: '待你确认', approved_waiting_browser: '待本设备执行', executing: '处理中',
  succeeded: '已完成', failed: '未完成', denied: '已忽略', expired: '已过期', unknown: '结果待核对',
}
function plainTitle(s: string): string {
  // Frame's title supports inline Markdown. Action labels always remain plain text.
  return s.replaceAll('[', '［').replaceAll(']', '］').replaceAll('`', '｀').replaceAll('*', '＊')
}
function Price({ preview }: { preview: SystemActionPreview }) {
  const p = preview.price
  let amount = ''
  if (p.kind === 'fixed' && /^\d{1,24}$/.test(p.amountFen ?? '')) {
    const n = BigInt(p.amountFen!)
    amount = `${p.unit === 'CNY' ? '¥' : ''}${n / 100n}.${String(n % 100n).padStart(2, '0')}${p.unit === 'credits' ? ' 积分' : ''}`
  }
  return <div className="space-y-2 text-body">
    <p className="font-medium text-fg">{p.label}{amount ? ` · ${amount}` : ''}</p>
    {p.rates?.map((r, i) => <p className="text-muted" key={`${i}:${r.label}`}>{r.label}：{r.value}</p>)}
    {p.note && <p className="text-muted">{p.note}</p>}
  </div>
}
function Preview({ value }: { value: SystemActionPreview }) {
  return <div className="space-y-4">
    <p className="whitespace-pre-wrap text-body text-muted">{value.description}</p>
    <dl className="oc-iui-kv"><div><dt>影响范围</dt><dd>{value.scope}</dd></div></dl>
    {value.before.length > 0 && <section aria-label="当前值"><h3 className="mb-2 text-body font-medium">当前</h3>
      <dl className="oc-iui-kv">{value.before.map((r, i) => <div key={`${i}:${r.label}`}><dt>{r.label}</dt><dd className="whitespace-pre-wrap break-words">{r.value || '未设置'}</dd></div>)}</dl>
    </section>}
    {value.after.length > 0 && <section aria-label="将更改为"><h3 className="mb-2 text-body font-medium">将更改为</h3>
      <dl className="oc-iui-kv">{value.after.map((r, i) => <div key={`${i}:${r.label}`}><dt>{r.label}</dt><dd className="whitespace-pre-wrap break-words">{r.value || '清空'}</dd></div>)}</dl>
    </section>}
    <Price preview={value} />
    {value.consequences.length > 0 && <div className={value.destructive ? 'text-danger' : 'text-muted'}>
      <p className="mb-1 text-body font-medium">确认后会发生什么</p>
      <ul className="space-y-1 text-body">{value.consequences.map((v, i) => <li key={`${i}:${v}`}>{v}</li>)}</ul>
    </div>}
  </div>
}

/** Only server-fetched details enter the card. Model JSON can supply an opaque id, never parameters. */
export function SystemActionBlock({ proposalId, readOnly = false }: { proposalId: string; readOnly?: boolean }) {
  const actions = useToolCardActions().systemActions
  const scopeKey = `${actions?.identityKey ?? 'unavailable'}:${proposalId}:${readOnly}`
  const scope = useRef(scopeKey); scope.current = scopeKey
  const [record, setRecord] = useState<{ scope: string; detail: SystemActionDetail } | null>(null)
  const [challenge, setChallenge] = useState<{ scope: string; detail: SystemActionDetail; nonce: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, tick] = useState(0)
  const detail = record?.scope === scopeKey ? record.detail : null
  const confirmation = challenge?.scope === scopeKey ? challenge : null
  const allowed = !readOnly && Boolean(actions)
  const active = detail && ['prepared', 'approved_waiting_browser'].includes(detail.state)
  const expired = Boolean(active && detail.expiresAt <= Date.now()) || detail?.state === 'expired'

  function accept(d: SystemActionDetail, key: string) {
    if (scope.current !== key || d.id !== proposalId) return
    setRecord({ scope: key, detail: d })
  }
  async function refresh() {
    if (!allowed || !actions) return
    const key = scopeKey
    try {
      const d = await actions.getDetail(proposalId)
      if (scope.current !== key) return
      if (d.id !== proposalId) throw new Error('mismatched action')
      accept(d, key); setError('')
    } catch { if (scope.current === key) setError('暂时无法核验这项操作，请刷新状态后再试。') }
  }
  useEffect(() => {
    setRecord(null); setChallenge(null); setError(''); setBusy(false)
    if (!allowed || !actions) return
    let active = true
    actions.getDetail(proposalId).then(d => {
      if (!active || scope.current !== scopeKey) return
      if (d.id !== proposalId) { setError('这项操作无法核验。'); return }
      setRecord({ scope: scopeKey, detail: d })
    }).catch(() => { if (active && scope.current === scopeKey) setError('暂时无法核验这项操作，请刷新状态后再试。') })
    return () => { active = false }
  }, [scopeKey, allowed, actions, proposalId])
  useEffect(() => {
    if (!active || !detail) return
    const timer = setTimeout(() => tick(n => n + 1), Math.max(0, detail.expiresAt - Date.now()) + 10)
    return () => clearTimeout(timer)
  }, [detail?.expiresAt, detail?.state, active])
  useEffect(() => {
    if (!allowed || !actions || !['executing', 'approved_waiting_browser'].includes(detail?.state ?? '')) return
    let fetching = false
    const timer = setInterval(() => {
      if (fetching || document.hidden || scope.current !== scopeKey) return
      fetching = true
      actions.getDetail(proposalId).then(d => accept(d, scopeKey)).catch(() => {}).finally(() => { fetching = false })
    }, 5000)
    return () => clearInterval(timer)
  }, [allowed, actions, detail?.state, proposalId, scopeKey])

  async function openConfirmation() {
    if (!actions || !allowed || busy || expired || detail?.state !== 'prepared') return
    const key = scopeKey
    setBusy(true); setError('')
    try {
      const c = await actions.getConfirmation(proposalId)
      if (scope.current !== key) return
      if (c.detail.id !== proposalId || c.detail.state !== 'prepared' || !c.detail.preview || c.detail.expiresAt <= Date.now()) throw new Error('not confirmable')
      accept(c.detail, key)
      setChallenge({ ...c, scope: key })
    } catch { if (scope.current === key) { setError('操作或价格可能已变化，请刷新并重新查看。'); void refresh() } }
    finally { if (scope.current === key) setBusy(false) }
  }
  async function confirm() {
    if (!actions || !confirmation || busy || expired || !confirmation.detail.preview) return
    const key = scopeKey, c = confirmation
    setBusy(true); setError('')
    // Discard the challenge after one attempt, including a transport failure.
    setChallenge(null)
    try {
      const result = await actions.confirm(proposalId, { nonce: c.nonce, previewHash: c.detail.previewHash })
      if (scope.current !== key) return
      if (result.id !== proposalId) throw new Error('mismatched action')
      setRecord({ scope: key, detail: { ...c.detail, ...result, preview: null } })
    } catch { if (scope.current === key) { setError('结果尚未核实，请刷新状态，勿重复执行。'); void refresh() } }
    finally { if (scope.current === key) setBusy(false) }
  }
  async function deny() {
    if (!actions || !allowed || busy || detail?.state !== 'prepared') return
    const key = scopeKey
    setBusy(true)
    try {
      const result = await actions.deny(proposalId)
      if (scope.current === key && result.id === proposalId) setRecord({ scope: key, detail: { ...detail, ...result, preview: null } })
    } catch { if (scope.current === key) setError('尚未确认是否已忽略，请刷新状态。') }
    finally { if (scope.current === key) setBusy(false) }
  }
  const status = expired ? '已过期' : detail?.state === 'succeeded'
    ? detail.result?.completion === 'awaiting_user' ? '待你完成' : detail.result?.completion === 'accepted' ? '已提交' : LABELS.succeeded
    : detail ? LABELS[detail.state] : allowed ? '核验中' : '只读记录'
  return <>
    <Frame kind="form" title={plainTitle(detail?.title ?? '系统操作')} actions={<span className="oc-iui-chip">{status}</span>}>
      <div className="space-y-4 px-4 pb-4">
        {!allowed && <p className="text-body text-muted">请在本人登录的会话中核验并操作。</p>}
        {allowed && !detail && !error && <p className="text-body text-muted" role="status">正在读取操作详情…</p>}
        {allowed && detail?.preview && <Preview value={detail.preview} />}
        {detail?.result && <p className="text-body text-fg" role="status">{detail.result.summary}</p>}
        {detail?.state === 'unknown' && <p className="text-body text-muted">先核对实际结果，再决定下一步；请勿重复执行。</p>}
        {error && <p className="text-body text-muted" role="alert">{error}</p>}
        {allowed && <div className="flex flex-wrap justify-end gap-2">
          {detail?.state === 'prepared' && !expired && <>
            <Button size="sm" disabled={busy} onClick={() => void deny()}>暂时不用</Button>
            <Button size="sm" variant="accent" loading={busy} onClick={() => void openConfirmation()}>查看并确认</Button>
          </>}
          {(error || expired || detail?.state === 'unknown') && <Button size="sm" disabled={busy} onClick={() => void refresh()}>刷新状态</Button>}
        </div>}
        {allowed && !expired && detail && (['approved_waiting_browser', 'executing'].includes(detail.state) || (detail.state === 'succeeded' && detail.result?.completion === 'awaiting_user')) && actions?.renderContinuation?.(proposalId)}
      </div>
    </Frame>
    <Modal open={Boolean(confirmation)} onOpenChange={open => { if (!open && !busy) setChallenge(null) }} size="sm" mobile="sheet"
      title={confirmation?.detail.preview?.title ?? '确认系统操作'} description="请核对范围、费用和后果，确认后才会执行。"
      footer={<>
        <Button disabled={busy} onClick={() => setChallenge(null)}>取消</Button>
        <Button variant={confirmation?.detail.preview?.destructive ? 'danger' : 'accent'} loading={busy} disabled={expired || !confirmation?.detail.preview} onClick={() => void confirm()}>
          {confirmation?.detail.preview?.destructive ? '确认执行此操作' : '确认执行'}
        </Button>
      </>}
    >{confirmation?.detail.preview && <Preview value={confirmation.detail.preview} />}</Modal>
  </>
}
