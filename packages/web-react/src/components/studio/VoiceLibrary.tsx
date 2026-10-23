// OCV5-593 FE-4 音色库: the project's voices with their state (designing / cloning, failed with the
// reason, ready with a preview), "设为旁白", and the MiniMax voice design / clone dialogs (user
// decision 2026-10-23 13:03: real calls allowed). Each new voice is 990 credits plus its preview.

import { Lock, Mic, Upload, Wand2, X } from 'lucide-react'
import { useState } from 'react'

import { useBlobUrl } from '../../hooks/useBlobUrl'
import {
  UPLOAD_AUDIO_TYPES,
  studioApi,
  studioErrorText,
  voiceFailureText,
} from '../../lib/studio/api'
import type { StudioAsset, StudioProjectView, StudioTake } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'
import { useToast } from '../ui'
import { Waveform } from './Waveform'

export const VOICE_PRICE_CREDITS = 990

/** "设计音色 · <description>", without repeating a label the description already starts with. */
export function voiceSubtitle(mode: string | undefined, descriptor: string | null): string {
  const label = mode === 'design' ? '设计音色' : mode === 'clone' ? '快速复刻' : '系统音色'
  if (!descriptor) return label
  return descriptor.startsWith(label) ? descriptor : `${label} · ${descriptor}`
}

export function voiceState(
  view: StudioProjectView,
  asset: StudioAsset,
): {
  state: 'ready' | 'working' | 'failed' | 'system'
  take: StudioTake | null
} {
  const takes = view.takes
    .filter((t) => t.ownerKind === 'bible' && t.ownerId === asset.id)
    .sort((a, b) => b.version - a.version)
  const latest = takes[0] ?? null
  if (asset.voiceId) return { state: 'ready', take: latest }
  if (!latest) return { state: 'system', take: null }
  if (latest.status === 'queued' || latest.status === 'running')
    return { state: 'working', take: latest }
  return { state: 'failed', take: latest }
}

function VoiceCard(props: {
  auth: AuthSession
  view: StudioProjectView
  asset: StudioAsset
  narrator: boolean
  onUse: () => void
}) {
  const { asset } = props
  const url = useBlobUrl(props.auth, asset.blobSha)
  const st = voiceState(props.view, asset)
  const mode = (asset.meta as { mode?: string }).mode
  return (
    <div
      className={`${props.narrator ? 'st-stage st-voice-card' : 'st-card st-voice-alt'}`}
      data-testid="voice-card"
    >
      <div className="st-row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className="st-voice-ic" aria-hidden="true">
          <Mic size={18} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 650, color: props.narrator ? '#f5f4ed' : undefined }}>
            {asset.name}
          </div>
          <div
            className="st-cap"
            style={props.narrator ? { color: 'var(--st-stage-muted)' } : undefined}
          >
            {voiceSubtitle(mode, asset.descriptor)}
          </div>
        </div>
      </div>
      {url ? (
        <div style={{ color: 'var(--st-trk-voice)', marginTop: 10 }}>
          <Waveform
            sha={asset.blobSha}
            url={url}
            bars={48}
            height={24}
            label={`${asset.name} 试听`}
          />
          {/* biome-ignore lint/a11y/useMediaCaption: a voice preview of a line shown in the card */}
          <audio className="st-voice-preview" src={url} controls preload="none" />
        </div>
      ) : null}
      <div className="st-row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
        {st.state === 'working' ? (
          <span className="st-chip st-chip-agent">
            <span className="st-dot" />
            {mode === 'clone' ? '复刻中…' : '设计中…'}
          </span>
        ) : st.state === 'failed' ? (
          <output className="st-chip st-chip-bad">
            {voiceFailureText(st.take?.errorCode ?? null)}
          </output>
        ) : props.narrator && asset.locked ? (
          <span className={`st-chip ${props.narrator ? 'st-chip-dark' : ''} st-chip-ok`}>
            <Lock />
            旁白在用
          </span>
        ) : st.state === 'ready' ? (
          <button type="button" className="st-btn st-btn-sm" onClick={props.onUse}>
            设为旁白
          </button>
        ) : null}
      </div>
    </div>
  )
}

function DesignDialog(props: {
  auth: AuthSession
  projectId: string
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = name.trim() && prompt.trim() && preview.trim()
  return (
    <dialog open className="st-voice-dialog" aria-label="一句话设计音色">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ok || busy) return
          setBusy(true)
          try {
            await studioApi.createVoice(props.auth, props.projectId, {
              mode: 'design',
              name: name.trim(),
              prompt: prompt.trim(),
              previewText: preview.trim(),
            })
            toast('开始设计音色，完成后会出现在音色列表里', 'success')
            props.onDone()
          } catch (err) {
            toast(studioErrorText(err), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="st-row">
          <b className="st-h3">一句话设计音色</b>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-iconbtn" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <label className="st-field" htmlFor="st-vd-name">
          名称
          <input
            id="st-vd-name"
            className="st-input"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：纪录片旁白"
          />
        </label>
        <label className="st-field" htmlFor="st-vd-prompt">
          声音描述
          <textarea
            id="st-vd-prompt"
            className="st-input st-input-area"
            maxLength={600}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如：沉稳温暖的中年男声，语速偏慢，适合自然纪录片旁白"
          />
        </label>
        <label className="st-field" htmlFor="st-vd-preview">
          试听句子
          <input
            id="st-vd-preview"
            className="st-input"
            maxLength={200}
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
            placeholder="例如：清晨，北方的雪松林慢慢醒来。"
          />
        </label>
        <div className="st-cap">
          由 MiniMax 生成。每个新音色 {VOICE_PRICE_CREDITS}{' '}
          积分，加上试听句子按字计费；从项目预算里扣。
        </div>
        <button type="submit" className="st-btn st-btn-primary" disabled={!ok || busy}>
          <Wand2 />
          {busy ? '提交中…' : `设计音色 · ${VOICE_PRICE_CREDITS} 积分起`}
        </button>
      </form>
    </dialog>
  )
}

function CloneDialog(props: {
  auth: AuthSession
  projectId: string
  onClose: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const ok = name.trim() && file && consent
  return (
    <dialog open className="st-voice-dialog" aria-label="上传声音样本复刻音色">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ok || busy || !file) return
          setBusy(true)
          try {
            const sample = await studioApi.uploadAsset(
              props.auth,
              props.projectId,
              file,
              UPLOAD_AUDIO_TYPES,
            )
            await studioApi.createVoice(props.auth, props.projectId, {
              mode: 'clone',
              name: name.trim(),
              sampleAssetId: sample.id,
              consent: true,
              ...(preview.trim() ? { previewText: preview.trim() } : {}),
            })
            toast('开始复刻音色，完成后会出现在音色列表里', 'success')
            props.onDone()
          } catch (err) {
            toast(studioErrorText(err), 'error')
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="st-row">
          <b className="st-h3">上传声音样本，复刻音色</b>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-iconbtn" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <label className="st-field" htmlFor="st-vc-name">
          名称
          <input
            id="st-vc-name"
            className="st-input"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的声音"
          />
        </label>
        <label className="st-field" htmlFor="st-vc-file">
          声音样本（MP3 / WAV，10 秒到 5 分钟，环境安静）
          <input
            id="st-vc-file"
            type="file"
            accept={UPLOAD_AUDIO_TYPES.join(',')}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="st-field" htmlFor="st-vc-preview">
          试听句子（可选）
          <input
            id="st-vc-preview"
            className="st-input"
            maxLength={200}
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
          />
        </label>
        <label className="st-consent" htmlFor="st-vc-consent">
          <input
            id="st-vc-consent"
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            这是我本人的声音，或我已获得声音主人的授权。复刻出的音色只在我自己的项目里使用。
          </span>
        </label>
        <div className="st-cap">
          由 MiniMax 快速复刻。每个新音色 {VOICE_PRICE_CREDITS}{' '}
          积分，加上试听句子按字计费；从项目预算里扣。
        </div>
        <button type="submit" className="st-btn st-btn-primary" disabled={!ok || busy}>
          <Upload />
          {busy ? '上传中…' : `复刻音色 · ${VOICE_PRICE_CREDITS} 积分起`}
        </button>
      </form>
    </dialog>
  )
}

export function VoiceLibrary(props: {
  auth: AuthSession
  view: StudioProjectView
  voiceReady: boolean
  onReload: () => Promise<void> | void
}) {
  const toast = useToast()
  const [dialog, setDialog] = useState<'design' | 'clone' | null>(null)
  const voices = props.view.assets.filter((a) => a.kind === 'voice')
  const narrator = voices.find((a) => a.locked) ?? null
  const ordered = narrator ? [narrator, ...voices.filter((v) => v.id !== narrator.id)] : voices
  const done = async () => {
    setDialog(null)
    await props.onReload()
  }
  return (
    <>
      <div className="st-label">音色 · 设为旁白后，还没配的台词都用它</div>
      {ordered.length === 0 ? (
        <div className="st-card st-image-empty">
          <div className="st-h3" style={{ fontSize: 13.5 }}>
            还没有音色
          </div>
          <div className="st-cap">
            开拍后导演 agent 会从系统音色里挑一个；也可以自己设计或复刻一个。
          </div>
        </div>
      ) : (
        ordered.map((v) => (
          <VoiceCard
            key={v.id}
            auth={props.auth}
            view={props.view}
            asset={v}
            narrator={v.id === narrator?.id}
            onUse={async () => {
              try {
                await studioApi.useVoiceForNarration(props.auth, v.id)
                toast(`旁白改用「${v.name}」`, 'success')
                await props.onReload()
              } catch (err) {
                toast(studioErrorText(err), 'error')
              }
            }}
          />
        ))
      )}
      <div className="st-row" style={{ gap: 8 }}>
        <button
          type="button"
          className="st-btn st-btn-sm"
          style={{ flex: 1 }}
          disabled={!props.voiceReady}
          onClick={() => setDialog('design')}
        >
          <Wand2 />
          一句话设计
        </button>
        <button
          type="button"
          className="st-btn st-btn-sm"
          style={{ flex: 1 }}
          disabled={!props.voiceReady}
          onClick={() => setDialog('clone')}
        >
          <Upload />
          上传克隆
        </button>
      </div>
      <div className="st-cap">
        每个新音色 {VOICE_PRICE_CREDITS}{' '}
        积分起。克隆需要确认“本人声音或已获授权”，复刻的音色只在你自己的项目里可用。
      </div>
      {dialog === 'design' ? (
        <DesignDialog
          auth={props.auth}
          projectId={props.view.project.id}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      ) : null}
      {dialog === 'clone' ? (
        <CloneDialog
          auth={props.auth}
          projectId={props.view.project.id}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      ) : null}
    </>
  )
}
