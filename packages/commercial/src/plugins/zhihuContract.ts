/** Version-controlled official Zhihu managed-browser Plugin artifact and trust pins. */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { ZHIHU_WORKER_SOURCE } from './zhihuWorkerSource.js'

export const ZHIHU_PLUGIN_SLUG = 'zhihu'
export const ZHIHU_PLUGIN_VERSION = '1.0.0'
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
const numericIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 32,
  pattern: '^[0-9]{1,32}$',
}
const commentIdSchema = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[0-9a-f]{64,64}$',
}
const urlTokenSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Za-z0-9-]{1,100}$',
}
const contentKindSchema = { type: 'string', enum: ['answer', 'article', 'question'] }
const commentTargetKindSchema = { type: 'string', enum: ['answer', 'article'] }
const favoriteTargetKindSchema = { type: 'string', enum: ['answer', 'article'] }
const followTargetKindSchema = { type: 'string', enum: ['user', 'question'] }
const pageParams = {
  offset: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
  count: { type: 'integer', minimum: 1, maximum: 50 },
}
const pageResult = {
  hasMore: { type: 'boolean' },
  nextOffset: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
}
const mutationResultSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, changed: { type: 'boolean' } },
  required: ['ok', 'changed'],
  additionalProperties: false,
}
const userSchema = {
  type: 'object',
  properties: {
    id: urlTokenSchema,
    name: { type: 'string', minLength: 1, maxLength: 128 },
    url: { type: 'string', maxLength: 1_024 },
    headline: { type: 'string', maxLength: 2_000 },
    avatarUrl: { type: 'string', maxLength: 2_048 },
    followerCount: { type: 'integer', minimum: 0 },
    followingCount: { type: 'integer', minimum: 0 },
    following: { type: 'boolean' },
    owned: { type: 'boolean' },
  },
  required: ['id', 'name', 'url', 'owned'],
  additionalProperties: false,
}
const questionSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    title: { type: 'string', minLength: 1, maxLength: 1_000 },
    detail: { type: 'string', maxLength: 300_000 },
    url: { type: 'string', maxLength: 1_024 },
    answerCount: { type: 'integer', minimum: 0 },
    followerCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    followed: { type: 'boolean' },
    owned: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: ['id', 'title', 'url', 'followed', 'owned', 'contentDigest'],
  additionalProperties: false,
}
const answerSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    questionId: numericIdSchema,
    author: userSchema,
    content: { type: 'string', maxLength: 500_000 },
    url: { type: 'string', maxLength: 1_024 },
    createdAt: { type: 'string', maxLength: 128 },
    updatedAt: { type: 'string', maxLength: 128 },
    voteCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    voteState: { type: 'string', enum: ['up', 'down', 'none'] },
    favorited: { type: 'boolean' },
    owned: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: [
    'id',
    'questionId',
    'author',
    'content',
    'url',
    'voteState',
    'favorited',
    'owned',
    'contentDigest',
  ],
  additionalProperties: false,
}
const articleSchema = {
  type: 'object',
  properties: {
    id: numericIdSchema,
    title: { type: 'string', minLength: 1, maxLength: 1_000 },
    author: userSchema,
    content: { type: 'string', maxLength: 500_000 },
    url: { type: 'string', maxLength: 1_024 },
    createdAt: { type: 'string', maxLength: 128 },
    updatedAt: { type: 'string', maxLength: 128 },
    voteCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    favorited: { type: 'boolean' },
    owned: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: ['id', 'title', 'author', 'content', 'url', 'favorited', 'owned', 'contentDigest'],
  additionalProperties: false,
}
const commentSchema = {
  type: 'object',
  properties: {
    id: commentIdSchema,
    targetKind: commentTargetKindSchema,
    targetId: numericIdSchema,
    author: userSchema,
    text: { type: 'string', maxLength: 20_000 },
    createdAt: { type: 'string', maxLength: 128 },
    voteCount: { type: 'integer', minimum: 0 },
    voteState: { type: 'string', enum: ['up', 'none'] },
    owned: { type: 'boolean' },
    parentCommentId: commentIdSchema,
    contentDigest: sha256Schema,
  },
  required: [
    'id',
    'targetKind',
    'targetId',
    'author',
    'text',
    'voteState',
    'owned',
    'contentDigest',
  ],
  additionalProperties: false,
}
const contentSummarySchema = {
  type: 'object',
  properties: {
    kind: contentKindSchema,
    id: numericIdSchema,
    title: { type: 'string', maxLength: 1_000 },
    summary: { type: 'string', maxLength: 20_000 },
    url: { type: 'string', maxLength: 1_024 },
    authorName: { type: 'string', maxLength: 128 },
    voteCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', maxLength: 128 },
    owned: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: ['kind', 'id', 'title', 'summary', 'url', 'owned', 'contentDigest'],
  additionalProperties: false,
}
const notificationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    text: { type: 'string', maxLength: 20_000 },
    url: { type: 'string', maxLength: 1_024 },
    createdAt: { type: 'string', maxLength: 128 },
    unread: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: ['id', 'text', 'url', 'unread', 'contentDigest'],
  additionalProperties: false,
}
const ownedSnapshotSchema = {
  type: 'object',
  properties: {
    expectedDigest: sha256Schema,
    owned: { type: 'boolean', enum: [true] },
  },
  required: ['expectedDigest', 'owned'],
  additionalProperties: false,
}
const commentSnapshotSchema = {
  type: 'object',
  properties: {
    expectedDigest: sha256Schema,
    parentCommentId: commentIdSchema,
    targetKind: commentTargetKindSchema,
    targetId: numericIdSchema,
    owned: { type: 'boolean' },
  },
  required: ['expectedDigest', 'targetKind', 'targetId', 'owned'],
  additionalProperties: false,
}

export const ZHIHU_NETWORK_ORIGINS = Object.freeze([
  'https://www.zhihu.com',
  'https://zhuanlan.zhihu.com',
  'https://static.zhihu.com',
  'https://unpkg.zhimg.com',
  'https://pic1.zhimg.com',
  'https://pic2.zhimg.com',
  'https://pic3.zhimg.com',
  'https://pic4.zhimg.com',
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
    cookieDomains: ['zhihu.com', 'www.zhihu.com', 'zhuanlan.zhihu.com'],
    origins: ['https://www.zhihu.com', 'https://zhuanlan.zhihu.com'],
  },
  network: { origins: ZHIHU_NETWORK_ORIGINS, methods: ['GET', 'POST', 'DELETE'] },
  actions: [
    {
      id: 'get_self',
      description: '读取当前知乎账号的公开资料',
      effect: 'read',
      timeoutSeconds: 120,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: { user: userSchema },
        required: ['user'],
        additionalProperties: false,
      },
    },
    {
      id: 'search_content',
      description: '按关键词分页搜索知乎问题、回答或文章',
      effect: 'read',
      timeoutSeconds: 150,
      params: {
        type: 'object',
        properties: {
          keyword: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['all', 'question', 'answer', 'article'] },
          ...pageParams,
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          items: { type: 'array', maxItems: 50, items: contentSummarySchema },
          ...pageResult,
        },
        required: ['items', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_hot',
      description: '读取知乎当前热榜',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { items: { type: 'array', maxItems: 50, items: contentSummarySchema } },
        required: ['items'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_question',
      description: '读取指定知乎问题详情',
      effect: 'read',
      timeoutSeconds: 120,
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
      description: '分页读取指定问题的回答',
      effect: 'read',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          questionId: numericIdSchema,
          sort: { type: 'string', enum: ['default', 'updated'] },
          ...pageParams,
        },
        required: ['questionId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          answers: { type: 'array', maxItems: 50, items: answerSchema },
          ...pageResult,
        },
        required: ['answers', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_answer',
      description: '读取指定知乎回答正文与当前互动状态',
      effect: 'read',
      timeoutSeconds: 120,
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
      id: 'get_article',
      description: '读取指定知乎文章正文与当前互动状态',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { articleId: numericIdSchema },
        required: ['articleId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { article: articleSchema },
        required: ['article'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_user',
      description: '读取指定知乎用户公开资料',
      effect: 'read',
      timeoutSeconds: 120,
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
      id: 'list_user_content',
      description: '分页读取指定用户公开创作',
      effect: 'read',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          urlToken: urlTokenSchema,
          kind: { type: 'string', enum: ['all', 'answer', 'article', 'question'] },
          ...pageParams,
        },
        required: ['urlToken'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          items: { type: 'array', maxItems: 50, items: contentSummarySchema },
          ...pageResult,
        },
        required: ['items', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_favorites',
      description: '分页读取当前账号可见的收藏内容',
      effect: 'read',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { ...pageParams },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          items: { type: 'array', maxItems: 50, items: contentSummarySchema },
          ...pageResult,
        },
        required: ['items', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_notifications',
      description: '分页读取当前账号可见的知乎通知；打开通知页可能同步刷新网页红点',
      effect: 'read',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { ...pageParams },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          notifications: { type: 'array', maxItems: 50, items: notificationSchema },
          ...pageResult,
        },
        required: ['notifications', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_comments',
      description: '分页读取指定回答或文章的评论与回复',
      effect: 'read',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          targetKind: commentTargetKindSchema,
          targetId: numericIdSchema,
          ...pageParams,
        },
        required: ['targetKind', 'targetId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          comments: { type: 'array', maxItems: 50, items: commentSchema },
          ...pageResult,
        },
        required: ['comments', 'hasMore'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_comment',
      description: '读取指定回答或文章下的精确评论',
      effect: 'read',
      timeoutSeconds: 150,
      params: {
        type: 'object',
        properties: {
          targetKind: commentTargetKindSchema,
          targetId: numericIdSchema,
          commentId: commentIdSchema,
        },
        required: ['targetKind', 'targetId', 'commentId'],
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
      id: 'create_question',
      description: '使用当前知乎身份发布问题（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 4, maxLength: 1_000 },
          detail: { type: 'string', maxLength: 300_000 },
          topics: {
            type: 'array',
            maxItems: 5,
            items: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        required: ['title'],
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
      id: 'create_answer',
      description: '回答指定知乎问题（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          questionId: numericIdSchema,
          content: { type: 'string', minLength: 1, maxLength: 400_000 },
        },
        required: ['questionId', 'content'],
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
      description: '编辑自己发布的知乎回答（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          content: { type: 'string', minLength: 1, maxLength: 400_000 },
          editSnapshot: ownedSnapshotSchema,
        },
        required: ['answerId', 'content'],
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
        properties: { answerId: numericIdSchema, deleteSnapshot: ownedSnapshotSchema },
        required: ['answerId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'create_article',
      description: '使用当前知乎身份发布文章（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 1_000 },
          content: { type: 'string', minLength: 1, maxLength: 400_000 },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { article: articleSchema },
        required: ['article'],
        additionalProperties: false,
      },
    },
    {
      id: 'edit_article',
      description: '编辑自己发布的知乎文章（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          articleId: numericIdSchema,
          title: { type: 'string', minLength: 1, maxLength: 1_000 },
          content: { type: 'string', minLength: 1, maxLength: 400_000 },
          editSnapshot: ownedSnapshotSchema,
        },
        required: ['articleId', 'title', 'content'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { article: articleSchema },
        required: ['article'],
        additionalProperties: false,
      },
    },
    {
      id: 'delete_article',
      description: '永久删除自己发布的知乎文章（不可撤销；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { articleId: numericIdSchema, deleteSnapshot: ownedSnapshotSchema },
        required: ['articleId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'create_comment',
      description: '评论指定知乎回答或文章（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          targetKind: commentTargetKindSchema,
          targetId: numericIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 5_000 },
        },
        required: ['targetKind', 'targetId', 'text'],
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
          targetKind: commentTargetKindSchema,
          targetId: numericIdSchema,
          commentId: commentIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 5_000 },
          replySnapshot: commentSnapshotSchema,
        },
        required: ['targetKind', 'targetId', 'commentId', 'text'],
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
      description: '永久删除自己发布的知乎评论（不可撤销；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          targetKind: commentTargetKindSchema,
          targetId: numericIdSchema,
          commentId: commentIdSchema,
          deleteSnapshot: commentSnapshotSchema,
        },
        required: ['targetKind', 'targetId', 'commentId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_answer_vote',
      description: '设置知乎回答的赞同或反对状态（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          answerId: numericIdSchema,
          vote: { type: 'string', enum: ['up', 'down', 'none'] },
        },
        required: ['answerId', 'vote'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_comment_vote',
      description: '设置知乎评论的赞同状态（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          targetKind: commentTargetKindSchema,
          targetId: numericIdSchema,
          commentId: commentIdSchema,
          voted: { type: 'boolean' },
        },
        required: ['targetKind', 'targetId', 'commentId', 'voted'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_favorite',
      description: '设置问题、回答或文章的收藏状态（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          targetKind: favoriteTargetKindSchema,
          targetId: numericIdSchema,
          favorited: { type: 'boolean' },
        },
        required: ['targetKind', 'targetId', 'favorited'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_following',
      description: '设置用户或问题的关注状态（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          targetKind: followTargetKindSchema,
          targetId: urlTokenSchema,
          following: { type: 'boolean' },
        },
        required: ['targetKind', 'targetId', 'following'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
  ],
} as const)

export const COMPILED_ZHIHU_PLUGIN = compileRuntimePluginArtifact(ZHIHU_PLUGIN_ARTIFACT)
if (COMPILED_ZHIHU_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Zhihu Plugin contract subtype mismatch')

export const ZHIHU_SETUP_COMPATIBLE_PREDECESSORS = Object.freeze([])

export function classifyZhihuSetupPin(input: {
  version: string
  artifactHash: string
  execContractHash: string
}): 'current' | 'compatible-predecessor' | null {
  return input.version === ZHIHU_PLUGIN_VERSION &&
    input.artifactHash === COMPILED_ZHIHU_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_ZHIHU_PLUGIN.execContractHash
    ? 'current'
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
  'https://unpkg.zhimg.com:443',
  'https://pic2.zhimg.com:443',
  'https://pic3.zhimg.com:443',
  'https://pica.zhimg.com:443',
  'https://picx.zhimg.com:443',
  'https://captcha.zhihu.com:443',
  'https://c.dun.163.com:443',
  'https://cstaticdun.126.net:443',
])
