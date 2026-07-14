/**
 * 图片字节的**单一 fetch 收口** —— 流式(进度)+ 签名重签(403/410)+ 退避重试(429/503)+
 * 共享 LRU 字节缓存复用。useProgressiveImage(渲染)与 fetchImageBlobWithResign(编辑器取字节)
 * 都经此,**不做第二套** fetch/缓存(boss 铁律「别做成第二套」)。
 */
import { downloadPercent } from './download'
import {
  appendThumbnailWidth,
  byteCacheKey,
  imageByteCache,
  type ResolveSignedSrc,
} from './imageBytes'

const MAX_RETRY = 3
const RETRY_BASE_MS = 400

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

export type ProgressFn = (loaded: number, total: number | null) => void

/**
 * 拉取签名图字节(流式 + 重签 + 退避重试),onProgress 汇报进度。返回 Blob。
 * 不查/不写缓存 —— 缓存由 fetchProgressiveBlob 收口(便于「同步命中」快路径)。
 *   - 403/410 → resolveSrc 强制重签一次(服务端裁决优先本地钟,对齐取媒体铁律)。
 *   - 429/503 → 退避重试(缩略 miss 时 master 缓冲+resize 需容器,可能拥塞/冷启)。
 */
export async function fetchImageProgressiveStream(opts: {
  url: string
  width?: number | null
  resolveSrc?: ResolveSignedSrc
  signal: AbortSignal
  onProgress?: ProgressFn
}): Promise<Blob> {
  const { width = null, resolveSrc, signal, onProgress } = opts
  let base = opts.url

  for (let attempt = 0; ; attempt++) {
    let target = appendThumbnailWidth(base, width)
    let res = await fetch(target, { signal, credentials: 'include' })
    if ((res.status === 403 || res.status === 410) && resolveSrc) {
      const resigned = await resolveSrc({ forceResign: true })
      if (resigned) {
        base = resigned
        target = appendThumbnailWidth(base, width)
        res = await fetch(target, { signal, credentials: 'include' })
      }
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRY) {
      await delay(RETRY_BASE_MS * 2 ** attempt, signal)
      continue
    }
    if (!res.ok) throw new Error(`读取图片失败 (${res.status})`)

    const total = Number(res.headers.get('content-length')) || null
    if (!res.body || typeof res.body.getReader !== 'function') {
      const blob = await res.blob()
      onProgress?.(blob.size, total ?? blob.size)
      return blob
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    onProgress?.(0, total)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        loaded += value.length
        onProgress?.(loaded, total)
      }
    }
    const type = res.headers.get('content-type') || 'application/octet-stream'
    return new Blob(chunks as BlobPart[], { type })
  }
}

/**
 * 缓存感知的字节获取 —— **单一 fetch+缓存收口**。
 * 先查共享 LRU(命中零请求复用);miss 走 fetchImageProgressiveStream 后写回缓存。
 * cacheIdentity 缺省 → 不缓存(纯本地/一次性)。
 */
export async function fetchProgressiveBlob(opts: {
  url: string
  width?: number | null
  cacheIdentity?: string | null
  resolveSrc?: ResolveSignedSrc
  signal?: AbortSignal
  onProgress?: ProgressFn
}): Promise<Blob> {
  // 与缓存 miss 同时捕获代次；鉴权身份切换会 clear+推进 epoch，旧请求迟到不得回填。
  const cacheEpoch = imageByteCache.captureEpoch()
  const key = byteCacheKey(opts.cacheIdentity ?? null, opts.width ?? null)
  const cached = imageByteCache.get(key)
  if (cached) {
    opts.onProgress?.(cached.size, cached.size)
    return cached
  }
  const signal = opts.signal ?? new AbortController().signal
  const blob = await fetchImageProgressiveStream({
    url: opts.url,
    width: opts.width ?? null,
    resolveSrc: opts.resolveSrc,
    signal,
    onProgress: opts.onProgress,
  })
  imageByteCache.setIfCurrentEpoch(key, blob, cacheEpoch)
  return blob
}

export { downloadPercent }
