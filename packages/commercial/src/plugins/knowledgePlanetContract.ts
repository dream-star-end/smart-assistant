/** Version-controlled official Knowledge Planet Plugin artifact and trust pins. */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { KNOWLEDGE_PLANET_WORKER_SOURCE } from './knowledgePlanetWorkerSource.js'

export const KNOWLEDGE_PLANET_PLUGIN_SLUG = 'knowledge-planet'
export const KNOWLEDGE_PLANET_PLUGIN_VERSION = '1.0.0'
/**
 * The implementation digest is part of both registry IDs, so changing trusted
 * worker code necessarily changes the marketplace artifact hash. Reusing the
 * same Plugin version then fails closed and forces an explicit version bump and
 * exact-image smoke instead of silently swapping code behind an approved driver.
 */
export const KNOWLEDGE_PLANET_WORKER_DIGEST = createHash('sha256')
  .update(KNOWLEDGE_PLANET_WORKER_SOURCE)
  .digest('hex')
export const KNOWLEDGE_PLANET_DRIVER_ID = `kp-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 60)}`
export const KNOWLEDGE_PLANET_DRIVER_VERSION = '1.0.0'
export const KNOWLEDGE_PLANET_LAUNCHER_ID = `kp-container-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 50)}`
export const KNOWLEDGE_PLANET_LAUNCHER_VERSION = '1.0.0'

const authorSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    name: { type: 'string', maxLength: 128 },
  },
  additionalProperties: false,
}

const topicSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    type: { type: 'string', maxLength: 32 },
    createdAt: { type: 'string', maxLength: 64 },
    text: { type: 'string', maxLength: 12_000 },
    author: authorSchema,
    commentCount: { type: 'integer', minimum: 0 },
    likeCount: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

export const KNOWLEDGE_PLANET_PLUGIN_ARTIFACT = Object.freeze({
  schemaVersion: 1,
  pluginType: 'managed-browser',
  id: KNOWLEDGE_PLANET_PLUGIN_SLUG,
  version: KNOWLEDGE_PLANET_PLUGIN_VERSION,
  driver: { id: KNOWLEDGE_PLANET_DRIVER_ID, version: KNOWLEDGE_PLANET_DRIVER_VERSION },
  account: { mode: 'required', contractVersion: 1 },
  accountState: {
    cookieDomains: ['api.zsxq.com', 'wx.zsxq.com', 'zsxq.com'],
    origins: ['https://api.zsxq.com', 'https://wx.zsxq.com'],
  },
  network: { origins: ['https://api.zsxq.com'], methods: ['GET'] },
  actions: [
    {
      id: 'list_groups',
      description: '列出当前账号已加入的知识星球',
      effect: 'read',
      timeoutSeconds: 30,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 32 },
                name: { type: 'string', maxLength: 256 },
                description: { type: 'string', maxLength: 4_000 },
                memberCount: { type: 'integer', minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['groups'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_topics',
      description: '读取指定知识星球的主题列表',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: { type: 'string', minLength: 6, maxLength: 32 },
          count: { type: 'integer', minimum: 1, maximum: 50 },
          endTime: { type: 'string', maxLength: 80 },
        },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          topics: { type: 'array', maxItems: 50, items: topicSchema },
        },
        required: ['topics'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_comments',
      description: '读取指定主题的评论列表',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          topicId: { type: 'string', minLength: 6, maxLength: 32 },
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['topicId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          comments: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 32 },
                createdAt: { type: 'string', maxLength: 64 },
                text: { type: 'string', maxLength: 5_000 },
                author: authorSchema,
              },
              additionalProperties: false,
            },
          },
        },
        required: ['comments'],
        additionalProperties: false,
      },
    },
    {
      id: 'search_topics',
      description: '在指定知识星球内搜索主题',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: { type: 'string', minLength: 6, maxLength: 32 },
          keyword: { type: 'string', minLength: 1, maxLength: 100 },
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['groupId', 'keyword'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          topics: { type: 'array', maxItems: 50, items: topicSchema },
        },
        required: ['topics'],
        additionalProperties: false,
      },
    },
  ],
} as const)

export const COMPILED_KNOWLEDGE_PLANET_PLUGIN = compileRuntimePluginArtifact(
  KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
)

if (COMPILED_KNOWLEDGE_PLANET_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Knowledge Planet Plugin contract subtype mismatch')

/**
 * Single authority for the public "official" badge. Matching the public artifact
 * bytes is not enough: the row must have gone through the platform seed review
 * path and the signature-verified executable contract must match the pinned
 * version-controlled contract as well.
 */
export function isOfficialKnowledgePlanetPluginIdentity(input: {
  slug: string
  pluginType: string | null
  artifactHash: string
  execContractHash: string | null
  reviewSource: string | null
}): boolean {
  return (
    input.slug === KNOWLEDGE_PLANET_PLUGIN_SLUG &&
    input.pluginType === 'managed-browser' &&
    input.artifactHash === COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash &&
    input.reviewSource === 'platform'
  )
}

export const KNOWLEDGE_PLANET_PLUGIN_CONTRACT: ManagedBrowserPluginContractV1 =
  COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContract

export const KNOWLEDGE_PLANET_LOGIN_ORIGINS = Object.freeze([
  'https://api.zsxq.com:443',
  'https://lp.open.weixin.qq.com:443',
  'https://open.weixin.qq.com:443',
  'https://res.wx.qq.com:443',
  'https://support.weixin.qq.com:443',
  'https://wx.zsxq.com:443',
])
