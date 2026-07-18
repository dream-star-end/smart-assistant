/** Version-controlled official Knowledge Planet Plugin artifact and trust pins. */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { KNOWLEDGE_PLANET_WORKER_SOURCE } from './knowledgePlanetWorkerSource.js'

export const KNOWLEDGE_PLANET_PLUGIN_SLUG = 'knowledge-planet'
export const KNOWLEDGE_PLANET_PLUGIN_VERSION = '1.4.0'
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
export const KNOWLEDGE_PLANET_DRIVER_VERSION = '1.4.0'
export const KNOWLEDGE_PLANET_LAUNCHER_ID = `kp-container-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 50)}`
export const KNOWLEDGE_PLANET_LAUNCHER_VERSION = '1.4.0'

const authorSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    name: { type: 'string', maxLength: 128 },
  },
  additionalProperties: false,
}

const imageSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    type: { type: 'string', maxLength: 64 },
    width: { type: 'integer', minimum: 0 },
    height: { type: 'integer', minimum: 0 },
    size: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

const sha256Schema = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[0-9a-f]{64,64}$',
}

const mediaPathSchema = { type: 'string', minLength: 1, maxLength: 512 }

/** Server-sealed metadata. Agent input may omit it and may never author it. */
const sealedMediaSchema = {
  type: 'object',
  properties: {
    path: mediaPathSchema,
    inputId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]{1,64}$' },
    filename: { type: 'string', minLength: 1, maxLength: 512 },
    sizeBytes: { type: 'integer', minimum: 1, maximum: 50 * 1024 * 1024 },
    sha256: sha256Schema,
    mimeType: { type: 'string', minLength: 1, maxLength: 128 },
    kind: { type: 'string', enum: ['image', 'file'] },
  },
  required: ['path', 'inputId', 'filename', 'sizeBytes', 'sha256', 'mimeType', 'kind'],
  additionalProperties: false,
}

const fileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    name: { type: 'string', maxLength: 512 },
    type: { type: 'string', maxLength: 128 },
    size: { type: 'integer', minimum: 0 },
    duration: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

const articleSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    title: { type: 'string', maxLength: 512 },
    summary: { type: 'string', maxLength: 4_000 },
  },
  additionalProperties: false,
}

const topicSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    type: { type: 'string', maxLength: 32 },
    createdAt: { type: 'string', maxLength: 64 },
    groupId: { type: 'string', maxLength: 32 },
    title: { type: 'string', maxLength: 512 },
    text: { type: 'string', maxLength: 12_000 },
    question: { type: 'string', maxLength: 8_000 },
    answer: { type: 'string', maxLength: 8_000 },
    author: authorSchema,
    commentCount: { type: 'integer', minimum: 0 },
    likeCount: { type: 'integer', minimum: 0 },
    readCount: { type: 'integer', minimum: 0 },
    rewardCount: { type: 'integer', minimum: 0 },
    digested: { type: 'boolean' },
    sticky: { type: 'boolean' },
    liked: { type: 'boolean' },
    contentDigest: sha256Schema,
    images: { type: 'array', maxItems: 10, items: imageSchema },
    files: { type: 'array', maxItems: 10, items: fileSchema },
    article: articleSchema,
  },
  required: ['id'],
  additionalProperties: false,
}

const groupSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    name: { type: 'string', maxLength: 256 },
    description: { type: 'string', maxLength: 4_000 },
    type: { type: 'string', maxLength: 32 },
    memberCount: { type: 'integer', minimum: 0 },
    topicCount: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', maxLength: 64 },
    joinedAt: { type: 'string', maxLength: 64 },
    validUntil: { type: 'string', maxLength: 64 },
    owner: authorSchema,
  },
  required: ['id', 'name'],
  additionalProperties: false,
}

const commentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 32 },
    createdAt: { type: 'string', maxLength: 64 },
    text: { type: 'string', maxLength: 1_200 },
    author: authorSchema,
    replyTo: authorSchema,
    likeCount: { type: 'integer', minimum: 0 },
    sticky: { type: 'boolean' },
    liked: { type: 'boolean' },
    images: { type: 'array', maxItems: 1, items: imageSchema },
    contentDigest: sha256Schema,
  },
  required: ['id'],
  additionalProperties: false,
}

const topicListResultSchema = {
  type: 'object',
  properties: {
    topics: { type: 'array', maxItems: 10, items: topicSchema },
    nextEndTime: { type: 'string', maxLength: 80 },
  },
  required: ['topics'],
  additionalProperties: false,
}

const topicListParamsSchema = {
  type: 'object',
  properties: {
    count: { type: 'integer', minimum: 1, maximum: 50 },
    scope: { type: 'string', enum: ['all', 'digests', 'by_owner'] },
    direction: { type: 'string', enum: ['forward', 'backward'] },
    beginTime: { type: 'string', maxLength: 80 },
    endTime: { type: 'string', maxLength: 80 },
  },
  additionalProperties: false,
}

const numericIdParamSchema = {
  type: 'string',
  minLength: 6,
  maxLength: 32,
  pattern: '^[0-9]{6,32}$',
}

const editSnapshotSchema = {
  type: 'object',
  properties: {
    expectedDigest: sha256Schema,
    previousText: { type: 'string', maxLength: 12_000 },
    imageIds: { type: 'array', maxItems: 10, items: numericIdParamSchema },
    fileIds: { type: 'array', maxItems: 10, items: numericIdParamSchema },
  },
  required: ['expectedDigest', 'previousText', 'imageIds', 'fileIds'],
  additionalProperties: false,
}

const deleteSnapshotSchema = {
  type: 'object',
  properties: {
    expectedDigest: sha256Schema,
    preview: { type: 'string', maxLength: 1_000 },
  },
  required: ['expectedDigest', 'preview'],
  additionalProperties: false,
}

const automationSourceSnapshotSchema = {
  type: 'object',
  properties: { expectedDigest: sha256Schema },
  required: ['expectedDigest'],
  additionalProperties: false,
}

const mutationResultSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
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
  network: {
    origins: ['https://api.zsxq.com', 'https://upload-z1.qiniup.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  },
  actions: [
    {
      id: 'get_self',
      description: '读取当前授权的知识星球账号身份',
      effect: 'read',
      timeoutSeconds: 30,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: { user: authorSchema },
        required: ['user'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_groups',
      description: '列出当前账号已加入的知识星球',
      effect: 'read',
      timeoutSeconds: 30,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          groups: { type: 'array', maxItems: 50, items: groupSchema },
        },
        required: ['groups'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_group',
      description: '读取指定知识星球的基本资料',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: { groupId: numericIdParamSchema },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { group: groupSchema },
        required: ['group'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_topics',
      description: '按范围、方向和时间读取指定知识星球的主题列表',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          ...topicListParamsSchema.properties,
        },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: topicListResultSchema,
    },
    {
      id: 'get_topic',
      description: '读取指定主题的结构化正文、问答与附件元数据',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: { topicId: numericIdParamSchema },
        required: ['topicId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { topic: topicSchema },
        required: ['topic'],
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
          topicId: numericIdParamSchema,
          count: { type: 'integer', minimum: 1, maximum: 50 },
          sort: { type: 'string', enum: ['asc', 'desc'] },
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
            items: commentSchema,
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
          groupId: numericIdParamSchema,
          keyword: { type: 'string', minLength: 1, maxLength: 100 },
          count: { type: 'integer', minimum: 1, maximum: 50 },
          index: { type: 'integer', minimum: 0, maximum: 1_000 },
        },
        required: ['groupId', 'keyword'],
        additionalProperties: false,
      },
      result: topicListResultSchema,
    },
    {
      id: 'list_dynamics',
      description: '读取所有已加入星球的最近动态',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 50 },
          endTime: { type: 'string', maxLength: 80 },
        },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          dynamics: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                createdAt: { type: 'string', maxLength: 64 },
                action: { type: 'string', maxLength: 64 },
                topic: topicSchema,
              },
              additionalProperties: false,
            },
          },
          nextEndTime: { type: 'string', maxLength: 80 },
        },
        required: ['dynamics'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_unread_counts',
      description: '读取各知识星球的未读主题数量',
      effect: 'read',
      timeoutSeconds: 30,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          counts: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                groupId: { type: 'string', maxLength: 32 },
                unreadCount: { type: 'integer', minimum: 0 },
              },
              required: ['groupId', 'unreadCount'],
              additionalProperties: false,
            },
          },
        },
        required: ['counts'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_hashtags',
      description: '列出指定知识星球的标签',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: { groupId: numericIdParamSchema },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          hashtags: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 32 },
                name: { type: 'string', maxLength: 256 },
                topicCount: { type: 'integer', minimum: 0 },
              },
              required: ['id', 'name'],
              additionalProperties: false,
            },
          },
        },
        required: ['hashtags'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_hashtag_topics',
      description: '读取指定标签下的主题',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          hashtagId: numericIdParamSchema,
          ...topicListParamsSchema.properties,
        },
        required: ['hashtagId'],
        additionalProperties: false,
      },
      result: topicListResultSchema,
    },
    {
      id: 'list_columns',
      description: '列出指定知识星球的专栏',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: { groupId: numericIdParamSchema },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          columns: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 32 },
                name: { type: 'string', maxLength: 256 },
                description: { type: 'string', maxLength: 4_000 },
                topicCount: { type: 'integer', minimum: 0 },
                createdAt: { type: 'string', maxLength: 64 },
              },
              required: ['id', 'name'],
              additionalProperties: false,
            },
          },
        },
        required: ['columns'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_column_topics',
      description: '读取指定专栏下的主题',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          columnId: numericIdParamSchema,
          ...topicListParamsSchema.properties,
        },
        required: ['groupId', 'columnId'],
        additionalProperties: false,
      },
      result: topicListResultSchema,
    },
    {
      id: 'list_checkins',
      description: '列出指定知识星球的打卡项目',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          scope: { type: 'string', enum: ['ongoing', 'closed', 'over'] },
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          checkins: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 32 },
                groupId: { type: 'string', maxLength: 32 },
                name: { type: 'string', maxLength: 256 },
                description: { type: 'string', maxLength: 4_000 },
                status: { type: 'string', maxLength: 32 },
                createdAt: { type: 'string', maxLength: 64 },
                beginAt: { type: 'string', maxLength: 64 },
                endAt: { type: 'string', maxLength: 64 },
                owner: authorSchema,
              },
              required: ['id', 'name'],
              additionalProperties: false,
            },
          },
        },
        required: ['checkins'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_checkin',
      description: '读取指定打卡项目的详情',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          checkinId: numericIdParamSchema,
        },
        required: ['groupId', 'checkinId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          checkin: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 32 },
              groupId: { type: 'string', maxLength: 32 },
              name: { type: 'string', maxLength: 256 },
              description: { type: 'string', maxLength: 4_000 },
              status: { type: 'string', maxLength: 32 },
              createdAt: { type: 'string', maxLength: 64 },
              beginAt: { type: 'string', maxLength: 64 },
              endAt: { type: 'string', maxLength: 64 },
              owner: authorSchema,
            },
            required: ['id', 'name'],
            additionalProperties: false,
          },
        },
        required: ['checkin'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_checkin_topics',
      description: '读取指定打卡项目下的打卡主题',
      effect: 'read',
      timeoutSeconds: 30,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          checkinId: numericIdParamSchema,
          ...topicListParamsSchema.properties,
        },
        required: ['groupId', 'checkinId'],
        additionalProperties: false,
      },
      result: topicListResultSchema,
    },
    {
      id: 'create_topic',
      description: '在指定知识星球发布文本、图片和附件主题（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          text: { type: 'string', maxLength: 10_000 },
          images: { type: 'array', maxItems: 9, items: mediaPathSchema },
          files: { type: 'array', maxItems: 9, items: mediaPathSchema },
          mediaManifest: { type: 'array', maxItems: 18, items: sealedMediaSchema },
        },
        required: ['groupId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { topic: topicSchema },
        required: ['topic'],
        additionalProperties: false,
      },
    },
    {
      id: 'create_comment',
      description: '在指定主题发布文字或单图评论/回复（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          topicId: numericIdParamSchema,
          text: { type: 'string', maxLength: 1_200 },
          repliedCommentId: numericIdParamSchema,
          images: { type: 'array', maxItems: 1, items: mediaPathSchema },
          mediaManifest: { type: 'array', maxItems: 1, items: sealedMediaSchema },
          automationSourceSnapshot: automationSourceSnapshotSchema,
        },
        required: ['topicId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { comment: commentSchema },
        required: ['comment'],
        additionalProperties: false,
      },
    },
    {
      id: 'edit_topic',
      description: '完整编辑普通主题正文并可追加图片或附件（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          groupId: numericIdParamSchema,
          topicId: numericIdParamSchema,
          text: { type: 'string', maxLength: 10_000 },
          preserveExistingMedia: { type: 'boolean' },
          images: { type: 'array', maxItems: 9, items: mediaPathSchema },
          files: { type: 'array', maxItems: 9, items: mediaPathSchema },
          mediaManifest: { type: 'array', maxItems: 18, items: sealedMediaSchema },
          editSnapshot: editSnapshotSchema,
        },
        required: ['groupId', 'topicId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { topic: topicSchema },
        required: ['topic'],
        additionalProperties: false,
      },
    },
    {
      id: 'delete_topic',
      description: '永久删除主题（不可撤销；默认逐次确认，账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { topicId: numericIdParamSchema, deleteSnapshot: deleteSnapshotSchema },
        required: ['topicId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'delete_comment',
      description: '永久删除评论或回复（不可撤销；默认逐次确认，账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          topicId: numericIdParamSchema,
          commentId: numericIdParamSchema,
          deleteSnapshot: deleteSnapshotSchema,
        },
        required: ['topicId', 'commentId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_topic_like',
      description: '把主题点赞状态设置为已赞或未赞（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { topicId: numericIdParamSchema, liked: { type: 'boolean' } },
        required: ['topicId', 'liked'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_comment_like',
      description: '把评论点赞状态设置为已赞或未赞（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { commentId: numericIdParamSchema, liked: { type: 'boolean' } },
        required: ['commentId', 'liked'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
  ],
} as const)

export const COMPILED_KNOWLEDGE_PLANET_PLUGIN = compileRuntimePluginArtifact(
  KNOWLEDGE_PLANET_PLUGIN_ARTIFACT,
)

if (COMPILED_KNOWLEDGE_PLANET_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Knowledge Planet Plugin contract subtype mismatch')

/**
 * Exact platform-reviewed predecessors accepted for additive official upgrades.
 * Their browser account-state contract is byte-for-byte compatible with v1.4;
 * no other historical or user-published Knowledge Planet artifact is eligible.
 */
export const KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS = Object.freeze([
  Object.freeze({
    version: '1.3.0',
    artifactHash: '1dbcb8d8861ae812431277e0144c93dd6018f0ba47b1ea359a8dcfb173a0c258',
    execContractHash: 'ae7f8dab13127f098d5e7aa676556c0c00354d12dbf1df632bc0e9dfa766a898',
  }),
  Object.freeze({
    version: '1.2.0',
    artifactHash: 'ee306d2ede7fe277084e842687ff798317ada778aeda942e31bb5770c83f0824',
    execContractHash: '240e3cfe91898d8cb13ba983a05f0cf1082ccee57a22d27674ebd409f894f949',
  }),
  Object.freeze({
    version: '1.1.0',
    artifactHash: 'fed46671c5af6156a4395c213695f5171c655cecc3efd0ef176d72330b7d3e36',
    execContractHash: '2f27efdba9c06947ab4e0081deedc9e0b988f6a96d09ae36c6cbc8f54209892c',
  }),
  Object.freeze({
    version: '1.0.0',
    artifactHash: '15ffb9bec94dfb42599bb55c04e98a9c7bf9b3f0af3a1ee420cd3bc1b8d080a7',
    execContractHash: '41bc152b755ee305405a5d51b652e057cbe07e29b2040dc4075000b200c8e39c',
  }),
])

export function classifyKnowledgePlanetSetupPin(input: {
  version: string
  artifactHash: string
  execContractHash: string
}): 'current' | 'compatible-predecessor' | null {
  if (
    input.version === KNOWLEDGE_PLANET_PLUGIN_VERSION &&
    input.artifactHash === COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash
  )
    return 'current'
  return KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS.some(
    (pin) =>
      pin.version === input.version &&
      pin.artifactHash === input.artifactHash &&
      pin.execContractHash === input.execContractHash,
  )
    ? 'compatible-predecessor'
    : null
}

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
