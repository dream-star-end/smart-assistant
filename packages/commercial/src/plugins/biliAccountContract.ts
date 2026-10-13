/**
 * Version-controlled official Bilibili account Plugin artifact and trust pins (OCV5-402).
 *
 * 只读：字幕、收藏夹、观看历史这些要登录才能看的数据。公开数据（搜索 / 详情 / 排行 / 评论 / 弹幕）在
 * declarative-http 连接器 `bili`（connectors/official/bili.ts）。只上 AI 市场、不预装。
 * 接口清单改写自 dream-star-end/agent-plugins `bili/`（MIT，见 connectors/official/THIRD_PARTY_NOTICES.md）。
 */

import { createHash } from 'node:crypto'

import { BILI_ACCOUNT_WORKER_SOURCE } from './biliAccountWorkerSource.js'
import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'

export const BILI_ACCOUNT_PLUGIN_SLUG = 'bili-account'
export const BILI_ACCOUNT_PLUGIN_VERSION = '1.0.0'
export const BILI_ACCOUNT_WORKER_DIGEST = createHash('sha256')
  .update(BILI_ACCOUNT_WORKER_SOURCE)
  .digest('hex')
export const BILI_ACCOUNT_DRIVER_ID = `bili-account-${BILI_ACCOUNT_WORKER_DIGEST.slice(0, 51)}`
export const BILI_ACCOUNT_DRIVER_VERSION = BILI_ACCOUNT_PLUGIN_VERSION
export const BILI_ACCOUNT_LAUNCHER_ID = `bili-account-container-${BILI_ACCOUNT_WORKER_DIGEST.slice(0, 41)}`
export const BILI_ACCOUNT_LAUNCHER_VERSION = BILI_ACCOUNT_PLUGIN_VERSION

const bvidSchema = { type: 'string', minLength: 12, maxLength: 12, pattern: '^[A-Za-z0-9]{12,12}$' }
const title = { type: 'string', maxLength: 300 }
const url = { type: 'string', maxLength: 512 }
const count = { type: 'integer', minimum: 0 }

const videoItemSchema = {
  type: 'object',
  properties: {
    bvid: bvidSchema,
    title,
    cover: url,
    author: { type: 'string', maxLength: 128 },
    play: count,
    danmaku: count,
    durationSec: count,
    /** 观看历史：看到第几秒（-1 = 已看完）。 */
    progressSec: { type: 'integer', minimum: -1 },
    /** Unix 秒：收藏时间 / 观看时间。 */
    favAt: count,
    viewedAt: count,
    url,
  },
  required: ['title', 'url'],
  additionalProperties: false,
}

export const BILI_ACCOUNT_NETWORK_ORIGINS = Object.freeze([
  'https://www.bilibili.com',
  'https://api.bilibili.com',
  'https://aisubtitle.hdslb.com',
  'https://i0.hdslb.com',
])

export const BILI_ACCOUNT_PLUGIN_ARTIFACT = Object.freeze({
  schemaVersion: 1,
  pluginType: 'managed-browser',
  id: BILI_ACCOUNT_PLUGIN_SLUG,
  version: BILI_ACCOUNT_PLUGIN_VERSION,
  driver: { id: BILI_ACCOUNT_DRIVER_ID, version: BILI_ACCOUNT_DRIVER_VERSION },
  account: { mode: 'required', contractVersion: 1 },
  accountState: {
    cookieDomains: ['bilibili.com', 'www.bilibili.com', 'passport.bilibili.com'],
    origins: ['https://www.bilibili.com'],
  },
  network: { origins: BILI_ACCOUNT_NETWORK_ORIGINS, methods: ['GET'] },
  actions: [
    {
      id: 'me',
      description: '读取当前登录的 B 站账号：mid、昵称、等级、是否大会员。',
      effect: 'read',
      timeoutSeconds: 90,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          mid: count,
          uname: { type: 'string', maxLength: 128 },
          level: count,
          vip: { type: 'boolean' },
        },
        required: ['mid', 'uname'],
        additionalProperties: false,
      },
    },
    {
      id: 'favorite_folders',
      description:
        '列出当前账号创建的收藏夹：id、标题、视频数。查收藏夹里的视频用 favorite_items（参数 folderId）。',
      effect: 'read',
      timeoutSeconds: 90,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          folders: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              properties: { id: count, title, count },
              required: ['id', 'title'],
              additionalProperties: false,
            },
          },
        },
        required: ['folders'],
        additionalProperties: false,
      },
    },
    {
      id: 'favorite_items',
      description:
        '读取某个收藏夹里的视频。参数：folderId（必填，来自 favorite_folders）、page（默认 1）、pageSize（1-20，默认 20）。' +
        '结果 items[]：bvid、title、cover、author、play、durationSec、favAt（Unix 秒）、url；hasMore 表示还有下一页。',
      effect: 'read',
      timeoutSeconds: 90,
      params: {
        type: 'object',
        properties: {
          folderId: { type: 'integer', minimum: 1 },
          page: { type: 'integer', minimum: 1, maximum: 50 },
          pageSize: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['folderId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          title,
          total: count,
          hasMore: { type: 'boolean' },
          items: { type: 'array', maxItems: 20, items: videoItemSchema },
        },
        required: ['items', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'history',
      description:
        '读取观看历史（最近在前）。参数：pageSize（1-30，默认 20）。' +
        '结果 items[]：bvid、title、cover、author、durationSec、progressSec（-1 = 已看完）、viewedAt（Unix 秒）、url。只含视频，不含直播和专栏。',
      effect: 'read',
      timeoutSeconds: 90,
      params: {
        type: 'object',
        properties: { pageSize: { type: 'integer', minimum: 1, maximum: 30 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { items: { type: 'array', maxItems: 30, items: videoItemSchema } },
        required: ['items'],
        additionalProperties: false,
      },
    },
    {
      id: 'subtitle',
      description:
        '读取视频字幕（含 AI 字幕，登录后才有）。参数：bvid（必填）、page（分 P 序号，默认 1）、lang（可选，如 zh-CN / ai-zh，不填取第一条）。' +
        '结果：lang、available[]（可选语言）、lines[]{from,to,text}（秒，最多 600 行）、truncated。视频没有字幕时 lines 为空并 available 为空。',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          bvid: bvidSchema,
          page: { type: 'integer', minimum: 1, maximum: 500 },
          lang: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[A-Za-z0-9-]{1,16}$' },
        },
        required: ['bvid'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          bvid: bvidSchema,
          cid: count,
          lang: { type: 'string', maxLength: 32 },
          available: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                lang: { type: 'string', maxLength: 32 },
                label: { type: 'string', maxLength: 64 },
              },
              required: ['lang'],
              additionalProperties: false,
            },
          },
          lines: {
            type: 'array',
            maxItems: 600,
            items: {
              type: 'object',
              properties: {
                from: { type: 'number', minimum: 0 },
                to: { type: 'number', minimum: 0 },
                text: { type: 'string', maxLength: 300 },
              },
              required: ['from', 'text'],
              additionalProperties: false,
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['bvid', 'available', 'lines', 'truncated'],
        additionalProperties: false,
      },
    },
  ],
} as const)

export const COMPILED_BILI_ACCOUNT_PLUGIN = compileRuntimePluginArtifact(
  BILI_ACCOUNT_PLUGIN_ARTIFACT,
)
if (COMPILED_BILI_ACCOUNT_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Bilibili account Plugin contract subtype mismatch')

/** 新插件，没有历史版本可兼容。 */
export function classifyBiliAccountSetupPin(input: {
  version: string
  artifactHash: string
  execContractHash: string
}): 'current' | 'compatible-predecessor' | null {
  return input.version === BILI_ACCOUNT_PLUGIN_VERSION &&
    input.artifactHash === COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_BILI_ACCOUNT_PLUGIN.execContractHash
    ? 'current'
    : null
}

export function isOfficialBiliAccountPluginIdentity(input: {
  slug: string
  pluginType: string | null
  artifactHash: string
  execContractHash: string | null
  reviewSource: string | null
}): boolean {
  return (
    input.slug === BILI_ACCOUNT_PLUGIN_SLUG &&
    input.pluginType === 'managed-browser' &&
    input.artifactHash === COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_BILI_ACCOUNT_PLUGIN.execContractHash &&
    input.reviewSource === 'platform'
  )
}

export const BILI_ACCOUNT_PLUGIN_CONTRACT: ManagedBrowserPluginContractV1 =
  COMPILED_BILI_ACCOUNT_PLUGIN.execContract

/** 扫码登录页需要的来源（只在登录 worker 里放行）。数据上报与第三方指纹域名不放行。 */
export const BILI_ACCOUNT_LOGIN_ORIGINS = Object.freeze([
  'https://passport.bilibili.com:443',
  'https://www.bilibili.com:443',
  'https://api.bilibili.com:443',
  'https://s1.hdslb.com:443',
  'https://i0.hdslb.com:443',
])
