import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../../../lib/api'
import type {
  LiteratureSetupCapability,
  LiteratureSetupView,
  RuntimePluginCatalogEntry,
} from '../../../lib/connectors'
import type { AuthSession } from '../../../lib/types'
import { Alert, Button, Input, Modal, Spinner } from '../../ui'

const pending = (value: LiteratureSetupView | null) =>
  value?.status === 'running' || value?.status === 'manual_required'
const messages: Record<string, string> = {
  CREDENTIALS_INVALID: '网站提示账号或密码错误，请核对后重新登录。',
  UPSTREAM_BLOCKED: '网站暂时限制访问，请稍后重试。',
  SUBMISSION_UNCERTAIN: '网站登录结果尚不能确认，请核对连接状态后再试。',
  PERSISTENCE_UNCERTAIN: '保存结果尚不能确认，请关闭后核对连接状态。',
  ACCOUNT_STALE: '账号状态已变化，请关闭并刷新连接列表。',
  NOT_INSTALLED: '请先安装当前版本的文献数据库插件。',
  UNAVAILABLE: '文献数据库登录暂未就绪。',
  RATE_LIMITED: '登录次数已达本小时上限，请稍后再试。',
  CAPACITY: '登录服务正在处理其他请求，请稍后再试。',
  TIMEOUT: '本次登录已过期，请重新发起。',
}
function failure(error: unknown): string {
  return error instanceof ApiError && error.code && messages[error.code]
    ? messages[error.code]!
    : '操作未能完成，请稍后重试。'
}
export function LiteratureSetupDialog({
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
  const [capability, setCapability] = useState<LiteratureSetupCapability | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [terms, setTerms] = useState(false)
  const [view, setView] = useState<LiteratureSetupView | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [answered, setAnswered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const epoch = auth.snapshot().epoch
  const run = useRef<{ active: boolean; epoch: number; operationId?: string; reported: boolean }>({
    active: false,
    epoch,
    reported: false,
  })
  const requestRevision = useRef(0)
  const mutating = useRef(false)
  const closing = useRef(false)
  const current = useCallback(
    (state = run.current) =>
      state.active && run.current === state && auth.snapshot().epoch === state.epoch,
    [auth],
  )
  const boundRef = useRef(onBound)
  boundRef.current = onBound
  const authorizationKey = plugin ? `${plugin.versionId}:${relinkAccountId ?? 'new'}` : null
  const accept = useCallback(
    (next: LiteratureSetupView, state = run.current) => {
      if (!state.active || run.current !== state || auth.snapshot().epoch !== state.epoch) return
      state.operationId = next.operationId
      setView(next)
      if (next.status === 'authenticated' && !state.reported) {
        if (!next.accountId || (relinkAccountId && next.accountId !== relinkAccountId)) {
          setError(messages.ACCOUNT_STALE!)
          return
        }
        state.reported = true
        boundRef.current(next.agentReady === true)
      }
    },
    [auth, relinkAccountId],
  )
  useEffect(() => {
    const state = {
      active: true,
      epoch,
      reported: false,
      operationId: undefined as string | undefined,
    }
    run.current = state
    requestRevision.current++
    mutating.current = false
    closing.current = false
    setUsername('')
    setPassword('')
    setAnswer('')
    setTerms(false)
    setView(null)
    setCapability(null)
    setError(null)
    setBusy(false)
    if (authorizationKey)
      void api
        .getLiteratureSetupCapability(auth)
        .then((value) => {
          if (state.active && auth.snapshot().epoch === epoch) setCapability(value)
        })
        .catch((e) => {
          if (state.active && auth.snapshot().epoch === epoch) setError(failure(e))
        })
    return () => {
      state.active = false
      if (state.operationId && !state.reported && auth.snapshot().epoch === epoch)
        void api.cancelLiteratureSetup(auth, state.operationId).catch(() => {})
    }
  }, [auth, epoch, authorizationKey])
  const operationId = view?.operationId
  const status = view?.status
  useEffect(() => {
    if (!operationId || (status !== 'running' && status !== 'manual_required')) return
    const state = run.current
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!current(state)) return
      const revision = requestRevision.current
      try {
        if (mutating.current) {
          timer = setTimeout(poll, 1200)
          return
        }
        const next = await api.getLiteratureSetup(auth, operationId)
        if (!stopped && !mutating.current && revision === requestRevision.current)
          accept(next, state)
      } catch (e) {
        if (
          !stopped &&
          !mutating.current &&
          revision === requestRevision.current &&
          state.active &&
          auth.snapshot().epoch === state.epoch
        ) {
          setError(failure(e))
          if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
            stopped = true
            setView((value) =>
              value
                ? {
                    ...value,
                    status: 'failed',
                    errorCode: e.code ?? 'NOT_FOUND',
                    agentReady: false,
                  }
                : value,
            )
          }
        }
      }
      if (!stopped && state.active && auth.snapshot().epoch === state.epoch)
        timer = setTimeout(poll, 1200)
    }
    timer = setTimeout(poll, 600)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [auth, operationId, status, accept, current])
  useEffect(() => {
    setAnswer('')
    setAnswered(false)
    setImage(null)
    if (!operationId || status !== 'manual_required' || !view?.challengeId) return
    const state = run.current
    if (!current(state)) return
    let stopped = false
    let url: string | undefined
    void api
      .getLiteratureSetupImage(auth, operationId, view.challengeId)
      .then((blob) => {
        if (stopped || !state.active || auth.snapshot().epoch !== state.epoch) return
        url = URL.createObjectURL(blob)
        setImage(url)
      })
      .catch(() => {
        if (!stopped && state.active && auth.snapshot().epoch === state.epoch)
          setError('验证码已失效，请关闭后重新登录。')
      })
    return () => {
      stopped = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [auth, operationId, status, view?.challengeId, current])
  const start = async () => {
    if (busy || !capability?.available || !terms) return
    const state = run.current
    if (!current(state)) {
      setUsername('')
      setPassword('')
      setAnswer('')
      return
    }
    const input = {
      username,
      password,
      acceptTerms: terms,
      ...(relinkAccountId ? { accountId: relinkAccountId } : {}),
    }
    const revision = ++requestRevision.current
    mutating.current = true
    setBusy(true)
    setError(null)
    setPassword('')
    try {
      const next = await api.startLiteratureSetup(auth, input)
      if (state.active) accept(next, state)
      else if (auth.snapshot().epoch === state.epoch)
        void api.cancelLiteratureSetup(auth, next.operationId).catch(() => {})
    } catch (e) {
      if (state.active && auth.snapshot().epoch === state.epoch) setError(failure(e))
    } finally {
      input.password = ''
      if (revision === requestRevision.current) {
        mutating.current = false
        if (state.active && auth.snapshot().epoch === state.epoch) setBusy(false)
      }
    }
  }
  const submitAnswer = async () => {
    if (!view?.challengeId || answered || busy || !/^[A-Za-z0-9]{1,8}$/.test(answer)) return
    const state = run.current
    if (!current(state)) {
      setUsername('')
      setPassword('')
      setAnswer('')
      return
    }
    const revision = ++requestRevision.current
    mutating.current = true
    setBusy(true)
    setAnswered(true)
    setError(null)
    const value = answer
    setAnswer('')
    try {
      const next = await api.answerLiteratureSetup(auth, view.operationId, view.challengeId, value)
      if (revision === requestRevision.current) accept(next, state)
    } catch {
      // POST outcome may be unknown. Poll only; never automatically repeat the answer.
      if (
        revision === requestRevision.current &&
        state.active &&
        auth.snapshot().epoch === state.epoch
      )
        setError('正在核对提交结果，请勿重复提交。')
    } finally {
      if (revision === requestRevision.current) {
        mutating.current = false
        if (state.active && auth.snapshot().epoch === state.epoch) setBusy(false)
      }
    }
  }
  const close = async () => {
    if ((busy && !view) || closing.current) return
    closing.current = true
    const state = run.current
    if (!current(state)) {
      setUsername('')
      setPassword('')
      setAnswer('')
      return
    }
    const revision = ++requestRevision.current
    mutating.current = true
    setBusy(true)
    try {
      if (view && pending(view)) {
        const result = await api.cancelLiteratureSetup(auth, view.operationId)
        if (!state.active || auth.snapshot().epoch !== state.epoch) return
        accept(result, state)
        if (result.errorCode === 'PERSISTENCE_UNCERTAIN' || result.errorCode === 'CLEANUP_FAILED') {
          setError(messages[result.errorCode] ?? '清理结果尚不能确认，请核对连接状态。')
          return
        }
      }
      setUsername('')
      setPassword('')
      setAnswer('')
      onClose()
    } catch (e) {
      if (current(state) && e instanceof ApiError && e.status === 404) {
        setUsername('')
        setPassword('')
        setAnswer('')
        onClose()
      } else if (current(state)) setError(failure(e))
    } finally {
      closing.current = false
      if (revision === requestRevision.current) {
        mutating.current = false
        if (state.active && auth.snapshot().epoch === state.epoch) setBusy(false)
      }
    }
  }
  return (
    <Modal
      open={plugin !== null}
      title={relinkAccountId ? '重新登录文献数据库' : '连接文献数据库'}
      onOpenChange={(open) => {
        if (!open) void close()
      }}
      description="仅连接 jieyoutsg.com。新登录成功前保留原账号。"
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy && !view} onClick={() => void close()}>
            关闭
          </Button>
          {!view && (
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!capability?.available || !terms || !username || !password}
              onClick={() => void start()}
            >
              登录并保存
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
        {!capability && !error && <Spinner />}
        {capability && !capability.available && (
          <Alert tone="warning">文献数据库登录暂未就绪。</Alert>
        )}
        {!view && capability?.available && (
          <>
            <label htmlFor="literature-setup-username" className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              网站账号
              <Input
                id="literature-setup-username"
                aria-label="网站账号"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={256}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label htmlFor="literature-setup-password" className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              网站密码
              <Input
                id="literature-setup-password"
                aria-label="网站密码"
                type="password"
                autoComplete="off"
                maxLength={512}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />{' '}
              我同意插件代为登录、检索及下载。该网站通过 HTTP 接收登录信息；平台加密保存凭据。
            </label>
          </>
        )}
        {view?.status === 'running' && (
          <p>
            <Spinner /> 正在自动登录或安全保存，请稍候…
          </p>
        )}
        {view?.status === 'manual_required' && (
          <>
            <p>
              {view.automaticSubmissions > 0
                ? '自动识别多次未通过，请输入这一次验证码。'
                : '请输入下方图形验证码完成登录。'}
            </p>
            {image && run.current.epoch === epoch && (
              <img
                src={image}
                alt="网站登录验证码"
                width={188}
                height={80}
                className="h-20 w-[188px] rounded border border-border-control bg-surface object-contain"
              />
            )}
            <label htmlFor="literature-setup-captcha" className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              验证码
              <Input
                id="literature-setup-captcha"
                aria-label="验证码"
                placeholder="请输入上方验证码"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                enterKeyHint="done"
                maxLength={8}
                value={answer}
                disabled={answered}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !answered && image && answer) {
                    e.preventDefault()
                    void submitAnswer()
                  }
                }}
              />
            </label>
            <Button
              size="sm"
              loading={busy}
              disabled={answered || !image || !answer}
              onClick={() => void submitAnswer()}
            >
              提交验证码
            </Button>
          </>
        )}
        {view?.status === 'authenticated' && (
          <Alert tone="success">
            {view.agentReady ? '登录已保存，可以检索文献。' : '登录信息已加密保存，检索尚未启用。'}
          </Alert>
        )}
        {view && ['failed', 'expired', 'cancelled'].includes(view.status) && (
          <Alert tone="warning">
            {messages[view.errorCode ?? ''] ?? '本次登录已结束。请关闭后重新发起。'}
          </Alert>
        )}
      </div>
    </Modal>
  )
}
