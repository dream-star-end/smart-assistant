/**
 * Version-controlled official Douyin Plugin artifact and trust pins (OCV5-553).
 *
 * 个人抖音号扫码登录（抖音创作者服务平台 creator.douyin.com 的官方二维码）。本版只有一个读动作
 * `me`，用来确认登录身份；作品、评论、搜索等读动作和发布 / 评论 / 点赞等写动作在后续版本加入
 * （设计见 ocv5-308/DESIGN-20261021-douyin-plugin.md 4.8）。只上 AI 市场、不预装。
 *
 * 登录页来源、二维码元素和未登录时的接口应答来自 2026-10-21 的未登录侦察（g553-recon-*.json）；
 * 登录后的应答形状、登录 cookie 是否带 Secure，要等测试号扫码后才能核实。
 */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { DOUYIN_WORKER_SOURCE } from './douyinWorkerSource.js'

export const DOUYIN_PLUGIN_SLUG = 'douyin'
export const DOUYIN_PLUGIN_VERSION = '1.0.0'
export const DOUYIN_WORKER_DIGEST = createHash('sha256').update(DOUYIN_WORKER_SOURCE).digest('hex')
export const DOUYIN_DRIVER_ID = `douyin-${DOUYIN_WORKER_DIGEST.slice(0, 51)}`
export const DOUYIN_DRIVER_VERSION = DOUYIN_PLUGIN_VERSION
export const DOUYIN_LAUNCHER_ID = `douyin-container-${DOUYIN_WORKER_DIGEST.slice(0, 41)}`
export const DOUYIN_LAUNCHER_VERSION = DOUYIN_PLUGIN_VERSION

const count = { type: 'integer', minimum: 0 }

export const DOUYIN_NETWORK_ORIGINS = Object.freeze(['https://creator.douyin.com'])

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
