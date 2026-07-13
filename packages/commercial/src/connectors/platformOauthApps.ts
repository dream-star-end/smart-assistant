/**
 * platformOauthApps —— 平台自有 OAuth App 凭据存储(0139 表 connector_platform_oauth_apps)。
 *
 * oauth2-auth-code 的两种 client 供给模式(契约字段 oauth2.clientProvisioning):
 *   - `byoa`     用户自带 OAuth App:client_id/client_secret 由用户在授权表单直填,进加密 pending draft;
 *   - `platform` 平台注册 OAuth App:凭据存**本表**(按 slug 一行),用户一键授权、什么都不填。
 *
 * 安全不变量(本模块是 platform 模式凭据的存储权威):
 *   - 生产唯一写入口 = admin API；它额外校验精确官方工件 + 已签 platform 契约。本模块保留
 *     可注入 QueryRunner 的低层存储原语供事务与加密测试使用。未 provision 的 slug 一律
 *     fail-closed(oauth/start → OAUTH_NOT_CONFIGURED;catalog 直接不展示该连接器)。
 *   - client_secret **只**出现在:本表密文、内存里的一次交换、发往 **token origin** 的请求体/basic 头。
 *     它**绝不**进用户连接袋(connections.secret_enc)、绝不进 oauth pending draft、绝不进
 *     authorize URL、绝不进任何日志/API 响应(listPlatformOauthApps 结构上就不返回它)。
 *   - AAD = `platform_oauth:{aad_seed}:{slug}`(照 oauthPending.oauthDraftAad 范式)。aad_seed
 *     每次写入重生成 → 旧密文无法被移植到别的 slug / 新一代行上(改 slug 或换 seed 后解密必失败)。
 *   - 明文 Buffer 一律 zeroBuffer(key 与 secret 明文都是)。
 */

import { randomUUID } from 'node:crypto'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import type { QueryRunner } from '../db/queries.js'
import { ConnectorError } from './errors.js'

/** slug 形状(= spec/types.ts Slug,与 0139 的 CHECK 同源;写入前先在应用层挡一道)。 */
const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/
const MAX_CLIENT_ID_LEN = 256
const MAX_CLIENT_SECRET_LEN = 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: 凭据会进 header/body,禁 CR/LF/控制符
const HAS_CONTROL = /[\x00-\x1f\x7f]/

/** AAD:`platform_oauth:{aad_seed}:{slug}`(公式与 oauthPending 同范式)。 */
export function platformOauthAppAad(aadSeed: string, slug: string): Buffer {
  return Buffer.from(`platform_oauth:${aadSeed}:${slug}`, 'utf8')
}

export interface PlatformOauthApp {
  clientId: string
  clientSecret: string
}

/** 列表投影 —— **结构上不含 secret**(admin 列表/前端只看得到公开标识 + 时间)。 */
export interface PlatformOauthAppSummary {
  slug: string
  clientId: string
  updatedAt: Date
}

export interface UpsertPlatformOauthAppInput {
  slug: string
  clientId: string
  clientSecret: string
  /** 操作 admin 的 user id(审计溯源;该用户被删 → 列置 NULL,凭据行仍在)。 */
  updatedBy?: number | string | null
}

function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new ConnectorError('BAD_REQUEST', 'invalid connector slug')
  return slug
}

/** 凭据值形状校验:非空有界、无 CRLF/控制符(值本身绝不进 message)。 */
function assertCredential(v: string, what: string, maxLen: number): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxLen)
    throw new ConnectorError('BAD_REQUEST', `${what} must be a bounded non-empty string`)
  if (HAS_CONTROL.test(v)) throw new ConnectorError('BAD_REQUEST', `${what} has control char`)
  return v
}

/**
 * provision / 轮换平台 OAuth App(admin only)。每次写入**换 aad_seed**(旧密文即刻作废,
 * 不可移植),updated_at/updated_by 一并刷新。已存在同 slug → 整行覆盖(轮换 secret 的语义)。
 *
 * 收 `QueryRunner`(Pool | 事务 client)而非 Pool:平台凭据的写审计按注册表是 **mode='tx'**
 * (fail-closed:审计写不下 → provision 也不许成功),admin 层必须能把事务 client 传进来。
 */
export async function upsertPlatformOauthApp(
  input: UpsertPlatformOauthAppInput,
  runner: QueryRunner = getPool(),
): Promise<void> {
  const slug = assertSlug(input.slug)
  const clientId = assertCredential(input.clientId, 'clientId', MAX_CLIENT_ID_LEN)
  const clientSecret = assertCredential(input.clientSecret, 'clientSecret', MAX_CLIENT_SECRET_LEN)
  const aadSeed = randomUUID()

  const key = loadKmsKey()
  const plaintext = Buffer.from(clientSecret, 'utf8')
  let enc: ReturnType<typeof encrypt>
  try {
    enc = encrypt(plaintext, key, platformOauthAppAad(aadSeed, slug))
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(key)
  }

  await runner.query(
    `INSERT INTO connector_platform_oauth_apps
       (slug, client_id, client_secret_enc, client_secret_nonce, aad_seed, created_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5::uuid, now(), now(), $6)
     ON CONFLICT (slug) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       client_secret_enc = EXCLUDED.client_secret_enc,
       client_secret_nonce = EXCLUDED.client_secret_nonce,
       aad_seed = EXCLUDED.aad_seed,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [
      slug,
      clientId,
      enc.ciphertext,
      enc.nonce,
      aadSeed,
      input.updatedBy === undefined || input.updatedBy === null ? null : String(input.updatedBy),
    ],
  )
}

interface AppRow {
  client_id: string
  client_secret_enc: Buffer
  client_secret_nonce: Buffer
  aad_seed: string
}

/**
 * 取平台 App 的完整凭据(**含 secret**)。**唯一合法调用方 = oauth 回调的 token 交换**
 * (completeDeclarativeOauth):secret 从这里出来,直接进发往 token origin 的交换请求,用完即弃。
 * 未 provision → null(调用方 fail-closed)。
 *
 * 注:oauth/start 只需要公开的 client_id,请用 `getPlatformOauthAppClientId`(不解密 secret,
 * 最小暴露面)—— 别为了图省事在 start 里调本函数。
 */
export async function getPlatformOauthApp(
  slug: string,
  runner: QueryRunner = getPool(),
): Promise<PlatformOauthApp | null> {
  const s = assertSlug(slug)
  const r = await runner.query<AppRow>(
    `SELECT client_id, client_secret_enc, client_secret_nonce, aad_seed::text AS aad_seed
       FROM connector_platform_oauth_apps WHERE slug = $1`,
    [s],
  )
  const row = r.rows[0]
  if (!row) return null

  const key = loadKmsKey()
  let pt: Buffer | null = null
  try {
    pt = decryptToBuffer(
      row.client_secret_enc,
      row.client_secret_nonce,
      key,
      platformOauthAppAad(row.aad_seed, s),
    )
    return { clientId: row.client_id, clientSecret: pt.toString('utf8') }
  } finally {
    zeroBuffer(key)
    if (pt) zeroBuffer(pt)
  }
}

/**
 * 只取公开的 client_id(**不解密 secret**)。authorize URL 只需要 client_id,把 secret 明文
 * 从 start 路径上彻底拿掉 —— 最小暴露面。未 provision → null(= fail-closed 判据)。
 */
export async function getPlatformOauthAppClientId(
  slug: string,
  runner: QueryRunner = getPool(),
): Promise<string | null> {
  const s = assertSlug(slug)
  const r = await runner.query<{ client_id: string }>(
    'SELECT client_id FROM connector_platform_oauth_apps WHERE slug = $1',
    [s],
  )
  return r.rows[0]?.client_id ?? null
}

/** admin 列表:**永不返回 secret**(投影里结构上就没有这一列)。 */
export async function listPlatformOauthApps(
  runner: QueryRunner = getPool(),
): Promise<PlatformOauthAppSummary[]> {
  const r = await runner.query<{ slug: string; client_id: string; updated_at: Date }>(
    `SELECT slug, client_id, updated_at
       FROM connector_platform_oauth_apps ORDER BY slug`,
  )
  return r.rows.map((row) => ({
    slug: row.slug,
    clientId: row.client_id,
    updatedAt: row.updated_at,
  }))
}

/**
 * 已 provision 的 slug 集合(**一次查询**)。catalog 过滤用:避免"每个 platform 条目查一次"
 * 的 N+1(见 engine/catalog.ts)。不解密任何东西。
 */
export async function listPlatformOauthAppSlugs(
  runner: QueryRunner = getPool(),
): Promise<Set<string>> {
  const r = await runner.query<{ slug: string }>('SELECT slug FROM connector_platform_oauth_apps')
  return new Set(r.rows.map((row) => row.slug))
}

/**
 * 删除(反 provision)。返回是否真删掉了一行(用于 admin 404 判定)。
 * 同 upsert:收 QueryRunner,让删除与其 tx 审计同事务(审计写不下 → 不许删)。
 *
 * 注:删除**不级联**任何已绑用户连接 —— 那些连接袋里只有 access_token,删平台 app 不影响它们
 * 继续用(直到 token 过期);影响的是"新用户还能不能授权"(catalog 立刻不再展示该连接器)。
 */
export async function deletePlatformOauthApp(
  slug: string,
  runner: QueryRunner = getPool(),
): Promise<boolean> {
  const s = assertSlug(slug)
  const r = await runner.query('DELETE FROM connector_platform_oauth_apps WHERE slug = $1', [s])
  return (r.rowCount ?? 0) > 0
}

/** 是否已 provision(不解密;单条判定用,批量过滤请用 listPlatformOauthAppSlugs)。 */
export async function hasPlatformOauthApp(
  slug: string,
  runner: QueryRunner = getPool(),
): Promise<boolean> {
  const s = assertSlug(slug)
  const r = await runner.query('SELECT 1 FROM connector_platform_oauth_apps WHERE slug = $1', [s])
  return (r.rowCount ?? 0) > 0
}
