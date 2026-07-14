/**
 * 图片字节的**单一收口**:分级宽度选择 + 签名 URL 追加 `w` + 规范化键 + 进程内 LRU 字节缓存。
 *
 * 背景(boss 反馈):
 *   - 气泡渲染全尺寸 PNG(几 MB)+ 跨境带宽 → 长时间灰骨架;缩略图 `?w=640/1280` 治本。
 *   - 「为什么不能复用已渲染出来的图片?」—— 点开查看器/进编辑器**重新下载**。用 LRU 字节缓存
 *     把已下载的 blob 按规范化键存起来,查看器/编辑器取图前先查:命中即零请求复用。
 *
 * **单一收口**:useProgressiveImage(气泡缩略 + 查看器)、fetchImageBlobWithResign(编辑/评论/
 * 调整大小取字节)都经本模块存/取,**不做第二套缓存**。
 *
 * 键规范化:`identity ∥ variant`。identity = `authKey ∥ signPath`(或 `/api/media/<digest>`)——
 * 与渲染出的签名 URL(带随机 token/过期戳)无关,故同账号同一图的不同签名 URL 命中同一条目，
 * 但同一 SPA 换账号后即使容器路径相同也绝不命中旧账号字节。
 * variant 区分尺寸变体(`w640`/`w1280`)与原图(`orig`)—— 缩略与原图是不同字节,分开存。
 */

/** 点击时签名权威:交互那一刻解析/重签签名 URL(过期自动重签;forceResign 强制)。 */
export type ResolveSignedSrc = (opts?: { forceResign?: boolean }) => Promise<string | null>

/** 白名单渲染宽度(与 master mediaThumbnail.ts 的 THUMBNAIL_WIDTHS 对齐)。 */
export const THUMBNAIL_RENDER_WIDTHS = [640, 1280] as const
export type ThumbnailRenderWidth = (typeof THUMBNAIL_RENDER_WIDTHS)[number]

/**
 * 按容器 CSS 渲染宽度 × dpr 选缩略档:目标 ≤640 → 640(标清),否则 1280(高清/retina)。
 * 只此两档,与服务端白名单一致。cssWidthPx ≤0 / 非有限 → 保守取 640。
 */
export function pickThumbnailWidth(cssWidthPx: number, dpr: number): ThumbnailRenderWidth {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const target = Number.isFinite(cssWidthPx) && cssWidthPx > 0 ? cssWidthPx * d : 640
  return target <= 640 ? 640 : 1280
}

/** 是否是同源签名媒体 URL(带 token 的 `/api/media-signed`)—— 只对这类追加 `w` / 走缩略。 */
export function isMediaSignedUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('/api/media-signed')
}

/**
 * 给签名 URL 追加缩略宽度 `w`(渲染参数,不进签名)。非签名 URL(data:/blob:/http/本地)
 * 或 width 为 null → 原样返回(那些不走服务端缩略)。签名 URL 必带 `?t=`,故用 `&` 追加。
 */
export function appendThumbnailWidth(url: string, width: number | null | undefined): string {
  if (width == null || !isMediaSignedUrl(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}w=${width}`
}

/** variant 段:有 width → `w<width>`,否则原图 `orig`。 */
export function byteCacheVariant(width: number | null | undefined): string {
  return width == null ? 'orig' : `w${width}`
}

/** 键分隔符:NUL —— 路径/标识不可能含 NUL,杜绝 identity 与 variant 拼接歧义。 */
const KEY_SEP = '\u0000'

/**
 * 给签名媒体缓存身份加鉴权命名空间。容器内路径只在单租户内唯一，不能裸作浏览器全局
 * LRU key；把稳定 user/authKey 编入 identity 后，旧账号迟到的异步写回也只能落旧命名空间。
 */
export function authScopedImageIdentity(
  authKey: string | number | null | undefined,
  identity: string | null | undefined,
): string | null {
  if (!identity) return null
  return `${String(authKey ?? 'anon')}${KEY_SEP}${identity}`
}

/** 规范化字节缓存键:`identity ∥ variant`。identity 为空 → null(不缓存,如纯本地 blob)。 */
export function byteCacheKey(identity: string | null | undefined, width: number | null | undefined): string | null {
  if (!identity) return null
  return `${identity}${KEY_SEP}${byteCacheVariant(width)}`
}

/** LRU 单条上限(spec:每项 ≤15MB;超过不缓存,直接用完即弃)。 */
export const IMAGE_BYTE_CACHE_MAX_ENTRY_BYTES = 15 * 1024 * 1024
/** LRU 条目数上限(spec:≤15 项)。 */
export const IMAGE_BYTE_CACHE_MAX_ENTRIES = 15

type Entry = { blob: Blob; size: number }

/**
 * 进程内(单页)LRU 字节缓存。存 Blob(消费方各自 createObjectURL + revoke,缓存不持有
 * objectURL 生命周期)。Map 保插入序,get 命中重插到队尾即 MRU;set 溢出从队首(LRU)逐。
 */
export class ImageByteCache {
  private map = new Map<string, Entry>()
  private epoch = 0
  constructor(
    private readonly maxEntries = IMAGE_BYTE_CACHE_MAX_ENTRIES,
    private readonly maxEntryBytes = IMAGE_BYTE_CACHE_MAX_ENTRY_BYTES,
  ) {}

  get(key: string | null | undefined): Blob | null {
    if (!key) return null
    const e = this.map.get(key)
    if (!e) return null
    // MRU:删除后重插到队尾
    this.map.delete(key)
    this.map.set(key, e)
    return e.blob
  }

  set(key: string | null | undefined, blob: Blob): void {
    if (!key) return
    const size = blob.size
    // 超单条上限 → 不缓存(超大原图不占内存),消费方仍可正常用这次的 blob。
    if (size > this.maxEntryBytes) {
      this.map.delete(key)
      return
    }
    this.map.delete(key)
    this.map.set(key, { blob, size })
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  /** 捕获当前鉴权缓存代次；异步 miss 在发请求前调用。 */
  captureEpoch(): number {
    return this.epoch
  }

  /**
   * 只允许同一代次的异步结果写回。登出/换号 clear 后，旧账号在途请求即使迟到也不能
   * 把字节重新塞进已清空的 LRU。同步调用方仍可使用 set。
   */
  setIfCurrentEpoch(key: string | null | undefined, blob: Blob, epoch: number): boolean {
    if (epoch !== this.epoch) return false
    this.set(key, blob)
    return true
  }

  has(key: string | null | undefined): boolean {
    return !!key && this.map.has(key)
  }

  /** 测试用:清空。 */
  clear(): void {
    this.map.clear()
    this.epoch += 1
  }

  /** 测试用:当前条目数。 */
  get size(): number {
    return this.map.size
  }
}

/** 单页共享单例 —— useProgressiveImage / fetchImageBlobWithResign / loadImageBytes 共用。 */
export const imageByteCache = new ImageByteCache()

/**
 * 取该图已缓存的**缩略**字节(优先高清 1280 → 640)。编辑器/查看器加载原图期用它做即时底图/
 * 预览(零请求、非灰屏)。identity 缺省或未命中 → null。不含原图('orig' 由各自逻辑另取)。
 */
export function getCachedThumbnail(identity: string | null | undefined): Blob | null {
  if (!identity) return null
  for (let i = THUMBNAIL_RENDER_WIDTHS.length - 1; i >= 0; i--) {
    const hit = imageByteCache.get(byteCacheKey(identity, THUMBNAIL_RENDER_WIDTHS[i]))
    if (hit) return hit
  }
  return null
}
