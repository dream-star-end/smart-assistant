/**
 * 服务端缩略图 —— `/api/media-signed?w=<width>` 的真提速面。
 *
 * **背景**:聊天气泡渲染的是容器盘上的**全尺寸 PNG**(生图/上传常有几 MB),用户在跨境
 * 链路上(仓内已知「下载慢 = 跨境带宽」)每张图都要拉完整字节 → 灰骨架长时间「加载中…」。
 * 缩略图把气泡渲染尺寸压到 webp(640/1280 宽,质量 82),字节量掉一个数量级,首屏即出图。
 *
 * **单一权威 / 语义边界**:
 *   - `w` 是**渲染参数**,不进签名语义(sign/verify 只覆盖 path+user+exp)。验签通过后
 *     才应用 `w`,由 `parseThumbnailWidth` 做白名单枚举校验(640/1280),挡任意值攻击
 *     (防攻击者用 `?w=<随机>` 撑爆缓存 / 打 sharp CPU)。
 *   - 取字节仍走**唯一权威** `containerFileProxy`(经 BufferingResponseSink 缓冲输出),
 *     不另开第二条容器取字节通路。本模块只负责:枚举校验、缓存键、resize、磁盘缓存。
 *   - `image/*` 才转;`image/svg+xml`(活跃内容)与 `image/gif`(动图,rasterize 会丢帧)
 *     直接透传原字节。非图(pdf/txt/...)本就不带 `w`。
 *
 * **磁盘缓存**:按 `sha256(userId ∥ mediaKind ∥ decodedPath ∥ width)` 键,落
 * `OPENCLAUDE_HOME/media-thumb-cache/`。**userId 进键是安全红线** —— `file` kind 的
 * `decodedPath` 是容器内绝对路径,不同用户容器里同一路径(如
 * `/home/agent/.openclaude/generated/foo.png`)指向不同内容;不带 userId 会跨租户投毒。
 * `media` kind 文件名虽是内容寻址 digest,同带 userId 更保守(容器内 tenant scope)。
 *
 * 缓存**启动即清**(见 ThumbnailDiskCache.init):按 spec「启动可清」,以重启节奏为磁盘
 * 增长上界;内容寻址路径在单次运行内碰撞概率可忽略,过期风险以启动清零兜底。
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { CapturedResponse } from './bufferingResponseSink.js'

/**
 * 白名单枚举宽度。前端按容器实际渲染尺寸 × dpr 选 640(标清/1x)或 1280(高清/2x)。
 * 只此两档 —— 枚举而非区间,任意 `w` 一律拒,缓存键空间与 CPU 面都收敛到常数。
 */
export const THUMBNAIL_WIDTHS = [640, 1280] as const
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number]

/** 缩略 webp 质量(spec ~82)。 */
const THUMBNAIL_WEBP_QUALITY = 82

/**
 * 允许缓冲 + resize 的原图字节上限。超过 → 不缩、直接透传原字节(避免把超大图整个入
 * master 内存 + 喂 sharp)。spec 说气泡图「几 MB」,32MiB 给足冗余。
 */
export const THUMBNAIL_MAX_SOURCE_BYTES = 32 * 1024 * 1024

export type ParsedThumbnailWidth =
  /** 无 `w` 参数 → 取原图(灯箱/查看器/编辑器/下载走这条)。 */
  | { kind: 'none' }
  /** `w` 命中白名单。 */
  | { kind: 'width'; width: ThumbnailWidth }
  /** `w` 存在但非白名单 → handler 应 400(防任意值攻击)。 */
  | { kind: 'invalid' }

/**
 * 解析 `?w=` query 值。空/缺省 → none;非白名单(含非数字、越界)→ invalid;命中 → width。
 * `w` 不进签名,验签后由本函数守门。
 */
export function parseThumbnailWidth(raw: string | null | undefined): ParsedThumbnailWidth {
  if (raw == null || raw === '') return { kind: 'none' }
  if (!/^\d{1,5}$/.test(raw)) return { kind: 'invalid' }
  const n = Number.parseInt(raw, 10)
  if ((THUMBNAIL_WIDTHS as readonly number[]).includes(n)) {
    return { kind: 'width', width: n as ThumbnailWidth }
  }
  return { kind: 'invalid' }
}

/**
 * 该 Content-Type 是否走 webp 缩略。`image/*` 且非 svg(活跃内容,强制 attachment)、
 * 非 gif(动图,rasterize 丢帧)。其余(含非图)→ 透传原字节。
 */
export function isThumbnailableImage(contentType: string | undefined | null): boolean {
  if (!contentType) return false
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (!base.startsWith('image/')) return false
  if (base === 'image/svg+xml') return false
  if (base === 'image/gif') return false
  return true
}

/**
 * 稳定、租户隔离的缓存键。userId 进键防跨租户投毒(见文件头注)。返回 sha256 hex,
 * 直接作为磁盘文件名(hex 无路径分隔符 / traversal 风险)。
 */
export function thumbnailCacheKey(input: {
  userId: string
  mediaKind: 'file' | 'media' | 'inbox'
  decodedPath: string
  width: number
}): string {
  const h = createHash('sha256')
  h.update(input.userId)
  h.update('\0')
  h.update(input.mediaKind)
  h.update('\0')
  h.update(input.decodedPath)
  h.update('\0')
  h.update(String(input.width))
  return h.digest('hex')
}

/**
 * 等比缩到宽 ≤ width 的 webp。`withoutEnlargement` 保证不放大(原图窄于 width → 原样,
 * 只换 webp 编码)。`rotate()` 吃 EXIF 方向(手机竖拍不至于横过来)。
 * sharp 已是 master 依赖(imageEdit 在用),无新增 npm 依赖。
 */
export async function resizeToWebpThumbnail(input: Buffer, width: number): Promise<Buffer> {
  return sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer()
}

/**
 * 缩略图磁盘缓存。键 = thumbnailCacheKey 的 hex,落 `<dir>/<hex>.webp`。
 *
 * - init():启动清零(rm -rf + mkdir 0700)。以重启节奏为磁盘增长上界(见文件头注)。
 * - get():命中回 buffer(Content-Length = buffer.length,天然正确)。
 * - put():临时文件 + rename 原子落盘,防并发/半写。同键并发 resize 无害(rename 后写覆盖)。
 */
export class ThumbnailDiskCache {
  constructor(private readonly dir: string) {}

  /** 启动清零并重建缓存目录。registerCommercial 启动期 await 一次。 */
  async init(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.webp`)
  }

  async get(key: string): Promise<{ buffer: Buffer } | null> {
    try {
      const buffer = await readFile(this.pathFor(key))
      return { buffer }
    } catch {
      return null
    }
  }

  async put(key: string, buffer: Buffer): Promise<void> {
    const dest = this.pathFor(key)
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, buffer, { mode: 0o600 })
      await rename(tmp, dest)
    } catch (err) {
      try {
        await rm(tmp, { force: true })
      } catch {
        /* best effort cleanup */
      }
      throw err
    }
  }
}

/** 大小写不敏感取单个响应头(proxy 写入的 headers 大小写混合)。 */
function getHeaderCI(
  headers: Record<string, string | string[] | number>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      const first = Array.isArray(v) ? v[0] : v
      return first == null ? undefined : String(first)
    }
  }
  return undefined
}

export type ThumbnailRenderResult =
  /** 出字节:resize 后的 webp,或(非图/gif/svg/resize 失败)透传原字节。 */
  | { kind: 'bytes'; contentType: string; body: Buffer }
  /** 上游非 200(403/404/410/503/JSON error)→ 原样回放,不缓存。 */
  | { kind: 'passthrough-error'; statusCode: number; headers: Record<string, string | string[] | number>; body: Buffer }
  /** 原图超上限未缩全 → 调用方回退成原图流式。 */
  | { kind: 'stream-original' }
  /** 已发头后 upstream 中断(缓冲不完整)→ 调用方 502,永不出损坏字节。 */
  | { kind: 'upstream-error' }

/**
 * 把 `containerFileProxy` 经 BufferingResponseSink 缓冲下来的响应,渲染成缩略结果。
 *
 * **纯函数式**(除 sharp resize + cache.put 的 IO):喂一个 CapturedResponse 即可断言
 * 「缩略缓存写入 / 非图透传 / 上游错误回放 / Content-Length」,无需真跑 proxy。
 *
 * 判定顺序:
 *   1. truncated(超 maxBytes,字节不全)→ stream-original(回退原图,绝不缩半截)。
 *   2. statusCode ≠ 200 → passthrough-error(原样回放上游错误)。
 *   3. errored(200 但缓冲中断)→ upstream-error(502)。
 *   4. 200 + image/*(非 svg/gif)→ resize webp + 落盘;resize 抛错 → 透传原字节。
 *   5. 200 + 其余(gif/svg/非图)→ 透传原字节。
 */
export async function renderThumbnail(
  cap: CapturedResponse,
  opts: { cache: ThumbnailDiskCache; cacheKey: string; width: number },
): Promise<ThumbnailRenderResult> {
  if (cap.truncated) return { kind: 'stream-original' }
  if (cap.statusCode !== 200) {
    return {
      kind: 'passthrough-error',
      statusCode: cap.statusCode,
      headers: cap.headers,
      body: cap.body,
    }
  }
  if (cap.errored) return { kind: 'upstream-error' }

  const contentType = getHeaderCI(cap.headers, 'content-type')
  if (isThumbnailableImage(contentType)) {
    try {
      const webp = await resizeToWebpThumbnail(cap.body, opts.width)
      await opts.cache.put(opts.cacheKey, webp)
      return { kind: 'bytes', contentType: 'image/webp', body: webp }
    } catch {
      // 损坏图 / sharp 不支持的编码 → 透传原字节(不缓存),永不裂图。
      return { kind: 'bytes', contentType: contentType ?? 'application/octet-stream', body: cap.body }
    }
  }
  // 非图 / gif 动图 / svg → 透传原字节。
  return { kind: 'bytes', contentType: contentType ?? 'application/octet-stream', body: cap.body }
}
