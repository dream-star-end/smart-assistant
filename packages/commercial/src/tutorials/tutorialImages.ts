import { createHash } from 'node:crypto'
import sharp, { type Metadata } from 'sharp'

import { query, tx, type QueryRunner } from '../db/queries.js'
import { sanitizeTutorialImageBytes } from './snapshotSanitizer.js'

// 「经验分享」图片：作者先上传（tutorial_blob_uploads 记上传者），投稿时正文里的
// `![alt](tutorial-blob:<sha256>)` 绑定成 tutorial_blob_refs。公开读取仍只走
// /api/tutorial-embeds（引用它的稿件必须 approved），这里只管上传、归属和作者预览。

/** 上传的原图上限（前端会先压成 webp，正常远小于此）。 */
export const TUTORIAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/**
 * 去元数据后实际入库的上限：tutorial_blobs.bytes 的既有 CHECK（8 MiB）。0320 不放宽它，
 * 因为个人版列车的破坏性 DDL 门拒绝 ALTER ... DROP。
 */
export const TUTORIAL_IMAGE_STORED_MAX_BYTES = 8 * 1024 * 1024
/** 图片按既有的 'media' kind 入库（同理不扩 kind 的 CHECK），靠 mime 与 image: role 区分。 */
export const TUTORIAL_IMAGE_BLOB_KIND = 'media'
export const TUTORIAL_IMAGE_MAX_PER_POST = 20
export const TUTORIAL_IMAGE_DAILY_UPLOADS = 200
export const TUTORIAL_IMAGE_MAX_SIDE = 16_384
export const TUTORIAL_IMAGE_MAX_PIXELS = 50_000_000

export const TUTORIAL_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type TutorialImageMime = (typeof TUTORIAL_IMAGE_MIMES)[number]

export class TutorialImageError extends Error {
  constructor(
    readonly code: 'BAD_IMAGE' | 'TOO_LARGE' | 'RATE_LIMITED' | 'EXTERNAL_IMAGE' | 'TOO_MANY_IMAGES',
    message: string,
  ) {
    super(message)
    this.name = 'TutorialImageError'
  }
}

export function communityBlogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OC_COMMUNITY_BLOG_ENABLED?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/** 只认魔数，不信 Content-Type。 */
export function detectTutorialImageMime(body: Buffer): TutorialImageMime | null {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  return null
}

export type PreparedTutorialImage = {
  sha256: string
  mime: 'image/png' | 'image/webp'
  body: Buffer
  width: number
  height: number
}

async function decodedSize(body: Buffer): Promise<{ width: number; height: number }> {
  let metadata: Metadata
  try {
    metadata = await sharp(body, {
      animated: true,
      failOn: 'error',
      limitInputPixels: TUTORIAL_IMAGE_MAX_PIXELS,
    }).metadata()
  } catch {
    throw new TutorialImageError('BAD_IMAGE', '图片损坏或像素数超过限制')
  }
  if ((metadata.pages ?? 1) !== 1) throw new TutorialImageError('BAD_IMAGE', '不支持动图或多帧图片')
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width < 1 || height < 1) throw new TutorialImageError('BAD_IMAGE', '无法读取图片尺寸')
  if (width > TUTORIAL_IMAGE_MAX_SIDE || height > TUTORIAL_IMAGE_MAX_SIDE)
    throw new TutorialImageError('BAD_IMAGE', `图片任一边不能超过 ${TUTORIAL_IMAGE_MAX_SIDE} px`)
  return { width, height }
}

/**
 * 校验并去掉元数据。png/webp 按 chunk 白名单剥离（不重编码，没有二次压缩）；jpeg 没有
 * 安全的无损剥离路径，用 sharp 转 webp，重编码本身就丢掉 EXIF/GPS，并把方向固化进像素。
 * 剥离后的字节再解码一次，确认仍是单帧且尺寸合规。
 */
export async function prepareTutorialImage(
  body: Buffer,
  declaredMime: string | undefined,
): Promise<PreparedTutorialImage> {
  if (body.length === 0) throw new TutorialImageError('BAD_IMAGE', '图片为空')
  if (body.length > TUTORIAL_IMAGE_MAX_BYTES)
    throw new TutorialImageError('TOO_LARGE', '单张图片不能超过 10MB')
  const mime = detectTutorialImageMime(body)
  if (!mime) throw new TutorialImageError('BAD_IMAGE', '只支持 PNG、JPEG、WebP 图片')
  const declared = declaredMime?.split(';')[0]?.trim().toLowerCase()
  const normalizedDeclared = declared === 'image/jpg' ? 'image/jpeg' : declared
  if (normalizedDeclared !== mime) throw new TutorialImageError('BAD_IMAGE', '图片格式与 Content-Type 不一致')

  let output: Buffer
  let outputMime: 'image/png' | 'image/webp'
  if (mime === 'image/jpeg') {
    await decodedSize(body)
    try {
      output = await sharp(body, { failOn: 'error', limitInputPixels: TUTORIAL_IMAGE_MAX_PIXELS })
        .rotate()
        .webp({ quality: 90, effort: 4 })
        .toBuffer()
    } catch {
      throw new TutorialImageError('BAD_IMAGE', '图片转换失败')
    }
    outputMime = 'image/webp'
  } else {
    const sanitized = sanitizeTutorialImageBytes(mime, body)
    if (!sanitized) throw new TutorialImageError('BAD_IMAGE', '图片结构无效')
    output = sanitized
    outputMime = mime
  }
  if (output.length > TUTORIAL_IMAGE_STORED_MAX_BYTES)
    throw new TutorialImageError('TOO_LARGE', '图片处理后仍超过 8MB，请压缩后再上传')
  const { width, height } = await decodedSize(output)
  // metadata() 只读头部；缩到 64px 会把整条像素流解一遍，压缩流损坏的图在这里拦下。
  try {
    await sharp(output, { failOn: 'error', limitInputPixels: TUTORIAL_IMAGE_MAX_PIXELS })
      .resize(64, 64, { fit: 'inside' })
      .raw()
      .toBuffer()
  } catch {
    throw new TutorialImageError('BAD_IMAGE', '图片数据损坏')
  }
  return {
    sha256: createHash('sha256').update(output).digest('hex'),
    mime: outputMime,
    body: output,
    width,
    height,
  }
}

/**
 * 写入图片和上传者。同一用户重复上传同一张图是幂等的，不占当日额度；每用户 24 小时最多
 * TUTORIAL_IMAGE_DAILY_UPLOADS 张，计数和插入在同一把 advisory 锁里完成。
 */
export async function storeTutorialImageUpload(
  userId: string,
  image: PreparedTutorialImage,
): Promise<void> {
  await tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `tutorial-image-upload:${userId}`,
    ])
    const existing = await client.query(
      'SELECT 1 FROM tutorial_blob_uploads WHERE sha256 = $1 AND user_id = $2::bigint',
      [image.sha256, userId],
    )
    if (existing.rowCount === 1) return
    const recent = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tutorial_blob_uploads
        WHERE user_id = $1::bigint AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    )
    if (Number(recent.rows[0]?.n ?? 0) >= TUTORIAL_IMAGE_DAILY_UPLOADS)
      throw new TutorialImageError('RATE_LIMITED', `24 小时内最多上传 ${TUTORIAL_IMAGE_DAILY_UPLOADS} 张图片`)
    await client.query(
      `INSERT INTO tutorial_blobs (sha256, kind, mime, bytes, body)
       VALUES ($1, $5, $2, $3, $4)
       ON CONFLICT (sha256) DO NOTHING`,
      [image.sha256, image.mime, image.body.length, image.body, TUTORIAL_IMAGE_BLOB_KIND],
    )
    await client.query(
      `INSERT INTO tutorial_blob_uploads (sha256, user_id) VALUES ($1, $2::bigint)
       ON CONFLICT (sha256, user_id) DO NOTHING`,
      [image.sha256, userId],
    )
  })
}

const IMAGE_REF_RE = /tutorial-blob:([a-f0-9]{64})\b/g
// 只认一种图片写法：`![说明](tutorial-blob:<sha256> "可选标题")`。所有量词都有上界，配合
// 下面按 `![` 逐个定位的循环，整篇解析是线性的（Codex R1 P1：无界正则在 2 万个反引号上
// 回溯 6 秒，会卡住事件循环）。
const IMAGE_AT_RE =
  /!\[[^\]\n]{0,500}\]\([ \t]{0,20}<?tutorial-blob:([a-f0-9]{64})>?(?:[ \t]{1,20}(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?[ \t]{0,20}\)/y
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/

/** 去掉围栏代码块（逐行）和行内代码（逐个反引号串配对），都是线性扫描。 */
function withoutCode(markdown: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const open = FENCE_OPEN_RE.exec(line)
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && line.trim() === open[1])
        fence = null
      continue
    }
    if (open) {
      fence = open[1]!
      continue
    }
    kept.push(line)
  }
  return stripInlineCode(kept.join('\n'))
}

/**
 * 行内代码：长度为 n 的反引号串与下一个长度同为 n 的串配对，中间整段去掉；配不上的串按
 * 普通文字保留。某个长度配对失败，说明它后面再没有同长度的串，记下来以后直接跳过，
 * 所以每种长度最多整段扫一次（Codex R2 P2）。
 */
function stripInlineCode(text: string): string {
  let out = ''
  let i = 0
  const unmatched = new Set<number>()
  while (i < text.length) {
    const tick = text.indexOf('`', i)
    if (tick < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, tick)
    let runEnd = tick
    while (runEnd < text.length && text[runEnd] === '`') runEnd += 1
    const run = runEnd - tick
    let close = -1
    let k = unmatched.has(run) ? text.length : runEnd
    while (k < text.length) {
      const next = text.indexOf('`', k)
      if (next < 0) break
      let end = next
      while (end < text.length && text[end] === '`') end += 1
      if (end - next === run) {
        close = next
        break
      }
      k = end
    }
    if (close < 0) {
      unmatched.add(run)
      out += text.slice(tick, runEnd)
      i = runEnd
    } else {
      i = close + run
    }
  }
  return out
}

/** 依次取正文里每个 `![`：合法的本站图片返回 sha，其它写法返回 null。 */
function* imageMarks(markdown: string): Generator<string | null> {
  const text = withoutCode(markdown)
  let from = 0
  while (true) {
    const at = text.indexOf('![', from)
    if (at < 0) return
    IMAGE_AT_RE.lastIndex = at
    const match = IMAGE_AT_RE.exec(text)
    if (match) {
      yield match[1]!
      from = IMAGE_AT_RE.lastIndex
    } else {
      yield null
      from = at + 2
    }
  }
}

/**
 * 解析正文里的图片。代码块里的示例不算图片；正文里每个 `![` 都必须是
 * `![说明](tutorial-blob:<sha256>)`，外链、data URL、引用式和快捷引用式图片一律拒收，
 * 以免绕过地址检查。返回按首次出现排序、去重后的 sha 列表。
 */
export function parseTutorialImageRefs(markdown: string): string[] {
  const shas: string[] = []
  for (const sha of imageMarks(markdown)) {
    if (sha === null)
      throw new TutorialImageError('EXTERNAL_IMAGE', '正文只能用 ![说明](图片) 插入本站上传的图片，不支持外链图片')
    if (!shas.includes(sha)) shas.push(sha)
  }
  if (shas.length > TUTORIAL_IMAGE_MAX_PER_POST)
    throw new TutorialImageError('TOO_MANY_IMAGES', `每篇最多 ${TUTORIAL_IMAGE_MAX_PER_POST} 张图片`)
  return shas
}

/** 第一张图（用作封面），代码块里的不算。 */
export function firstTutorialImageSha(markdown: string): string | null {
  for (const sha of imageMarks(markdown)) if (sha) return sha
  return null
}

/** 泄密扫描会把 32/64 位十六进制当成 trace/container id；扫描前把图片地址换成占位。 */
export function maskTutorialImageRefs(markdown: string): string {
  return markdown.replace(IMAGE_REF_RE, 'tutorial-blob:image')
}

/** 中文约 400 字/分钟；至少 1 分钟。 */
export function tutorialReadMinutes(chars: number): number {
  return Math.max(1, Math.ceil(chars / 400))
}

export function tutorialImageRole(sha256: string, taken: ReadonlySet<string>): string {
  const short = `image:${sha256.slice(0, 12)}`
  return taken.has(short) ? `image:${sha256}` : short
}

/** 每张都必须由作者本人上传过，否则整篇拒收（不泄露别人的图是否存在）。 */
export async function assertTutorialImagesOwned(
  authorUserId: string,
  shas: readonly string[],
  runner: QueryRunner,
): Promise<void> {
  if (shas.length === 0) return
  const owned = await query<{ sha256: string }>(
    `SELECT sha256 FROM tutorial_blob_uploads
      WHERE user_id = $1::bigint AND sha256 = ANY($2::text[])`,
    [authorUserId, shas],
    runner,
  )
  const ownedSet = new Set(owned.rows.map((row) => row.sha256))
  if (shas.some((sha) => !ownedSet.has(sha)))
    throw new TutorialImageError('BAD_IMAGE', '正文引用了不存在或不属于你的图片，请重新上传')
}

/** 修改后重绑图片：先删稿件的图片引用（快照的其它 blob 不动），再按新正文绑定。 */
export async function replaceTutorialImageRefs(
  args: { publicationId: string; authorUserId: string; shas: readonly string[] },
  runner: QueryRunner,
): Promise<void> {
  await query(`DELETE FROM tutorial_blob_refs WHERE publication_id = $1::bigint AND role LIKE 'image:%'`, [args.publicationId], runner)
  await bindTutorialImages(args, runner)
}

/**
 * 投稿时绑定图片：每张都必须由作者本人上传过，否则整篇拒收（不泄露别人的图是否存在）。
 */
export async function bindTutorialImages(
  args: { publicationId: string; authorUserId: string; shas: readonly string[] },
  runner: QueryRunner,
): Promise<void> {
  if (args.shas.length === 0) return
  await assertTutorialImagesOwned(args.authorUserId, args.shas, runner)
  const roles = new Set<string>()
  for (const sha of args.shas) {
    const role = tutorialImageRole(sha, roles)
    roles.add(role)
    await query(
      'INSERT INTO tutorial_blob_refs (publication_id, sha256, role) VALUES ($1::bigint, $2, $3)',
      [args.publicationId, sha, role],
      runner,
    )
  }
}

export type ViewableTutorialImage = { mime: string; body: Buffer }

/**
 * 作者预览 / 管理员复核用的读取：上传者本人、引用它的稿件作者、管理员可读。
 * 其他人一律 null（调用方回 404，不区分不存在与无权）。
 */
export async function getTutorialImageForViewer(
  args: { sha256: string; userId: string; isAdmin: boolean },
  runner?: QueryRunner,
): Promise<ViewableTutorialImage | null> {
  if (!/^[a-f0-9]{64}$/.test(args.sha256)) return null
  const result = await query<{ mime: string; body: Buffer; sha256: string }>(
    `SELECT b.sha256, b.mime, b.body
       FROM tutorial_blobs b
      WHERE b.sha256 = $1
        AND b.mime IN ('image/png', 'image/webp')
        AND (
          $3::boolean
          OR EXISTS (SELECT 1 FROM tutorial_blob_uploads u
                      WHERE u.sha256 = b.sha256 AND u.user_id = $2::bigint)
          OR EXISTS (SELECT 1 FROM tutorial_blob_refs r
                       JOIN community_tutorials t ON t.id = r.publication_id
                      WHERE r.sha256 = b.sha256 AND t.author_user_id = $2::bigint)
        )`,
    [args.sha256, args.userId, args.isAdmin],
    runner,
  )
  const row = result.rows[0]
  if (!row) return null
  const body = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body)
  if (createHash('sha256').update(body).digest('hex') !== row.sha256) return null
  return { mime: row.mime, body }
}
