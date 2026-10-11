/* 管理中心「插件」分区的组成部分 —— 从 ConnectorsTab.tsx 原样拆出（OCV5-379），行为不变。 */
import { Check, ExternalLink, QrCode } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../../../lib/api'
import type {
  KnowledgePlanetSetupView,
  RuntimePluginAccount,
  RuntimePluginCatalogEntry,
} from '../../../lib/connectors'
import { managedPluginProvider, managedSetupFailureText } from '../../../lib/managedPluginProviders'
import type { AuthSession } from '../../../lib/types'
import { Alert, Button, Modal, Skeleton, Spinner } from '../../ui'
import { errText } from './shared'

export function ManagedBrowserSetupDialog({
  auth,
  plugin,
  relinkAccountId,
  onClose,
  onBound,
}: {
  auth: AuthSession
  plugin: RuntimePluginCatalogEntry | null
  relinkAccountId: string | null
  onClose: () => void
  onBound: (agentReady: boolean) => void
}) {
  const provider = managedPluginProvider(plugin?.slug)
  const { label, scanner, qrAlt } = provider
  const [starting, setStarting] = useState(false)
  const [setup, setSetup] = useState<KnowledgePlanetSetupView | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [loadedQrKey, setLoadedQrKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reportedActive, setReportedActive] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const setupSessionId = setup?.sessionId ?? null
  const setupStatus = setup?.status ?? null
  const setupQrReady = setup?.qrReady === true
  const hasSetupQrRevision =
    typeof setup?.qrRevision === 'number' && Number.isSafeInteger(setup.qrRevision)
  const setupQrRevision = hasSetupQrRevision ? Number(setup?.qrRevision) : setupQrReady ? 1 : 0
  const setupPhase =
    setup?.phase ??
    (setupStatus === 'active'
      ? 'active'
      : setupStatus === 'finalizing'
        ? 'saving'
        : setupStatus === 'waiting_for_scan'
          ? setupQrReady
            ? 'waiting_for_scan'
            : 'generating_qr'
          : setupStatus)

  const findExistingAccount = useCallback(async (): Promise<RuntimePluginAccount | undefined> => {
    const management = await api.getPluginManagement(auth)
    return management.accounts.find(
      (item) => item.provider === provider.slug && item.status === 'active',
    )
  }, [auth, provider])

  const markExistingAccountActive = useCallback(
    (account: RuntimePluginAccount, sessionId?: string) => {
      const now = new Date().toISOString()
      setSetup({
        sessionId: sessionId ?? `existing-${account.id}`,
        status: 'active',
        phase: 'active',
        qrReady: false,
        agentReady: account.executable,
        createdAt: now,
        expiresAt: now,
        accountId: account.id,
      })
      setError(null)
    },
    [],
  )

  useEffect(
    () => () => {
      if (qrUrl) URL.revokeObjectURL(qrUrl)
    },
    [qrUrl],
  )

  useEffect(() => {
    if (
      !setupSessionId ||
      !setupStatus ||
      !['waiting_for_scan', 'finalizing'].includes(setupStatus)
    )
      return
    let cancelled = false
    let timer: number | undefined
    const poll = () => {
      const request = provider.get(auth, setupSessionId)
      void request
        .then((next) => {
          if (!cancelled) {
            setSetup(next)
            setError(null)
          }
        })
        .catch(async (e) => {
          if (cancelled) return
          if (e instanceof ApiError && e.code === 'SETUP_NOT_FOUND') {
            if (!relinkAccountId) {
              const account = await findExistingAccount().catch(() => undefined)
              if (cancelled) return
              if (account) {
                markExistingAccountActive(account, setupSessionId)
                return
              }
            }
            setSetup((current) =>
              current
                ? { ...current, status: 'failed', qrReady: false, errorCode: 'SETUP_NOT_FOUND' }
                : current,
            )
            setError('扫码会话已失效，可能是授权服务刚刚更新；请重新生成二维码。')
            return
          }
          setError(errText(e, '读取扫码状态失败，请重试'))
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(poll, 900)
        })
    }
    timer = window.setTimeout(poll, 900)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [
    auth,
    findExistingAccount,
    markExistingAccountActive,
    provider,
    relinkAccountId,
    setupSessionId,
    setupStatus,
  ])

  useEffect(() => {
    if (!setupQrReady || !setupSessionId) return
    const qrKey = `${setupSessionId}:${setupQrRevision}`
    const revisionBound = provider.slug === 'knowledge-planet' && hasSetupQrRevision
    if (revisionBound && loadedQrKey === qrKey) return
    let cancelled = false
    let timer: number | undefined
    const load = () => {
      const request = provider.qr(auth, setupSessionId)
      void request
        .then((blob) => {
          if (cancelled) return
          const next = URL.createObjectURL(blob)
          setQrUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous)
            return next
          })
          if (revisionBound) setLoadedQrKey(qrKey)
          setError(null)
          timer = window.setTimeout(load, 8_000)
        })
        .catch((e) => {
          if (!cancelled) {
            setError(errText(e, '二维码加载失败，请重试'))
            timer = window.setTimeout(load, 900)
          }
        })
    }
    load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [
    auth,
    hasSetupQrRevision,
    loadedQrKey,
    provider,
    setupQrReady,
    setupQrRevision,
    setupSessionId,
  ])

  useEffect(() => {
    if (setupStatus !== 'active' || reportedActive) return
    if (relinkAccountId && setup?.accountId !== relinkAccountId) {
      setSetup((current) =>
        current
          ? {
              ...current,
              status: 'failed',
              phase: 'failed',
              qrReady: false,
              errorCode: 'ACCOUNT_STALE',
            }
          : current,
      )
      setError('重新登录结果与目标账号不一致，请重试。')
      return
    }
    setReportedActive(true)
    onBound(setup?.agentReady !== false)
  }, [onBound, relinkAccountId, reportedActive, setup?.accountId, setup?.agentReady, setupStatus])

  const start = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      setSetup(await provider.start(auth, relinkAccountId ?? undefined))
    } catch (e) {
      if (!relinkAccountId && e instanceof ApiError && e.code === 'ACCOUNT_ALREADY_EXISTS') {
        const account = await findExistingAccount().catch(() => undefined)
        if (account) {
          markExistingAccountActive(account)
          return
        }
      }
      setError(errText(e, `发起${label}授权失败`))
    } finally {
      setStarting(false)
    }
  }

  const close = async () => {
    if (cancelling) return
    if (setup?.status === 'finalizing') return
    if (setup?.status === 'waiting_for_scan') {
      setCancelling(true)
      setError(null)
      try {
        await provider.cancel(auth, setup.sessionId)
      } catch (e) {
        setError(errText(e, '取消授权失败，请重试'))
        setCancelling(false)
        return
      }
      setCancelling(false)
    }
    onClose()
  }

  const retry = () => {
    if (qrUrl) URL.revokeObjectURL(qrUrl)
    setQrUrl(null)
    setSetup(null)
    setError(null)
    setReportedActive(false)
  }

  const terminalFailure = setup && ['cancelled', 'expired', 'failed'].includes(setup.status)
  return (
    <Modal
      open={plugin != null}
      onOpenChange={(open) => !open && void close()}
      title={relinkAccountId ? `重新登录${label}` : `授权${label}`}
      description={
        relinkAccountId
          ? `${scanner}扫码成功前会保留当前登录；成功后替换登录状态，并关闭写入能力和免逐次确认。`
          : `${scanner}扫码一次即可复用登录。授权后可读取；发布、互动、编辑和删除默认关闭，需另行开启。`
      }
      footer={
        <>
          {setup?.status !== 'active' && (
            <Button
              variant="ghost"
              size="sm"
              loading={cancelling}
              disabled={setup?.status === 'finalizing'}
              onClick={() => void close()}
            >
              {setup?.status === 'finalizing' ? '正在安全保存…' : '取消'}
            </Button>
          )}
          {!setup && (
            <Button variant="primary" size="sm" loading={starting} onClick={() => void start()}>
              <QrCode size={13} /> 同意并生成二维码
            </Button>
          )}
          {terminalFailure && (
            <Button variant="secondary" size="sm" onClick={retry}>
              重新授权
            </Button>
          )}
          {setup?.status === 'active' && (
            <Button variant="primary" size="sm" onClick={onClose}>
              <Check size={13} /> 完成
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && (
          <Alert tone="danger" density="compact">
            {error}
          </Alert>
        )}
        {!setup && (
          <p className="text-meta leading-relaxed text-muted">
            点击“同意并生成二维码”即表示你同意用{scanner}扫码保存{label}
            登录状态。登录状态加密保存在服务端，插件只访问固定域名；扫码不会开启写入，写入需在账号行另行开启，且每次执行仍需确认。
          </p>
        )}
        {setup && !terminalFailure && (
          <ol
            className="grid grid-cols-4 gap-1 rounded-lg border border-border bg-surface px-2 py-2"
            aria-label={`${label}授权进度`}
          >
            {['生成二维码', `${scanner}确认`, '加密保存', '授权完成'].map((stepLabel, index) => {
              const current =
                setupPhase === 'generating_qr'
                  ? 0
                  : setupPhase === 'waiting_for_scan'
                    ? 1
                    : setupPhase === 'scan_confirmed' || setupPhase === 'saving'
                      ? 2
                      : 3
              const complete = setupPhase === 'active' || index < current
              const active = index === current && setupPhase !== 'active'
              return (
                <li
                  key={stepLabel}
                  className={`flex min-w-0 flex-col items-center gap-1 text-center text-caption ${
                    complete || active ? 'text-accent' : 'text-faint'
                  }`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full border ${
                      complete
                        ? // accent-fg 才是 accent 底上的可读前景（暗色主题下 accent 是浅紫，
                          // 白色对勾会糊掉）；与 Button 的 accent 变体同一套判据。
                          'border-accent bg-accent text-accent-fg'
                        : active
                          ? 'border-accent bg-accent-soft'
                          : 'border-border'
                    }`}
                  >
                    {complete ? <Check size={12} /> : active ? <Spinner /> : index + 1}
                  </span>
                  <span className="truncate">{stepLabel}</span>
                </li>
              )
            })}
          </ol>
        )}
        {setup?.status === 'waiting_for_scan' && (
          // 白底卡**只包二维码图像**：二维码必须在白底上才扫得动，但任何跟随主题的
          // token 文字落在写死的白底上都会失联（暗色 --muted 对白底约 1.5:1）。
          // 说明文字与链接一律留在主题面上，扫码这条一次性关键路径才不会失去指引。
          <div className="flex flex-col items-center gap-3">
            {qrUrl ? (
              <div className="flex justify-center rounded-xl border border-border bg-white p-4">
                <img src={qrUrl} alt={qrAlt} className="size-56 object-contain" />
              </div>
            ) : (
              <div className="flex min-h-64 w-full items-center justify-center rounded-xl border border-border bg-hover p-4">
                <Skeleton className="size-56 rounded-lg" />
              </div>
            )}
            <output className="text-center text-meta text-muted" aria-live="polite">
              {setupPhase === 'generating_qr'
                ? `正在安全生成${scanner}二维码，通常需要几秒…`
                : qrUrl
                  ? `二维码已生成 · 请使用${scanner}扫码，并在手机上确认登录`
                  : '正在加载二维码…'}
            </output>
            {qrUrl && (
              <a
                href={qrUrl}
                target="_blank"
                rel="noreferrer"
                // 触屏补 44px 命中高(t-762 manage#4:此前 18px);桌面 hover 可用时零变化。
                className="inline-flex items-center gap-1 rounded-sm text-meta text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
              >
                <ExternalLink size={12} /> 单独打开二维码
              </a>
            )}
          </div>
        )}
        {setup?.status === 'finalizing' && (
          <output
            className="flex items-center justify-center gap-2 py-12 text-body text-muted"
            aria-live="polite"
          >
            <Spinner />{' '}
            {setupPhase === 'scan_confirmed'
              ? `${scanner}扫码已确认 · 正在校验并关闭临时登录环境…`
              : '登录状态有效 · 正在加密保存账号…'}
          </output>
        )}
        {setup?.status === 'active' && (
          <Alert tone="success">
            {setup.agentReady === false
              ? `${scanner}登录已确认，登录信息已加密保存。系统完成插件升级后会自动启用，无需再次扫码。`
              : `授权成功，Agent 现在可以直接读取${label}内容；写入能力保持关闭，需你另行开启。`}
          </Alert>
        )}
        {terminalFailure && (
          <Alert tone="warning">{managedSetupFailureText(provider, setup)}</Alert>
        )}
      </div>
    </Modal>
  )
}
