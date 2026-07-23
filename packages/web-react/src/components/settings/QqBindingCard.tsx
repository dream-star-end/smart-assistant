import { Check, Copy, ExternalLink, Link2, RefreshCw, Unlink } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { qrDataUrl } from '../../admin/pages/alerts/qr/qr'
import { type QqBindingStart, type QqBindingStatus, api, apiErrorMessage } from '../../lib/api'
import type { PrefsView } from '../../lib/modelPreferences'
import type { AuthSession } from '../../lib/types'
import { Alert, Button, Spinner, Switch } from '../ui'

export function QqBindingCard({
  auth,
  prefs,
  onPatch,
}: {
  auth: AuthSession
  prefs: PrefsView
  onPatch: (patch: Record<string, unknown>) => Promise<void>
}) {
  const [status, setStatus] = useState<QqBindingStatus | null>(null)
  const [binding, setBinding] = useState<QqBindingStart | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await api.getQqBinding(auth)
    setStatus(next)
    if (next.bound) setBinding(null)
    return next
  }, [auth])

  useEffect(() => {
    void refresh().catch((err) => {
      setError(apiErrorMessage(err, 'QQ 绑定状态加载失败'))
    })
  }, [refresh])

  useEffect(() => {
    if (!binding) return
    const poll = window.setInterval(() => {
      if (Date.now() >= binding.expires_at) {
        window.clearInterval(poll)
        return
      }
      void refresh().catch(() => {})
    }, 2_000)
    return () => window.clearInterval(poll)
  }, [binding, refresh])

  const qr = useMemo(
    () => (binding?.entry_url ? qrDataUrl(binding.entry_url, 220) : null),
    [binding?.entry_url],
  )

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const next = await api.startQqBinding(auth)
      setBinding(next)
      setStatus((current) => ({ ...(current ?? { bound: false }), available: true }))
    } catch (err) {
      setError(apiErrorMessage(err, '生成绑定码失败'))
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    if (!window.confirm('解绑后，尚未发出的 QQ 消息会立即取消。确定解绑吗？')) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteQqBinding(auth)
      setBinding(null)
      await refresh()
    } catch (err) {
      setError(apiErrorMessage(err, '解绑失败'))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-4 text-[12.5px] text-muted">
        <Spinner /> 正在读取 QQ 绑定状态…
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex items-start gap-3 px-4 py-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#12b7f5] text-white">
          <Link2 size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-fg">QQ 对话与通知</span>
            {status.bound && (
              <span className="rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success">
                已绑定
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            使用平台统一 QQ Bot，无需创建机器人。绑定后可直接聊天，也能接收定时任务和提醒。
          </p>
        </div>
      </div>

      {error && (
        <div className="px-4 pb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {!status.available ? (
        <div className="border-t border-border px-4 py-3 text-[12px] text-faint">
          QQ Bot 尚未完成平台配置，配置完成后这里会自动开放。
        </div>
      ) : status.bound ? (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] text-fg">主动推送到 QQ</div>
              <div className="mt-0.5 text-[11.5px] text-faint">
                定时任务与提醒优先发送到已绑定 QQ
              </div>
            </div>
            <Switch
              checked={prefs.qq_proactive_push !== false}
              onCheckedChange={(checked) => void onPatch({ qq_proactive_push: checked })}
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-elevated px-3 py-2.5">
            <span className="text-[11.5px] text-muted">
              QQ {status.maskedOpenid ?? '已安全绑定'}
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void unbind()}>
              <Unlink size={14} /> 解绑
            </Button>
          </div>
        </div>
      ) : binding ? (
        <div className="border-t border-border px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
            {qr && (
              <div className="mx-auto overflow-hidden rounded-xl border border-border bg-white p-2">
                <img src={qr} alt="QQ Bot 入口二维码" className="size-[204px]" />
              </div>
            )}
            <div className="flex min-w-0 flex-col justify-center">
              <div className="text-[12.5px] font-medium text-fg">1. 用 QQ 扫码进入机器人</div>
              <a
                href={binding.entry_url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex w-fit items-center gap-1 text-[12px] text-accent hover:underline"
              >
                手机端也可直接打开 <ExternalLink size={13} />
              </a>
              <div className="mt-4 text-[12.5px] font-medium text-fg">2. 向机器人发送</div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(`/bind ${binding.bind_code}`)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1_500)
                }}
                className="mt-2 flex items-center justify-between rounded-xl border border-border bg-elevated px-3 py-3 font-mono text-[15px] font-semibold tracking-wider text-fg"
              >
                <span>/bind {binding.bind_code}</span>
                {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
              </button>
              <p className="mt-2 text-[11.5px] text-faint">
                绑定码 10 分钟内有效；发送成功后本页会自动变为已绑定。
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-3 w-fit"
                disabled={busy}
                onClick={() => void start()}
              >
                <RefreshCw size={14} /> 换一个绑定码
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-t border-border px-4 py-3">
          <Button disabled={busy} onClick={() => void start()}>
            {busy ? <Spinner /> : <Link2 size={15} />} 扫码绑定 QQ
          </Button>
        </div>
      )}
    </div>
  )
}
