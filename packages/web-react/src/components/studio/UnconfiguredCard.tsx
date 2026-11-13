// OCV5-593: a media kind with no usable provider (user decision 2026-10-23: a missing key shows
// "not configured", never an error). Renders no generate action at all.

import { Music, PlugZap } from 'lucide-react'

import type { MediaKind } from '../../lib/studio/types'

const NAMES: Record<MediaKind, string> = {
  image: '图片生成',
  video: '视频生成',
  voice: '配音',
  music: '音乐生成',
}

export function UnconfiguredCard({
  kind,
  offline = false,
}: { kind: MediaKind; offline?: boolean }) {
  const name = NAMES[kind]
  return (
    <div
      className="st-card"
      data-testid={`unconfigured-${kind}`}
      style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'flex-start', boxShadow: 'none' }}
    >
      <span
        className="st-iconbtn"
        aria-hidden="true"
        style={{ background: 'var(--hover)', flex: 'none' }}
      >
        {kind === 'music' ? <Music size={16} /> : <PlugZap size={16} />}
      </span>
      <div>
        <div className="st-h3" style={{ fontSize: 14 }}>
          {offline ? `${name}暂时不可用` : `${name}未配置`}
        </div>
        <div className="st-cap" style={{ marginTop: 4 }}>
          {offline
            ? '服务恢复后会自动继续，排队中的任务不会丢。'
            : '管理员配置好供应商后，这里会自动开放，无需刷新设置。'}
        </div>
      </div>
    </div>
  )
}
