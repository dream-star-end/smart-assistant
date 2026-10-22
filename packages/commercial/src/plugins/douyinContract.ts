/**
 * Version-controlled official Douyin Plugin artifact and trust pins (OCV5-553).
 *
 * 个人抖音号扫码登录（抖音创作者服务平台 creator.douyin.com 的官方二维码，扫码后本人短信验证）。
 * 读动作：`me`（登录身份）、`my_videos`（自己的作品，creator work_list，2026-10-22 实测格式）、
 * `video_comments`（自己作品的评论，creator comment/list —— 接口由前端脚本静态分析确定、登录后应答
 * 形状未实测，上架前的 seed 实测必须跑通）。搜索和他人内容不做（需要 www 站签名，设计 4.3.C）。只上 AI 市场、不预装。
 *
 * 写动作（1.1.0，设计 4.4 / 4.8 PR4）：发布视频、发布图文、在自己作品下评论、回复自己作品下的评论、
 * 给自己作品下的评论点赞 / 取消点赞。全部走确认账本逐次确认（没有「免逐次确认」），并受每日上限、
 * 同账号写间隔和风控冷却约束。评论 / 回复 / 点赞只针对自己的作品：服务端用 my_videos / video_comments
 * 读出目标做快照，worker 发出前再核对一次。这一版 worker 在派发围栏之前停下（DOUYIN_WRITE_UNVERIFIED，
 * 确定未发出）：上游写接口要等测试号实测确定后再接入（不登录就无法实测）。
 *
 * 登录页来源、二维码元素和未登录时的接口应答来自 2026-10-21 的未登录侦察（g553-recon-*.json）；
 * 登录后的应答形状、登录 cookie 是否带 Secure，要等测试号扫码后才能核实。
 */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { DOUYIN_WORKER_SOURCE } from './douyinWorkerSource.js'

export const DOUYIN_PLUGIN_SLUG = 'douyin'
export const DOUYIN_PLUGIN_VERSION = '1.1.0'
export const DOUYIN_WORKER_DIGEST = createHash('sha256').update(DOUYIN_WORKER_SOURCE).digest('hex')
export const DOUYIN_DRIVER_ID = `douyin-${DOUYIN_WORKER_DIGEST.slice(0, 51)}`
export const DOUYIN_DRIVER_VERSION = DOUYIN_PLUGIN_VERSION
export const DOUYIN_LAUNCHER_ID = `douyin-container-${DOUYIN_WORKER_DIGEST.slice(0, 41)}`
export const DOUYIN_LAUNCHER_VERSION = DOUYIN_PLUGIN_VERSION

const count = { type: 'integer', minimum: 0 }
const awemeIdSchema = { type: 'string', minLength: 1, maxLength: 32, pattern: '^[0-9]{1,32}$' }
const videoItemSchema = {
  type: 'object',
  properties: {
    awemeId: awemeIdSchema,
    title: { type: 'string', maxLength: 200 },
    desc: { type: 'string', maxLength: 1000 },
    createTime: count,
    durationSec: count,
    // 抖音图床的签名地址很长（实测约 320 字符）；worker 只接受 https://*.douyinpic.com。
    cover: { type: 'string', maxLength: 1024 },
    playCount: count,
    diggCount: count,
    commentCount: count,
    shareCount: count,
    collectCount: count,
    isPrivate: { type: 'boolean' },
    inReview: { type: 'boolean' },
    isImagePost: { type: 'boolean' },
    url: { type: 'string', maxLength: 256 },
  },
  required: ['awemeId', 'url'],
  additionalProperties: false,
}

export const DOUYIN_NETWORK_ORIGINS = Object.freeze(['https://creator.douyin.com'])

/** 媒体路径与微博、知乎相同：由 sealKnowledgePlanetMedia 按工作区规则解析，只认 uploads / generated。 */
const mediaPathSchema = { type: 'string', minLength: 1, maxLength: 512 }
/** 文案：话题（#）和 @ 直接写在正文里，抖音按原文发布。 */
const captionSchema = { type: 'string', maxLength: 1000 }
const titleSchema = { type: 'string', maxLength: 30 }
const visibilitySchema = { type: 'string', enum: ['public', 'friends', 'private'] }
const cidSchema = { type: 'string', minLength: 1, maxLength: 32, pattern: '^[0-9]{1,32}$' }
const digestSchema = { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]{64,64}$' }
const commentTextSchema = { type: 'string', minLength: 1, maxLength: 500 }
/** 服务端封装的媒体清单（Agent 不能自传：proposeWrite 拒绝带这个字段的参数）。视频 ≤50MB（媒体通用上限）。 */
const sealedMediaSchema = (kind: 'image' | 'file', mimeTypes: readonly string[]) => ({
  type: 'object',
  properties: {
    path: mediaPathSchema,
    inputId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]{1,64}$' },
    filename: { type: 'string', minLength: 1, maxLength: 512 },
    sizeBytes: { type: 'integer', minimum: 1, maximum: 50 * 1024 * 1024 },
    sha256: digestSchema,
    mimeType: { type: 'string', enum: mimeTypes },
    kind: { type: 'string', enum: [kind] },
  },
  required: ['path', 'inputId', 'filename', 'sizeBytes', 'sha256', 'mimeType', 'kind'],
  additionalProperties: false,
})
export const DOUYIN_IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])
const videoManifestSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 1,
  items: sealedMediaSchema('file', ['video/mp4']),
}
const imageManifestSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  items: sealedMediaSchema('image', DOUYIN_IMAGE_MIME_TYPES),
}
/** 服务端读出的目标快照（自己作品 / 自己作品下的评论）；worker 发出前逐字段核对。 */
const videoSnapshotSchema = {
  type: 'object',
  properties: { awemeId: awemeIdSchema, digest: digestSchema },
  required: ['awemeId', 'digest'],
  additionalProperties: false,
}
const commentSnapshotSchema = {
  type: 'object',
  properties: { awemeId: awemeIdSchema, cid: cidSchema, digest: digestSchema },
  required: ['awemeId', 'cid', 'digest'],
  additionalProperties: false,
}
const writeResultSchema = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['published', 'in_review', 'commented', 'replied', 'digg_set'],
    },
    awemeId: awemeIdSchema,
    cid: cidSchema,
    digg: { type: 'boolean' },
    url: { type: 'string', maxLength: 256 },
  },
  required: ['status'],
  additionalProperties: false,
}

export const DOUYIN_PLUGIN_ARTIFACT = Object.freeze({
  schemaVersion: 1,
  pluginType: 'managed-browser',
  id: DOUYIN_PLUGIN_SLUG,
  version: DOUYIN_PLUGIN_VERSION,
  driver: { id: DOUYIN_DRIVER_ID, version: DOUYIN_DRIVER_VERSION },
  account: { mode: 'required', contractVersion: 1 },
  accountState: {
    // 登录 cookie（sessionid / sid_guard / ttwid 等）落在 .douyin.com；创作者平台自己的在 creator.douyin.com。
    cookieDomains: ['douyin.com', 'creator.douyin.com'],
    origins: ['https://creator.douyin.com'],
  },
  // 这一版的写动作在派发围栏之前停下，不发任何写请求，所以方法仍只有 GET。
  network: { origins: DOUYIN_NETWORK_ORIGINS, methods: ['GET'] },
  actions: [
    {
      id: 'me',
      description:
        '读取当前登录的抖音账号：昵称、uid、secUid，以及粉丝数、关注数、作品数、获赞数（抖音返回时才有）。' +
        '也可用来检查登录是否仍有效：失效时返回需要重新扫码的错误。',
      effect: 'read',
      timeoutSeconds: 90,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          nickname: { type: 'string', maxLength: 128 },
          uid: { type: 'string', maxLength: 32, pattern: '^[0-9]{1,32}$' },
          // 平台 schema 的 pattern 不允许下划线；格式（[A-Za-z0-9_-]{1,128}）由 worker 校验后才返回。
          secUid: { type: 'string', minLength: 1, maxLength: 128 },
          followerCount: count,
          followingCount: count,
          awemeCount: count,
          totalFavorited: count,
        },
        required: ['nickname'],
        additionalProperties: false,
      },
    },
    {
      id: 'my_videos',
      description:
        '列出当前账号自己发布的作品（最新在前）。参数：count（1-20，默认 10）、cursor（翻页游标，用上一页结果里的 cursor）。' +
        '结果 items[]：awemeId、title、desc、createTime（Unix 秒）、durationSec、cover、播放 / 点赞 / 评论 / 分享 / 收藏数、isPrivate、inReview、url；hasMore 表示还有下一页。',
      effect: 'read',
      timeoutSeconds: 90,
      params: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 20 },
          cursor: { type: 'integer', minimum: 0, maximum: 9_000_000_000_000 },
        },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          items: { type: 'array', maxItems: 20, items: videoItemSchema },
          hasMore: { type: 'boolean' },
          cursor: { type: 'integer', minimum: 0 },
          total: count,
        },
        required: ['items', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'video_comments',
      description:
        '读取自己某个作品下的评论（只能读自己的作品）。参数：awemeId（必填，来自 my_videos）、count（1-20，默认 10）、cursor（翻页游标）。' +
        '结果 items[]：cid、text、nickname、createTime（Unix 秒）、diggCount、replyCount；hasMore 表示还有下一页。',
      effect: 'read',
      timeoutSeconds: 90,
      params: {
        type: 'object',
        properties: {
          awemeId: awemeIdSchema,
          count: { type: 'integer', minimum: 1, maximum: 20 },
          cursor: { type: 'integer', minimum: 0, maximum: 9_000_000_000_000 },
        },
        required: ['awemeId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          awemeId: awemeIdSchema,
          items: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                cid: { type: 'string', maxLength: 32, pattern: '^[0-9]{1,32}$' },
                text: { type: 'string', maxLength: 1000 },
                nickname: { type: 'string', maxLength: 128 },
                createTime: count,
                diggCount: count,
                replyCount: count,
              },
              required: ['cid', 'text'],
              additionalProperties: false,
            },
          },
          hasMore: { type: 'boolean' },
          cursor: { type: 'integer', minimum: 0 },
          total: count,
        },
        required: ['awemeId', 'items', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'publish_video',
      description:
        '用当前账号发布一条视频（写操作：每次都要用户在确认卡上批准，每天最多 3 条，两次发布至少间隔约 10 分钟）。' +
        '参数：video（必填，uploads/ 或 generated/ 下的 mp4 文件，≤50MB）、caption（文案，话题 # 和 @ 写在正文里，≤1000 字）、' +
        'title（可选，≤30 字）、visibility（public 公开 / friends 好友可见 / private 仅自己，默认 public）。',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          video: mediaPathSchema,
          caption: captionSchema,
          title: titleSchema,
          visibility: visibilitySchema,
          mediaManifest: videoManifestSchema,
        },
        required: ['video'],
        additionalProperties: false,
      },
      result: writeResultSchema,
    },
    {
      id: 'publish_images',
      description:
        '用当前账号发布一条图文（写操作：每次都要用户批准，每天最多 3 条，两次发布至少间隔约 10 分钟）。' +
        '参数：images（必填，1-20 张 uploads/ 或 generated/ 下的 jpg / png / webp）、caption、title、visibility（同 publish_video）。',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          images: { type: 'array', minItems: 1, maxItems: 20, items: mediaPathSchema },
          caption: captionSchema,
          title: titleSchema,
          visibility: visibilitySchema,
          mediaManifest: imageManifestSchema,
        },
        required: ['images'],
        additionalProperties: false,
      },
      result: writeResultSchema,
    },
    {
      id: 'create_comment',
      description:
        '在自己的某个作品下发表一条评论（写操作：每次都要用户批准；评论与回复合计每天最多 20 条，同账号两次至少间隔约 1 分钟）。' +
        '参数：awemeId（必填，来自 my_videos）、text（1-500 字）。',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          awemeId: awemeIdSchema,
          text: commentTextSchema,
          snapshot: videoSnapshotSchema,
        },
        required: ['awemeId', 'text'],
        additionalProperties: false,
      },
      result: writeResultSchema,
    },
    {
      id: 'reply_comment',
      description:
        '回复自己作品下的一条评论（写操作：每次都要用户批准；与评论合计每天最多 20 条，间隔约 1 分钟）。' +
        '参数：awemeId、cid（来自 video_comments）、text（1-500 字）。',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          awemeId: awemeIdSchema,
          cid: cidSchema,
          text: commentTextSchema,
          snapshot: commentSnapshotSchema,
        },
        required: ['awemeId', 'cid', 'text'],
        additionalProperties: false,
      },
      result: writeResultSchema,
    },
    {
      id: 'set_comment_digg',
      description:
        '给自己作品下的一条评论点赞（digg=true）或取消点赞（digg=false）（写操作：每次都要用户批准；每天合计最多 30 次，间隔约 20 秒）。' +
        '参数：awemeId、cid、digg。',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          awemeId: awemeIdSchema,
          cid: cidSchema,
          digg: { type: 'boolean' },
          snapshot: commentSnapshotSchema,
        },
        required: ['awemeId', 'cid', 'digg'],
        additionalProperties: false,
      },
      result: writeResultSchema,
    },
  ],
} as const)

export const COMPILED_DOUYIN_PLUGIN = compileRuntimePluginArtifact(DOUYIN_PLUGIN_ARTIFACT)
if (COMPILED_DOUYIN_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Douyin Plugin contract subtype mismatch')

/** 新插件，没有历史版本可兼容。 */
export function classifyDouyinSetupPin(input: {
  version: string
  artifactHash: string
  execContractHash: string
}): 'current' | 'compatible-predecessor' | null {
  return input.version === DOUYIN_PLUGIN_VERSION &&
    input.artifactHash === COMPILED_DOUYIN_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_DOUYIN_PLUGIN.execContractHash
    ? 'current'
    : null
}

export function isOfficialDouyinPluginIdentity(input: {
  slug: string
  pluginType: string | null
  artifactHash: string
  execContractHash: string | null
  reviewSource: string | null
}): boolean {
  return (
    input.slug === DOUYIN_PLUGIN_SLUG &&
    input.pluginType === 'managed-browser' &&
    input.artifactHash === COMPILED_DOUYIN_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_DOUYIN_PLUGIN.execContractHash &&
    input.reviewSource === 'platform'
  )
}

export const DOUYIN_PLUGIN_CONTRACT: ManagedBrowserPluginContractV1 =
  COMPILED_DOUYIN_PLUGIN.execContract

/**
 * 扫码登录页需要的来源（只在登录 worker 里放行）。2026-10-21 未登录侦察：只放行下列来源时官方二维码
 * 照常出现；监控与数据上报（mon.zijieapi.com、mcs.snssdk.com、security.zijieapi.com 的 metrics、
 * vcs.zijieapi.com、lf3-short.ibytedapm.com）不放行。mssdk.bytedance.com 与 rmc-nocaptcha
 * 是登录前的无感风控脚本，拦掉会让登录组件拿不到二维码，所以放行；系统不处理也不绕过任何可见验证。
 * sso.douyin.com 是字节账号体系的跨域登录同步，侦察时未登录所以没出现，扫码后可能用到。
 */
export const DOUYIN_LOGIN_ORIGINS = Object.freeze([
  'https://creator.douyin.com:443',
  'https://sso.douyin.com:443',
  'https://lf-fe-creator.douyinstatic.com:443',
  'https://lf-ucenter-web.yhgfb-cn-static.com:443',
  'https://lf-rc1.yhgfb-cn-static.com:443',
  'https://lf-cdn-tos.bytescm.com:443',
  'https://lf-security.bytegoofy.com:443',
  'https://lf1-cdn-tos.bytegoofy.com:443',
  'https://lf-c-flwb.bytetos.com:443',
  'https://lf3-static.bytednsdoc.com:443',
  'https://lf3-config.bytetcc.com:443',
  'https://lf-zt.douyin.com:443',
  'https://unpkg.byted-static.com:443',
  'https://auth.zijieapi.com:443',
  'https://ttwid.bytedance.com:443',
  'https://mssdk.bytedance.com:443',
])
