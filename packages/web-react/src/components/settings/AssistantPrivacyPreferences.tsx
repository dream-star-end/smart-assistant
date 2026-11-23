import { DEFAULT_PROMPT_PRIVACY_SUPPORT, type PromptPrivacySupport, hasPromptPrivacyControlCharacters } from '@openclaude/protocol/browser'
import { Shield } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { AuthSession } from '../../lib/types'
import type { PrefsView } from '../../lib/modelPreferences'
import { apiErrorMessage } from '../../lib/api'
import { Alert, Button, Input, Modal, Switch } from '../ui'

type Profile = NonNullable<PrefsView['system_assistant_profile']>
export function AssistantPrivacyPreferences({ auth, sessionId, profile, onPatch, privacySupport = { ...DEFAULT_PROMPT_PRIVACY_SUPPORT } }: {
  privacySupport?: PromptPrivacySupport;
  auth: AuthSession; sessionId?: string; profile?: Profile; onPatch: (patch: Record<string, unknown>) => Promise<void>
}) {
  const nicknameInputId = useId()
  const nicknameInputRef = useRef<HTMLInputElement>(null)
  const ready = privacySupport.state === 'ready'
  const enabled = Boolean(sessionId && profile?.enabled && profile.sessionId === sessionId)
  const currentNickname = enabled ? profile?.nickname ?? '' : ''
  const [nickname, setNickname] = useState(currentNickname)
  const [pending, setPending] = useState<{ value: Profile | null; scope: string | undefined; epoch: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [validationError, setValidationError] = useState('')
  const scope = useRef(sessionId); scope.current = sessionId
  useEffect(() => { setNickname(currentNickname); setValidationError('') }, [currentNickname])
  const trimmed = nickname.trim()
  const hasControlChars = hasPromptPrivacyControlCharacters(nickname)
  const valid = trimmed.length > 0 && trimmed.length <= 80 && !hasControlChars
  function nicknameIssue(raw: string): string {
    if (hasPromptPrivacyControlCharacters(raw)) return '称呼不能包含不可见的控制字符。'
    if (raw.trim().length === 0) return '请先填写你希望助手在本会话使用的称呼。'
    if (raw.trim().length > 80) return '称呼最多 80 个字符。'
    return ''
  }
  function request(value: Profile | null) { if (value && !ready) return; setError(''); setValidationError(''); setPending({ value, scope: sessionId, epoch: auth.snapshot().epoch }) }
  function handleSwitchChange(checked: boolean) {
    if (!checked) { request(null); return }
    if (!ready) return
    if (!sessionId) { setValidationError('请先打开一个会话后再开启称呼设置。'); return }
    const issue = nicknameIssue(nickname)
    if (issue) {
      setValidationError(issue)
      nicknameInputRef.current?.focus()
      return
    }
    request({ enabled: true, nickname: nickname.trim(), sessionId })
  }
  async function save() {
    const proposal = pending
    if (proposal?.value && !ready) { setPending(null); setError('运行环境状态已变化，请更新后重新授权。'); return }
    if (!proposal || busy || proposal.scope !== scope.current || proposal.epoch !== auth.snapshot().epoch) return
    setBusy(true); setError('')
    try {
      await onPatch({ system_assistant_profile: proposal.value })
      if (scope.current === proposal.scope && proposal.epoch === auth.snapshot().epoch) setPending(null)
    } catch (e) { if (scope.current === proposal.scope && proposal.epoch === auth.snapshot().epoch) setError(apiErrorMessage(e, '保存失败，请重试')) }
    finally { if (scope.current === proposal.scope && proposal.epoch === auth.snapshot().epoch) setBusy(false) }
  }
  const next = sessionId && valid ? { enabled: true, nickname: trimmed, sessionId } : null
  return <div className="px-5 py-2">
    <section className="oc-surface-card rounded-2xl p-4">
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="oc-icon-badge oc-icon-badge-accent h-7 w-7 rounded-sm" aria-hidden>
          <Shield size={14} strokeWidth={1.75} />
        </span>
        <h3 className="text-section font-semibold text-fg">隐私与助手</h3>
      </div>
      <p className="mb-3.5 text-meta leading-relaxed text-muted">让助手在本会话按你的习惯称呼你，仅对当前对话生效。个人画像仍保留供按需查阅，此设置不影响外接客户端和独立记忆设置。</p>
      {!ready && <output className="oc-callout oc-callout-warning mb-3.5 block rounded-lg px-3 py-2.5 text-meta leading-relaxed text-muted">{privacySupport.state === 'upgrade_required' ? '当前服务版本过旧，更新后即可开启称呼设置。' : '暂未确认当前环境是否支持此设置，暂不可新增称呼授权。'}旧版仍可能自动加载已有画像，已保存的称呼授权仍可撤回。</output>}
      <div className="flex items-start justify-between gap-4 py-1.5">
        <div className="min-w-0"><div className="text-section font-medium text-fg">本会话使用称呼</div>
          <p className="mt-0.5 text-meta text-muted">默认关闭。开启后，助手会在当前对话中使用下方称呼，不从邮箱或画像自动推断。</p>
        </div>
        <Switch aria-label="本会话使用称呼" checked={enabled} disabled={busy || (!enabled && (!ready || !sessionId))} onCheckedChange={handleSwitchChange} />
      </div>
      <label htmlFor={nicknameInputId} className="mt-3 block text-meta font-medium text-muted">称呼
        <Input
          ref={nicknameInputRef}
          id={nicknameInputId}
          aria-label="助手称呼"
          aria-invalid={Boolean(validationError || hasControlChars)}
          className="mt-1.5"
          value={nickname}
          maxLength={80}
          disabled={busy || !ready}
          onChange={e => {
            const v = e.target.value
            setNickname(v)
            if (hasPromptPrivacyControlCharacters(v)) setValidationError('称呼不能包含不可见的控制字符。')
            else if (validationError && v.trim().length > 0 && v.trim().length <= 80) setValidationError('')
          }}
          placeholder="填写你希望助手如何称呼你"
        />
      </label>
      {(validationError || hasControlChars) && (
        <p role="alert" className="mt-1.5 text-caption text-danger">
          {validationError || '称呼不能包含不可见的控制字符。'}
        </p>
      )}
      {!sessionId && <p className="mt-2 text-caption text-muted">打开一个会话后，可单独为该会话设置称呼。</p>}
      {enabled && profile?.nickname !== trimmed && <Button className="mt-3" size="sm" disabled={!next || busy || !ready} onClick={() => request(next)}>保存新称呼</Button>}
      {profile?.enabled && !enabled && <div className="mt-3 flex flex-wrap items-center gap-3"><p className="text-meta text-muted">此前授权属于另一会话，当前会话未使用。</p><Button size="sm" disabled={busy} onClick={() => request(null)}>撤回此前授权</Button></div>}
      <div className="oc-surface-recessed mt-4 rounded-xl px-3.5 py-3 text-meta text-muted"><p className="font-medium text-fg">{ready ? '本会话生效内容' : '生效状态'}</p><p className="mt-1 break-words">{ready ? (enabled ? `称呼：${profile!.nickname}` : '未启用额外称呼') : '当前环境生效状态待确认，暂无法预览。'}</p></div>
      <p className="mt-3 text-caption leading-relaxed text-faint">关闭后将在下一轮对话生效，已发送的历史记录不会被修改。如切换环境后未能即时生效，请按提示重试。</p>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    </section>
    <Modal open={Boolean(pending)} onOpenChange={open => { if (!open && !busy) setPending(null) }} size="sm" mobile="sheet" title={pending?.value ? '授权本会话使用称呼？' : '停止使用额外称呼？'}
      description="核对后再保存，取消不会更改设置。"
      footer={<><Button disabled={busy} onClick={() => setPending(null)}>取消</Button><Button variant="accent" loading={busy} onClick={() => void save()}>确认保存</Button></>}>
      <div className="space-y-3 text-body"><p>{pending?.value ? `称呼：${pending.value.nickname}` : ready ? '后续新请求不再提供额外称呼。' : '撤回已保存的称呼授权；旧环境的画像加载仍需更新后才能停止。'}</p><p className="text-muted">{pending?.value ? '仅当前会话生效，替换此前的称呼授权。' : '适用于此前授权的会话。'}</p><p className="text-muted">原画像保留，旧历史无法撤回。不产生额外模型请求。</p></div>
    </Modal>
  </div>
}
