/**
 * useProgressiveImage —— 图片分级加载 + 百分比进度 + 字节复用的**单一 hook 收口**。
 *
 * boss 反馈:图片渲染太慢、看不到进度;「为什么不能复用已渲染出来的图片?」。本 hook:
 *   1. 签名 URL 走 **fetch 流式**(fetchProgressiveBlob):reader 累计 bytes / Content-Length →
 *      `percent`(无 Content-Length 退化为已载字节)。完成 blob → objectURL 交给 <img>(自动 revoke)。
 *   2. **字节复用**:共享 LRU(imageByteCache)命中即零网络(查看器点开复用气泡已载字节、
 *      编辑器复用原图)。完成后写回缓存。**与 fetchImageBlobWithResign 同一缓存,不做第二套。**
 *   3. **localSrc / data:/blob:(本地字节在手)最高优先零网络** —— 直接透传,不 fetch。
 *   4. 失败沿用既有**重签(403/410)/ 重试(429/503 退避)** 链路(在 fetchProgressiveBlob 内)。
 *   5. **懒加载**:IntersectionObserver 门控(替代被移除的 `<img loading=lazy>`),避免长会话
 *      多图一次性并发拉爆 per-uid 6 并发闸;无 IO(SSR/jsdom)或 `lazy=false`(查看器)→ 立即拉。
 *
 * 返回 `blob` 供编辑器取原图上传字节(与 objectURL 同源,不二次 fetch)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { downloadPercent } from './download'
import { fetchProgressiveBlob } from './fetchImageProgressive'
import {
  THUMBNAIL_RENDER_WIDTHS,
  byteCacheKey,
  imageByteCache,
  isMediaSignedUrl,
  type ResolveSignedSrc,
} from './imageBytes'

export type ProgressiveStatus = 'idle' | 'loading' | 'loaded' | 'error'

export interface UseProgressiveImageResult {
  /** 挂到容器节点驱动 IntersectionObserver 懒加载(lazy=false 时可忽略)。 */
  containerRef: (node: Element | null) => void
  /** 可直接用于 <img src> 的 URL(blob objectURL,或本地/直链原样)。未就绪 → null。 */
  objectUrl: string | null
  /** 已下载完成的 Blob(编辑器取原图字节用;透传/未完成 → null)。 */
  blob: Blob | null
  percent: number | null
  loadedBytes: number
  status: ProgressiveStatus
  /** 手动重试(失败态用)。 */
  reload: () => void
}

export function useProgressiveImage(params: {
  /** 基础 URL:签名 URL(需 fetch 流式)/ 直链 / 本地 blob;null → idle。 */
  src: string | null | undefined
  /** 缩略宽度(640/1280);null = 原图(查看器/编辑器)。仅对签名 URL 生效。 */
  width?: number | null
  /** 字节缓存身份(signPath / `/api/media/<digest>`)。缺省 → 不缓存复用。 */
  cacheIdentity?: string | null
  /** 403/410 强制重签(来自 useFreshSignedUrl 的 get)。 */
  resolveSrc?: ResolveSignedSrc
  /** 懒加载门控;默认 true。查看器/编辑器传 false 立即拉。 */
  lazy?: boolean
}): UseProgressiveImageResult {
  const { src, width = null, cacheIdentity = null, resolveSrc, lazy = true } = params

  const hasIO = typeof IntersectionObserver !== 'undefined'
  // 立即拉:非懒 or 无 IO(SSR/jsdom)。懒加载首帧未进视口 → active=false 等 IO。
  const [active, setActive] = useState<boolean>(!lazy || !hasIO)
  const [status, setStatus] = useState<ProgressiveStatus>('idle')
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [loadedBytes, setLoadedBytes] = useState(0)
  const [attempt, setAttempt] = useState(0)

  // 我们自建的 objectURL(需 revoke);透传的 src 不 revoke。
  const ownedUrlRef = useRef<string | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  const containerRef = useCallback(
    (node: Element | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }
      if (!node || !lazy || !hasIO) return
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setActive(true)
            io.disconnect()
            observerRef.current = null
          }
        },
        // 提前 300px 起拉,进视口时通常已就绪(观感无延迟)。
        { rootMargin: '300px' },
      )
      io.observe(node)
      observerRef.current = io
    },
    [lazy, hasIO],
  )

  useEffect(() => {
    return () => observerRef.current?.disconnect()
  }, [])

  useEffect(() => {
    const revokePrev = () => {
      if (ownedUrlRef.current) {
        URL.revokeObjectURL(ownedUrlRef.current)
        ownedUrlRef.current = null
      }
    }
    const adoptBlob = (b: Blob) => {
      revokePrev()
      const objUrl = URL.createObjectURL(b)
      ownedUrlRef.current = objUrl
      setObjectUrl(objUrl)
      setBlob(b)
      setStatus('loaded')
      setPercent(100)
      setLoadedBytes(b.size)
    }

    if (!src) {
      revokePrev()
      setObjectUrl(null)
      setBlob(null)
      setStatus('idle')
      setPercent(null)
      setLoadedBytes(0)
      return
    }

    // 本地字节 / 直链(data:/blob:/http)在手 → 零网络透传(localSrc 最高优先)。
    if (!isMediaSignedUrl(src)) {
      revokePrev()
      setObjectUrl(src)
      setBlob(null)
      setStatus('loaded')
      setPercent(100)
      setLoadedBytes(0)
      return
    }

    // 懒加载未进视口 → 保持 idle(骨架),等 active。
    if (!active) {
      setStatus('idle')
      return
    }

    // 字节缓存**同步**命中 → 零请求、零 loading 闪:直接采用(查看器复用气泡、编辑器复用原图)。
    const key = byteCacheKey(cacheIdentity, width)
    const cached = imageByteCache.get(key)
    if (cached) {
      adoptBlob(cached)
      return
    }

    const controller = new AbortController()
    let alive = true
    setStatus('loading')
    setPercent(null)
    setLoadedBytes(0)

    // 原图(width=null)miss 时:若已有缩略缓存(气泡已载 w1280/w640),先把缩略 objectURL
    // 铺上做**即时预览**(查看器点开复用气泡字节、零请求先出图,禁灰屏),后台拉原图无缝换。
    // 不设 blob —— blob 必须是原图(编辑器上传/合成按原图自然尺寸,缩略不可用)。
    if (width == null && cacheIdentity) {
      let preview: Blob | null = null
      for (let i = THUMBNAIL_RENDER_WIDTHS.length - 1; i >= 0 && !preview; i--) {
        preview = imageByteCache.get(byteCacheKey(cacheIdentity, THUMBNAIL_RENDER_WIDTHS[i]))
      }
      if (preview) {
        revokePrev()
        const purl = URL.createObjectURL(preview)
        ownedUrlRef.current = purl
        setObjectUrl(purl)
      }
    }
    void fetchProgressiveBlob({
      url: src,
      width,
      cacheIdentity,
      resolveSrc,
      signal: controller.signal,
      onProgress: (loaded, total) => {
        if (!alive) return
        setLoadedBytes(loaded)
        setPercent(downloadPercent(loaded, total))
      },
    })
      .then((got) => {
        if (!alive) return
        adoptBlob(got)
      })
      .catch((err) => {
        if (!alive || controller.signal.aborted || (err as Error)?.name === 'AbortError') return
        setStatus('error')
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [src, width, cacheIdentity, resolveSrc, active, attempt])

  // 卸载时 revoke 最后一个自建 URL。
  useEffect(() => {
    return () => {
      if (ownedUrlRef.current) {
        URL.revokeObjectURL(ownedUrlRef.current)
        ownedUrlRef.current = null
      }
    }
  }, [])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  return { containerRef, objectUrl, blob, percent, loadedBytes, status, reload }
}
