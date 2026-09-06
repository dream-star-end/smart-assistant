/** Version-controlled official Zhihu Plugin artifact and trust pins. */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { ZHIHU_WORKER_SOURCE } from './zhihuWorkerSource.js'

export const ZHIHU_PLUGIN_SLUG = 'zhihu'
export const ZHIHU_PLUGIN_VERSION = '1.1.1'
export const ZHIHU_WORKER_DIGEST = createHash('sha256').update(ZHIHU_WORKER_SOURCE).digest('hex')
export const ZHIHU_DRIVER_ID = `zhihu-${ZHIHU_WORKER_DIGEST.slice(0, 57)}`
export const ZHIHU_DRIVER_VERSION = ZHIHU_PLUGIN_VERSION
export const ZHIHU_LAUNCHER_ID = `zhihu-container-${ZHIHU_WORKER_DIGEST.slice(0, 47)}`
export const ZHIHU_LAUNCHER_VERSION = ZHIHU_PLUGIN_VERSION

const sha256Schema = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[0-9a-f]{64,64}$',
}
const urlTokenSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9-]{1,64}$',
}
const numericIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 20,
  pattern: '^[0-9]{1,20}$',
}
const opaqueIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9-]{1,64}$',
}
const mediaPathSchema = { type: 'string', minLength: 1, maxLength: 512 }
const sealedImageSchema = {
  type: 'object',
  properties: {
    path: mediaPathSchema,
    inputId: opaqueIdSchema,
    filename: { type: 'string', minLength: 1, maxLength: 512 },
    sizeBytes: { type: 'integer', minimum: 1, maximum: 15 * 1024 * 1024 },
    sha256: sha256Schema,
    mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
    kind: { type: 'string', enum: ['image'] },
  },
  required: ['path', 'inputId', 'filename', 'sizeBytes', 'sha256', 'mimeType', 'kind'],
  additionalProperties: false,
}
const imageListSchema = { type: 'array', maxItems: 9, items: mediaPathSchema }
const mediaManifestSchema = { type: 'array', maxItems: 9, items: sealedImageSchema }
const degradedReasonSchema = {
  type: 'string',
  enum: ['empty_list', 'incomplete_projection'],
}

const userSchema = {
  type: 'object',
  properties: {
    urlToken: urlTokenSchema,
    name: { type: 'string', maxLength: 128 },
    headline: { type: 'string', maxLength: 500 },
    profileUrl: { type: 'string', maxLength: 512 },
    followerCount: { type: 'integer', minimum: 0 },
    followingCount: { type: 'integer', minimum: 0 },
  },
  required: ['urlToken', 'name', 'profileUrl'],
  additionalProperties: false,
}

const questionSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    title: { type: 'string', maxLength: 500 },
    detail: { type: 'string', maxLength: 5_000 },
    followerCount: { type: 'integer', minimum: 0 },
    answerCount: { type: 'integer', minimum: 0 },
    url: { type: 'string', maxLength: 512 },
  },
  required: ['id', 'title', 'url'],
  additionalProperties: false,
}

const answerSummarySchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    questionId: numericIdSchema,
    authorName: { type: 'string', maxLength: 128 },
    authorUrlToken: urlTokenSchema,
    excerpt: { type: 'string', maxLength: 500 },
    voteCount: { type: 'integer', minimum: 0 },
    url: { type: 'string', maxLength: 512 },
  },
  required: ['id', 'questionId', 'url'],
  additionalProperties: false,
}

const answerSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    questionId: numericIdSchema,
    questionTitle: { type: 'string', maxLength: 500 },
    authorName: { type: 'string', maxLength: 128 },
    authorUrlToken: urlTokenSchema,
    text: { type: 'string', maxLength: 20_000 },
    voteCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    url: { type: 'string', maxLength: 512 },
    contentDigest: sha256Schema,
    revision: { type: 'string', minLength: 1, maxLength: 128 },
    updatedAt: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['id', 'text', 'url', 'contentDigest'],
  additionalProperties: false,
}

const commentSchema = {
  type: 'object',
  properties: {
    id: opaqueIdSchema,
    answerId: numericIdSchema,
    authorName: { type: 'string', maxLength: 128 },
    authorUrlToken: urlTokenSchema,
    text: { type: 'string', maxLength: 2_000 },
    url: { type: 'string', maxLength: 512 },
    contentDigest: sha256Schema,
    revision: { type: 'string', minLength: 1, maxLength: 128 },
    updatedAt: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['id', 'answerId', 'text', 'contentDigest'],
  additionalProperties: false,
}

const searchItemSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 500 },
    url: { type: 'string', maxLength: 512 },
    excerpt: { type: 'string', maxLength: 500 },
    kind: { type: 'string', maxLength: 32 },
  },
  required: ['title', 'url'],
  additionalProperties: false,
}

const feedItemSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 500 },
    url: { type: 'string', maxLength: 512 },
    excerpt: { type: 'string', maxLength: 500 },
  },
  required: ['title', 'url'],
  additionalProperties: false,
}

const notificationSchema = {
  type: 'object',
  properties: {
    id: opaqueIdSchema,
    text: { type: 'string', maxLength: 500 },
    url: { type: 'string', maxLength: 512 },
  },
  required: ['id', 'text', 'url'],
  additionalProperties: false,
}

const ownedItemSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    title: { type: 'string', maxLength: 500 },
    url: { type: 'string', maxLength: 512 },
    excerpt: { type: 'string', maxLength: 500 },
  },
  required: ['id', 'url'],
  additionalProperties: false,
}

const hotItemSchema = {
  type: 'object',
  properties: {
    rank: { type: 'integer', minimum: 1, maximum: 100 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    url: { type: 'string', maxLength: 512 },
    hotValue: { type: 'integer', minimum: 0 },
  },
  required: ['rank', 'title', 'url'],
  additionalProperties: false,
}

const mutationResultSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, changed: { type: 'boolean' } },
  required: ['ok', 'changed'],
  additionalProperties: false,
}
const snapshotSchema = {
  type: 'object',
  properties: { expectedDigest: sha256Schema, owned: { type: 'boolean', enum: [true] } },
  required: ['expectedDigest', 'owned'],
  additionalProperties: false,
}

const pinSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    text: { type: 'string', maxLength: 2_000 },
    url: { type: 'string', maxLength: 512 },
    contentDigest: sha256Schema,
  },
  required: ['id', 'text', 'url', 'contentDigest'],
  additionalProperties: false,
}

export const ZHIHU_NETWORK_ORIGINS = Object.freeze([
  'https://www.zhihu.com',
  'https://zhuanlan.zhihu.com',
  'https://static.zhihu.com',
  'https://zhstatic.zhihu.com',
  'https://unpkg.zhimg.com',
  'https://pic1.zhimg.com',
  'https://pic2.zhimg.com',
  'https://pic3.zhimg.com',
  'https://pic4.zhimg.com',
  'https://pic5.zhimg.com',
  'https://pica.zhimg.com',
  'https://picb.zhimg.com',
  'https://picx.zhimg.com',
])

export const ZHIHU_PLUGIN_ARTIFACT = Object.freeze({
  schemaVersion: 1,
  pluginType: 'managed-browser',
  id: ZHIHU_PLUGIN_SLUG,
  version: ZHIHU_PLUGIN_VERSION,
  driver: { id: ZHIHU_DRIVER_ID, version: ZHIHU_DRIVER_VERSION },
  account: { mode: 'required', contractVersion: 1 },
  accountState: {
    cookieDomains: ['zhihu.com', 'zhuanlan.zhihu.com', 'zhimg.com'],
    origins: ['https://www.zhihu.com', 'https://zhuanlan.zhihu.com'],
  },
  network: { origins: ZHIHU_NETWORK_ORIGINS, methods: ['GET', 'POST', 'DELETE'] },
  actions: [
    {
      id: 'get_self',
      description: '读取当前知乎账号的公开资料',
      effect: 'read',
      timeoutSeconds: 300,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: { user: userSchema },
        required: ['user'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_user',
      description: '读取指定知乎用户的公开资料',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { urlToken: urlTokenSchema },
        required: ['urlToken'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { user: userSchema },
        required: ['user'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_question',
      description: '读取指定知乎问题的标题、详情和计数',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { questionId: numericIdSchema },
        required: ['questionId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { question: questionSchema },
        required: ['question'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_question_answers',
      description: '读取指定问题下当前页面可见的回答列表',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          questionId: numericIdSchema,
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['questionId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          answers: { type: 'array', maxItems: 50, items: answerSummarySchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['answers', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_answer',
      description: '读取指定知乎回答的纯文本全文与互动计数',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { answerId: numericIdSchema },
        required: ['answerId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { answer: answerSchema },
        required: ['answer'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_answer_comments',
      description: '读取指定回答当前页面可见的评论',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['answerId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          comments: { type: 'array', maxItems: 50, items: commentSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['comments', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'search',
      description: '按关键词读取知乎站内搜索结果',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 100 },
          type: { type: 'string', enum: ['general', 'question', 'people'] },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          results: { type: 'array', maxItems: 20, items: searchItemSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['results', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_feed',
      description: '读取知乎首页关注流当前可见条目',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          items: { type: 'array', maxItems: 20, items: feedItemSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['items', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_notifications',
      description: '读取知乎消息通知当前可见条目',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          notifications: { type: 'array', maxItems: 50, items: notificationSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['notifications', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_my_answers',
      description: '读取当前账号近期回答列表',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          answers: { type: 'array', maxItems: 20, items: ownedItemSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['answers', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_my_articles',
      description: '读取当前账号近期文章列表',
      effect: 'read',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          articles: { type: 'array', maxItems: 20, items: ownedItemSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['articles', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_hot',
      description: '读取知乎热榜当前可见条目',
      effect: 'read',
      timeoutSeconds: 300,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          searches: { type: 'array', maxItems: 50, items: hotItemSchema },
          complete: { type: 'boolean' },
          degradedReason: degradedReasonSchema,
        },
        required: ['searches', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'create_pin',
      description:
        '使用当前真实知乎身份发布想法（可带图，默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 2_000 },
          images: imageListSchema,
          mediaManifest: mediaManifestSchema,
        },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { pin: pinSchema },
        required: ['pin'],
        additionalProperties: false,
      },
    },
    {
      id: 'create_answer',
      description: '使用当前真实知乎身份回答指定问题（可带图，默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          questionId: numericIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 20_000 },
          images: imageListSchema,
          mediaManifest: mediaManifestSchema,
        },
        required: ['questionId', 'text'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { answer: answerSchema },
        required: ['answer'],
        additionalProperties: false,
      },
    },
    {
      id: 'edit_answer',
      description: '编辑自己已发布的知乎回答（可带图，默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 20_000 },
          snapshot: snapshotSchema,
          images: imageListSchema,
          mediaManifest: mediaManifestSchema,
        },
        required: ['answerId', 'text'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { answer: answerSchema },
        required: ['answer'],
        additionalProperties: false,
      },
    },
    {
      id: 'delete_answer',
      description: '永久删除自己发布的知乎回答（不可撤销；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { answerId: numericIdSchema, snapshot: snapshotSchema },
        required: ['answerId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'create_comment',
      description: '评论指定知乎回答（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
        required: ['answerId', 'text'],
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
      id: 'reply_comment',
      description: '回复指定知乎评论（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          commentId: opaqueIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
        required: ['answerId', 'commentId', 'text'],
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
      id: 'delete_comment',
      description: '永久删除自己发表的知乎评论（不可撤销；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          commentId: opaqueIdSchema,
          snapshot: snapshotSchema,
        },
        required: ['answerId', 'commentId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_vote',
      description:
        '把指定知乎回答的投票状态设置为赞同、反对或中立（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          vote: { type: 'string', enum: ['up', 'down', 'neutral'] },
        },
        required: ['answerId', 'vote'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_following',
      description: '把指定知乎用户关注状态设置为已关注或未关注（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { urlToken: urlTokenSchema, following: { type: 'boolean' } },
        required: ['urlToken', 'following'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'create_article',
      description: '使用当前真实知乎身份发布文章（可带图，默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          text: { type: 'string', minLength: 1, maxLength: 20_000 },
          images: imageListSchema,
          mediaManifest: mediaManifestSchema,
        },
        required: ['title', 'text'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          article: {
            type: 'object',
            properties: {
              id: numericIdSchema,
              title: { type: 'string', maxLength: 200 },
              url: { type: 'string', maxLength: 512 },
              contentDigest: sha256Schema,
            },
            required: ['id', 'title', 'url', 'contentDigest'],
            additionalProperties: false,
          },
        },
        required: ['article'],
        additionalProperties: false,
      },
    },
  ],
} as const)

export const COMPILED_ZHIHU_PLUGIN = compileRuntimePluginArtifact(ZHIHU_PLUGIN_ARTIFACT)
if (COMPILED_ZHIHU_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Zhihu Plugin contract subtype mismatch')

export const ZHIHU_SETUP_COMPATIBLE_PREDECESSORS: readonly {
  version: string
  artifactHash: string
  execContractHash: string
}[] = Object.freeze([])

export function classifyZhihuSetupPin(input: {
  version: string
  artifactHash: string
  execContractHash: string
}): 'current' | 'compatible-predecessor' | null {
  if (
    input.version === ZHIHU_PLUGIN_VERSION &&
    input.artifactHash === COMPILED_ZHIHU_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_ZHIHU_PLUGIN.execContractHash
  )
    return 'current'
  return ZHIHU_SETUP_COMPATIBLE_PREDECESSORS.some(
    (pin) =>
      pin.version === input.version &&
      pin.artifactHash === input.artifactHash &&
      pin.execContractHash === input.execContractHash,
  )
    ? 'compatible-predecessor'
    : null
}

export function isOfficialZhihuPluginIdentity(input: {
  slug: string
  pluginType: string | null
  artifactHash: string
  execContractHash: string | null
  reviewSource: string | null
}): boolean {
  return (
    input.slug === ZHIHU_PLUGIN_SLUG &&
    input.pluginType === 'managed-browser' &&
    input.artifactHash === COMPILED_ZHIHU_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_ZHIHU_PLUGIN.execContractHash &&
    input.reviewSource === 'platform'
  )
}

export const ZHIHU_PLUGIN_CONTRACT: ManagedBrowserPluginContractV1 =
  COMPILED_ZHIHU_PLUGIN.execContract

export const ZHIHU_LOGIN_ORIGINS = Object.freeze([
  'https://www.zhihu.com:443',
  'https://static.zhihu.com:443',
  'https://zhstatic.zhihu.com:443',
  'https://unpkg.zhimg.com:443',
  'https://zhuanlan.zhihu.com:443',
])
