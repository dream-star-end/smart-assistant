// OCV5-593 FE-2b: evenly spaced still frames of a video for the review filmstrip. One hidden video
// element seeks through the clip and draws each frame onto a small canvas. Falls back to null when
// the browser cannot decode or the canvas is tainted.

import { useEffect, useState } from 'react'

const FRAME_W = 160

export function useVideoFrames(
  url: string | null,
  count: number,
): { frames: string[] | null; duration: number } {
  const [state, setState] = useState<{ frames: string[] | null; duration: number }>({
    frames: null,
    duration: 0,
  })
  useEffect(() => {
    setState({ frames: null, duration: 0 })
    if (!url || count <= 0) return
    let live = true
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.playsInline = true
    video.src = url
    const seek = (t: number) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          video.removeEventListener('seeked', done)
          video.removeEventListener('error', fail)
          resolve()
        }
        const fail = () => {
          video.removeEventListener('seeked', done)
          video.removeEventListener('error', fail)
          reject(new Error('seek failed'))
        }
        video.addEventListener('seeked', done)
        video.addEventListener('error', fail)
        video.currentTime = t
      })
    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error('load failed')), { once: true })
      })
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('no duration')
      if (live) setState({ frames: null, duration })
      const canvas = document.createElement('canvas')
      canvas.width = FRAME_W
      canvas.height = Math.round((FRAME_W * (video.videoHeight || 9)) / (video.videoWidth || 16))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas')
      const out: string[] = []
      for (let i = 0; i < count && live; i++) {
        await seek(((i + 0.5) / count) * duration)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        out.push(canvas.toDataURL('image/jpeg', 0.7))
      }
      if (live) setState({ frames: out, duration })
    }
    run().catch(() => {
      if (live) setState((s) => ({ frames: null, duration: s.duration }))
    })
    return () => {
      live = false
      video.removeAttribute('src')
      video.load()
    }
  }, [url, count])
  return state
}
