// OCV5-593: the real waveform of an audio blob (decoded once with WebAudio, peaks cached per sha).
// While decoding, or when the browser cannot decode, it shows a quiet placeholder bar row instead.

import { useEffect, useState } from 'react'

const peaksCache = new Map<string, Promise<number[]>>()

async function computePeaks(url: string, bars: number): Promise<number[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.arrayBuffer()
  const Ctx =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext
  if (!Ctx) throw new Error('no audio context')
  const ctx = new Ctx(1, 1, 44_100)
  const audio = await ctx.decodeAudioData(data)
  const ch = audio.getChannelData(0)
  const step = Math.max(1, Math.floor(ch.length / bars))
  const out: number[] = []
  let max = 0
  for (let i = 0; i < bars; i++) {
    let peak = 0
    for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j++) {
      const v = Math.abs(ch[j]!)
      if (v > peak) peak = v
    }
    out.push(peak)
    if (peak > max) max = peak
  }
  return max > 0 ? out.map((v) => v / max) : out
}

export function audioPeaks(sha: string, url: string, bars: number): Promise<number[]> {
  const k = `${sha}:${bars}`
  let hit = peaksCache.get(k)
  if (!hit) {
    hit = computePeaks(url, bars).catch((err) => {
      peaksCache.delete(k)
      throw err
    })
    peaksCache.set(k, hit)
  }
  return hit
}

export function Waveform(props: {
  sha: string | null
  url: string | null
  bars?: number
  height?: number
  className?: string
  label?: string
}) {
  const bars = props.bars ?? 48
  const height = props.height ?? 22
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    setPeaks(null)
    if (!props.sha || !props.url) return
    let live = true
    audioPeaks(props.sha, props.url, bars)
      .then((p) => live && setPeaks(p))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [props.sha, props.url, bars])
  const w = bars * 3
  return (
    <svg
      className={props.className}
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label ?? '音频波形'}
      style={{ width: '100%', height }}
    >
      {Array.from({ length: bars }, (_, i) => {
        const v = peaks ? Math.max(0.08, peaks[i] ?? 0) : 0.18
        const h = v * height
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: bar i is a fixed slot of the waveform
            key={i}
            x={i * 3}
            y={(height - h) / 2}
            width={1.8}
            height={h}
            rx={0.9}
            fill="currentColor"
            opacity={peaks ? 0.9 : 0.35}
          />
        )
      })}
    </svg>
  )
}
