import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { query } from '../db/queries.js'

export const MAX_INBOX_ASSETS = 8
export const MAX_INBOX_ASSET_INPUT_BYTES = 5 * 1024 * 1024
export const MAX_INBOX_ASSET_TOTAL_INPUT_BYTES = 15 * 1024 * 1024
export const MAX_INBOX_ASSET_OUTPUT_BYTES = 5 * 1024 * 1024
export const MAX_INBOX_ASSET_INPUT_SIDE = 16_384
export const MAX_INBOX_ASSET_INPUT_PIXELS = 24_000_000
export const MAX_INBOX_ASSET_OUTPUT_SIDE = 8_192

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PLACEHOLDER_RE =
  /inbox-asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi
const PLACEHOLDER_SCHEME_RE = /inbox-asset:\/\//i
const STORED_ASSET_URL_RE = /\/api\/inbox-assets\/[0-9a-f-]{36}/i
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type InboxAssetInput = {
  client_id: string
  filename: string
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  data_base64: string
}

export type PreparedInboxAsset = {
  id: string
  filename: string
  mimeType: 'image/webp'
  sizeBytes: number
  sha256: string
  data: Buffer
}

export type PreparedInboxRichBody = {
  bodyMd: string
  assets: PreparedInboxAsset[]
}

export class InboxAssetValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: Array<string | number>; message: string }>,
  ) {
    super(message)
    this.name = 'InboxAssetValidationError'
  }
}

function validation(path: Array<string | number>, message: string): never {
  throw new InboxAssetValidationError(message, [{ path, message }])
}

function decodeBase64(raw: string, index: number): Buffer {
  if (
    raw.length === 0 ||
    raw.length > Math.ceil(MAX_INBOX_ASSET_INPUT_BYTES / 3) * 4 + 4 ||
    !STRICT_BASE64_RE.test(raw)
  ) {
    validation(['assets', index, 'data_base64'], '图片数据不是合法 base64')
  }
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== raw) {
    validation(['assets', index, 'data_base64'], '图片数据不是规范 base64')
  }
  if (decoded.length > MAX_INBOX_ASSET_INPUT_BYTES) {
    validation(['assets', index, 'data_base64'], '单张图片不能超过 5 MiB')
  }
  return decoded
}

function normalizedFilename(raw: string): string {
  const leaf =
    raw
      .trim()
      .split(/[\\/]/)
      .pop()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must not retain control bytes
      ?.replace(/[\u0000-\u001f\u007f]/g, '') ?? ''
  const stem =
    leaf
      .replace(/\.[^.]*$/, '')
      .trim()
      .slice(0, 246) || 'image'
  return `${stem}.webp`
}

async function normalizeImage(
  input: InboxAssetInput,
  index: number,
  source: Buffer,
): Promise<PreparedInboxAsset> {
  let metadata: sharp.Metadata
  try {
    metadata = await sharp(source, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_INBOX_ASSET_INPUT_PIXELS,
    }).metadata()
  } catch {
    validation(['assets', index, 'data_base64'], '图片损坏或像素数超过限制')
  }

  const expectedFormat = input.mime_type === 'image/jpeg' ? 'jpeg' : input.mime_type.slice(6)
  if (metadata.format !== expectedFormat) {
    validation(['assets', index, 'mime_type'], '图片 MIME 与真实格式不一致')
  }
  if ((metadata.pages ?? 1) !== 1) {
    validation(['assets', index, 'data_base64'], '不支持动画或多帧图片')
  }
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width < 1 || height < 1) {
    validation(['assets', index, 'data_base64'], '无法读取图片尺寸')
  }
  if (width > MAX_INBOX_ASSET_INPUT_SIDE || height > MAX_INBOX_ASSET_INPUT_SIDE) {
    validation(['assets', index, 'data_base64'], '图片任一边不能超过 16,384 px')
  }
  if (width * height > MAX_INBOX_ASSET_INPUT_PIXELS) {
    validation(['assets', index, 'data_base64'], '图片不能超过 24,000,000 px')
  }

  let output: Buffer
  try {
    output = await sharp(source, {
      failOn: 'error',
      limitInputPixels: MAX_INBOX_ASSET_INPUT_PIXELS,
    })
      .rotate()
      .resize({
        width: MAX_INBOX_ASSET_OUTPUT_SIDE,
        height: MAX_INBOX_ASSET_OUTPUT_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 84, effort: 4 })
      .toBuffer()
  } catch {
    validation(['assets', index, 'data_base64'], '图片归一化失败')
  }
  if (output.length > MAX_INBOX_ASSET_OUTPUT_BYTES) {
    validation(['assets', index, 'data_base64'], '图片归一化后仍超过 5 MiB')
  }

  return {
    id: randomUUID(),
    filename: normalizedFilename(input.filename),
    mimeType: 'image/webp',
    sizeBytes: output.length,
    sha256: createHash('sha256').update(output).digest('hex'),
    data: output,
  }
}

/**
 * 校验图片引用并归一化字节。这里不写数据库；调用方必须把返回的正文、消息行、资产行和
 * 邮件快照放进同一个事务。没有 assets 的旧 payload 原样返回，保持兼容。
 */
export async function prepareInboxRichBody(
  bodyMd: string,
  inputs: InboxAssetInput[] | undefined,
): Promise<PreparedInboxRichBody> {
  const assets = inputs ?? []
  if (assets.length > MAX_INBOX_ASSETS) {
    validation(['assets'], '每条站内信最多 8 张图片')
  }
  if (STORED_ASSET_URL_RE.test(bodyMd)) {
    validation(['body_md'], '不能直接复用其他站内信的图片地址')
  }

  const byClientId = new Map<string, { input: InboxAssetInput; index: number }>()
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index]!
    const clientId = asset.client_id.toLowerCase()
    if (byClientId.has(clientId)) {
      validation(['assets', index, 'client_id'], 'client_id 不能重复')
    }
    byClientId.set(clientId, { input: asset, index })
  }

  const referenced = new Set<string>()
  for (const match of bodyMd.matchAll(PLACEHOLDER_RE)) {
    const clientId = match[1]!.toLowerCase()
    if (!byClientId.has(clientId)) {
      validation(['body_md'], `正文引用了未上传的图片 ${clientId}`)
    }
    referenced.add(clientId)
  }
  for (const [clientId, item] of byClientId) {
    if (!referenced.has(clientId)) {
      validation(['assets', item.index], '上传图片必须在正文中引用')
    }
  }

  const decoded = assets.map((asset, index) => decodeBase64(asset.data_base64, index))
  const totalInputBytes = decoded.reduce((sum, source) => sum + source.length, 0)
  if (totalInputBytes > MAX_INBOX_ASSET_TOTAL_INPUT_BYTES) {
    validation(['assets'], '图片总大小不能超过 15 MiB')
  }

  // sharp 解码 24 MP 图片时会占用显著内存；最多 8 张必须串行归一化，避免一次发送并发放大峰值。
  const normalized: PreparedInboxAsset[] = []
  for (let index = 0; index < assets.length; index++) {
    normalized.push(await normalizeImage(assets[index]!, index, decoded[index]!))
  }
  const serverIdByClientId = new Map<string, string>()
  assets.forEach((asset, index) => {
    serverIdByClientId.set(asset.client_id.toLowerCase(), normalized[index]!.id)
  })
  const finalBody = bodyMd.replace(PLACEHOLDER_RE, (_whole, clientId: string) => {
    return `/api/inbox-assets/${serverIdByClientId.get(clientId.toLowerCase())!}`
  })
  if (!finalBody.trim()) validation(['body_md'], '正文不能为空')
  if (Array.from(finalBody).length > 16_384) {
    validation(['body_md'], '替换图片引用后正文不能超过 16,384 字符')
  }
  if (PLACEHOLDER_SCHEME_RE.test(finalBody)) {
    validation(['body_md'], '正文仍包含未解析或格式错误的图片引用')
  }
  return { bodyMd: finalBody, assets: normalized }
}

export function inboxAssetIdFromPath(path: string): string | null {
  const match =
    /^\/api\/inbox-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
      path,
    )
  return match ? match[1]!.toLowerCase() : null
}

export type InboxAssetViewerRole = 'user' | 'admin'

export async function canAccessInboxAsset(
  viewerId: string,
  role: InboxAssetViewerRole,
  assetId: string,
): Promise<boolean> {
  if (!UUID_RE.test(assetId)) return false
  const r = await query(
    `SELECT 1
       FROM inbox_message_assets a
       JOIN inbox_messages m ON m.id = a.message_id
       JOIN users viewer
         ON viewer.id = $1::bigint
        AND viewer.status = 'active'
        AND viewer.role = $3
      WHERE a.id = $2::uuid
        AND (
          viewer.role = 'admin'
          OR (
            viewer.role = 'user'
            AND (
              (m.audience = 'user' AND m.user_id = viewer.id)
              OR (m.audience = 'all' AND m.created_at >= viewer.created_at)
            )
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
          )
        )
      LIMIT 1`,
    [viewerId, assetId, role],
  )
  return r.rows.length > 0
}

export type InboxAssetBytes = {
  data: Buffer
  mimeType: 'image/webp'
  filename: string
}

export async function readInboxAssetForViewer(
  viewerId: string,
  role: InboxAssetViewerRole,
  assetId: string,
): Promise<InboxAssetBytes | null> {
  if (!UUID_RE.test(assetId)) return null
  const r = await query<{ data: Buffer; mime_type: 'image/webp'; filename: string }>(
    `SELECT a.data, a.mime_type, a.filename
       FROM inbox_message_assets a
       JOIN inbox_messages m ON m.id = a.message_id
       JOIN users viewer
         ON viewer.id = $1::bigint
        AND viewer.status = 'active'
        AND viewer.role = $3
      WHERE a.id = $2::uuid
        AND (
          viewer.role = 'admin'
          OR (
            viewer.role = 'user'
            AND (
              (m.audience = 'user' AND m.user_id = viewer.id)
              OR (m.audience = 'all' AND m.created_at >= viewer.created_at)
            )
            AND (m.expires_at IS NULL OR m.expires_at > NOW())
          )
        )
      LIMIT 1`,
    [viewerId, assetId, role],
  )
  const row = r.rows[0]
  return row ? { data: row.data, mimeType: row.mime_type, filename: row.filename } : null
}
