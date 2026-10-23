import { DEFAULT_PROMPT_PRIVACY_SUPPORT, type PromptPrivacySupport, hasPromptPrivacyControlCharacters } from '@openclaude/protocol/browser'
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
  const ready = privacySupport.state === 'ready'
  const enabled = Boolean(sessionId && profile?.enabled && profile.sessionId === sessionId)
  const currentNickname = enabled ? profile?.nickname ?? '' : ''
  const [nickname, setNickname] = useState(currentNickname)
  const [pending, setPending] = useState<{ value: Profile | null; scope: string | undefined; epoch: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scope = useRef(sessionId); scope.current = sessionId
  useEffect(() => { setNickname(currentNickname) }, [currentNickname])
  const valid = nickname.trim().length > 0 && nickname.trim().length <= 80 && !hasPromptPrivacyControlCharacters(nickname)
  function request(value: Profile | null) { if (value && !ready) return; setError(''); setPending({ value, scope: sessionId, epoch: auth.snapshot().epoch }) }
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
  const next = sessionId && valid ? { enabled: true, nickname: nickname.trim(), sessionId } : null
  return <div className="border-t border-border px-5 py-4">
    <h3 className="pb-2 text-caption font-medium uppercase tracking-wide text-faint">隐私与助手</h3>
    <p className="mb-4 text-meta leading-relaxed text-muted">支持此设置的运行环境只提供必要环境信息，画像保留供按需查阅。此处仅覆盖个人版对话；外接客户端使用独立设置，记忆仍由其自身设置控制。</p>
    {!ready && <output className="mb-4 block text-meta leading-relaxed text-muted">{privacySupport.state === 'upgrade_required' ? '当前运行环境尚未通过此版本的支持核验，更新后可启用。' : '尚未确认运行环境支持此设置，暂不新增称呼授权。'}旧版仍可能自动加载已标记的画像。已保存的称呼授权仍可撤回。</output>}
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0"><div className="text-section text-fg">本会话使用称呼</div>
        <p className="mt-1 text-meta text-muted">默认关闭，由你填写，不从邮箱或画像推断。</p>
      </div>
      <Switch aria-label="本会话使用称呼" checked={enabled} disabled={busy || (!enabled && (!next || !ready))} onCheckedChange={checked => request(checked ? next : null)} />
    </div>
    <label htmlFor={nicknameInputId} className="mt-3 block text-meta text-muted">称呼<Input id={nicknameInputId} aria-label="助手称呼" className="mt-1" value={nickname} maxLength={80} disabled={busy || !ready} onChange={e => setNickname(e.target.value)} placeholder="填写你希望的称呼" /></label>
    {!sessionId && <p className="mt-2 text-meta text-muted">打开一个会话后，可单独授权该会话。</p>}
    {enabled && profile?.nickname !== nickname.trim() && <Button className="mt-3" size="sm" disabled={!next || busy || !ready} onClick={() => request(next)}>查看称呼更改</Button>}
    {profile?.enabled && !enabled && <div className="mt-3 flex flex-wrap items-center gap-3"><p className="text-meta text-muted">此前授权属于另一会话，当前会话未使用。</p><Button size="sm" disabled={busy} onClick={() => request(null)}>撤回此前授权</Button></div>}
    <div className="mt-4 rounded-lg bg-surface px-3 py-3 text-meta text-muted"><p className="font-medium text-fg">{ready ? '本会话将提供的信息' : '生效状态'}</p><p className="mt-1 break-words">{ready ? (enabled ? `称呼：${profile!.nickname}` : '没有额外称呼或画像正文') : '当前注入情况待核验，暂无法提供预览。'}</p></div>
    <p className="mt-3 text-meta leading-relaxed text-muted">在支持此设置的环境中，关闭后下一轮停止新增。旧历史无法撤回；新建会话也不会更新旧运行环境。旧进程无法安全刷新时，本轮会停止并提示重试。</p>
    {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    <Modal open={Boolean(pending)} onOpenChange={open => { if (!open && !busy) setPending(null) }} size="sm" mobile="sheet" title={pending?.value ? '授权本会话使用称呼？' : '停止使用额外称呼？'}
      description="核对后再保存，取消不会更改设置。"
      footer={<><Button disabled={busy} onClick={() => setPending(null)}>取消</Button><Button variant="accent" loading={busy} onClick={() => void save()}>确认保存</Button></>}>
      <div className="space-y-3 text-body"><p>{pending?.value ? `称呼：${pending.value.nickname}` : ready ? '后续新请求不再提供额外称呼。' : '撤回已保存的称呼授权；旧环境的画像加载仍需更新后才能停止。'}</p><p className="text-muted">{pending?.value ? '仅当前会话生效，替换此前的称呼授权。' : '适用于此前授权的会话。'}</p><p className="text-muted">原画像保留，旧历史无法撤回。不产生额外模型请求。</p></div>
    </Modal>
  </div>
}
