// OCV5-593 FE-5 授权卡 (d10 / d11): what the track is licensed under, the exact attribution text,
// where it came from and when it was verified. CC BY music must keep its attribution in the cut.

import { ExternalLink } from 'lucide-react'

import { type MusicTakeInfo, type MusicTrack, licenseLabel } from '../../../lib/studio/music'
import { LicenseBadge, originLabel } from './TrackRow'

export function LicenseCard(props: {
  title?: string
  track?: MusicTrack | null
  license?: MusicTakeInfo['license']
}) {
  const t = props.track
  const l = props.license
  const license = l?.license ?? t?.license
  const name = l?.title ?? t?.title
  const artist = l?.artist ?? t?.artist
  const attribution = l?.attributionText ?? t?.attributionText ?? ''
  const required = l?.attributionRequired ?? t?.attributionRequired ?? false
  const landing = l?.landingUrl ?? t?.landingUrl ?? null
  const userUpload = license === 'USER-STATEMENT' || l?.source === 'user-upload'
  if (!license && !userUpload) return null
  const rows: Array<[string, string]> = [
    ['曲目', [name, artist].filter(Boolean).join(' · ') || '—'],
    ['协议', userUpload ? '自有或已获授权（上传时声明）' : licenseLabel(license)],
    ['署名', required ? '必须保留' : '不要求（我们仍会在片尾列出）'],
  ]
  if (t?.origin && !userUpload) rows.push(['来源', `精选曲库 · ${originLabel(t.origin)}`])
  if (l?.verifiedAt) rows.push(['核验', l.verifiedAt.slice(0, 10)])
  if (l?.rightsStatement?.note) rows.push(['授权说明', l.rightsStatement.note])
  return (
    <section className="st-card st-license" aria-label="授权">
      <div className="st-row" style={{ gap: 8 }}>
        <span className="st-label">{props.title ?? '授权'}</span>
        <span style={{ flex: 1 }} />
        {userUpload ? (
          <LicenseBadge license="USER-STATEMENT" />
        ) : (
          <LicenseBadge license={license} />
        )}
      </div>
      <dl className="st-license-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {attribution ? <pre className="st-license-attr">{attribution}</pre> : null}
      {landing ? (
        <a className="st-btn st-btn-sm" href={landing} target="_blank" rel="noreferrer noopener">
          <ExternalLink />
          来源页
        </a>
      ) : null}
    </section>
  )
}
