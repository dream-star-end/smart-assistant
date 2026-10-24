// OCV5-593 镜头卡 (d04 / m02): media first, status chip, version, title over the image.

import { Check, Clock, Film, Hand, Image as ImageIcon, ScanEye, X } from 'lucide-react'

import type { ShotCardModel } from '../../lib/studio/model'
import type { AuthSession } from '../../lib/types'
import { MediaThumb } from './MediaThumb'

const TONE_CHIP: Record<ShotCardModel['tone'], string> = {
  ok: 'st-chip-ok',
  needs: 'st-chip-warn',
  gen: 'st-chip-agent',
  queued: '',
  bad: 'st-chip-bad',
  planned: '',
}

function ChipIcon({ tone }: { tone: ShotCardModel['tone'] }) {
  if (tone === 'ok') return <Check />
  if (tone === 'needs') return <Hand />
  if (tone === 'bad') return <X />
  if (tone === 'queued' || tone === 'planned') return <Clock />
  return <span className="st-dot" />
}

export function ShotCard(props: { auth: AuthSession; model: ShotCardModel; onOpen: () => void }) {
  const m = props.model
  const title = `#${m.shot.ordinal + 1}${m.spec.title ? ` ${m.spec.title}` : ''}`
  const provider = m.shown?.provider ?? m.running?.provider
  return (
    <button
      type="button"
      className={`st-card hoverable st-shot-card${m.tone === 'needs' ? ' needs' : ''}`}
      onClick={props.onOpen}
      data-testid="studio-shot-card"
      aria-label={`${title}，${m.chip}`}
    >
      <MediaThumb
        auth={props.auth}
        take={m.shown}
        dim={m.tone === 'queued' || m.tone === 'planned'}
        style={{ aspectRatio: '16 / 9', borderRadius: 0 }}
      >
        <span
          className={`st-chip st-chip-dark ${TONE_CHIP[m.tone]}`}
          style={{ position: 'absolute', left: 10, top: 10 }}
        >
          <ChipIcon tone={m.tone} />
          {m.chip}
        </span>
        {m.versions > 0 ? (
          <span
            className="st-chip st-chip-dark"
            style={{ position: 'absolute', right: 10, top: 10 }}
          >
            v{m.versions}
          </span>
        ) : null}
        <span className="st-shot-title">{title}</span>
        <span
          className="st-chip st-chip-dark tnum"
          style={{ position: 'absolute', right: 10, bottom: 10 }}
        >
          {m.seconds}s
        </span>
        {m.tone === 'gen' ? (
          <>
            <div className="st-gen" />
            <div className="st-genbar">
              <i style={{ width: m.shot.status === 'qa' ? '90%' : '45%' }} />
            </div>
          </>
        ) : null}
      </MediaThumb>
      <div style={{ padding: '10px 12px 12px' }}>
        <div className="st-shot-desc">
          {[m.spec.framing, m.spec.action].filter(Boolean).join(' · ') || '等待 agent 写镜头描述'}
        </div>
        <div className="st-cap st-row" style={{ marginTop: 6, gap: 6 }}>
          {m.shown ? <Film size={12} /> : <ImageIcon size={12} />}
          <span>
            {provider
              ? `${provider}${m.costCredits ? ` · ${m.costCredits} 积分` : ''}`
              : (m.spec.source ?? '待生成')}
          </span>
          <span style={{ flex: 1 }} />
          {m.qaScore !== null ? (
            <span
              className="st-row"
              style={{ gap: 4, color: m.tone === 'needs' ? 'var(--warning)' : undefined }}
            >
              <ScanEye size={12} />
              QA {m.qaScore.toFixed(2)}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )
}
