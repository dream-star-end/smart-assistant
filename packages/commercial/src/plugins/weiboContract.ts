/** Version-controlled official Weibo Plugin artifact and trust pins. */

import { createHash } from 'node:crypto'

import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { compileRuntimePluginArtifact } from './contracts.js'
import { WEIBO_WORKER_SOURCE } from './weiboWorkerSource.js'

export const WEIBO_PLUGIN_SLUG = 'weibo'
export const WEIBO_PLUGIN_VERSION = '1.5.0'
export const WEIBO_WORKER_DIGEST = createHash('sha256').update(WEIBO_WORKER_SOURCE).digest('hex')
export const WEIBO_DRIVER_ID = `weibo-${WEIBO_WORKER_DIGEST.slice(0, 57)}`
export const WEIBO_DRIVER_VERSION = WEIBO_PLUGIN_VERSION
export const WEIBO_LAUNCHER_ID = `weibo-container-${WEIBO_WORKER_DIGEST.slice(0, 47)}`
export const WEIBO_LAUNCHER_VERSION = WEIBO_PLUGIN_VERSION

const sha256Schema = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[0-9a-f]{64,64}$',
}
const userIdSchema = {
  type: 'string',
  minLength: 5,
  maxLength: 20,
  pattern: '^[0-9]{5,20}$',
}
const opaqueIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9-]{1,64}$',
}
const postIdSchema = {
  type: 'string',
  minLength: 5,
  maxLength: 32,
  pattern: '^[A-Za-z0-9-]{5,32}$',
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

const userSchema = {
  type: 'object',
  properties: {
    id: userIdSchema,
    name: { type: 'string', maxLength: 128 },
    profileUrl: { type: 'string', maxLength: 512 },
    bio: { type: 'string', maxLength: 2_000 },
    verified: { type: 'boolean' },
    following: { type: 'boolean' },
    followerCount: { type: 'integer', minimum: 0 },
    followingCount: { type: 'integer', minimum: 0 },
    postCount: { type: 'integer', minimum: 0 },
  },
  required: ['id', 'name', 'profileUrl'],
  additionalProperties: false,
}

const imageSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', maxLength: 2_048 },
    alt: { type: 'string', maxLength: 512 },
  },
  required: ['url'],
  additionalProperties: false,
}

const postSchema = {
  type: 'object',
  properties: {
    id: postIdSchema,
    userId: userIdSchema,
    authorName: { type: 'string', maxLength: 128 },
    text: { type: 'string', maxLength: 20_000 },
    createdAt: { type: 'string', maxLength: 128 },
    url: { type: 'string', maxLength: 512 },
    owned: { type: 'boolean' },
    liked: { type: 'boolean' },
    favorited: { type: 'boolean' },
    likeCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    repostCount: { type: 'integer', minimum: 0 },
    images: { type: 'array', maxItems: 18, items: imageSchema },
    contentDigest: sha256Schema,
  },
  required: ['id', 'userId', 'text', 'url', 'owned', 'liked', 'contentDigest'],
  additionalProperties: false,
}

const searchPostSchema = {
  type: 'object',
  properties: {
    id: postIdSchema,
    userId: userIdSchema,
    authorName: { type: 'string', maxLength: 128 },
    text: { type: 'string', maxLength: 20_000 },
    createdAt: { type: 'string', maxLength: 128 },
    url: { type: 'string', maxLength: 512 },
    owned: { type: 'boolean' },
    liked: { type: 'boolean' },
    likeCount: { type: 'integer', minimum: 0 },
    commentCount: { type: 'integer', minimum: 0 },
    repostCount: { type: 'integer', minimum: 0 },
    images: { type: 'array', maxItems: 18, items: imageSchema },
    detailAvailable: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: ['id', 'text', 'url', 'detailAvailable', 'contentDigest'],
  additionalProperties: false,
}

const commentSchema = {
  type: 'object',
  properties: {
    id: opaqueIdSchema,
    postId: postIdSchema,
    userId: userIdSchema,
    authorName: { type: 'string', maxLength: 128 },
    text: { type: 'string', maxLength: 5_000 },
    createdAt: { type: 'string', maxLength: 128 },
    owned: { type: 'boolean' },
    liked: { type: 'boolean' },
    likeCount: { type: 'integer', minimum: 0 },
    parentCommentId: opaqueIdSchema,
    contentDigest: sha256Schema,
  },
  required: ['id', 'postId', 'userId', 'text', 'owned', 'contentDigest'],
  additionalProperties: false,
}

const postsResultSchema = {
  type: 'object',
  properties: { posts: { type: 'array', maxItems: 20, items: postSchema } },
  required: ['posts'],
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
const commentDeleteSnapshotSchema = {
  type: 'object',
  properties: {
    expectedDigest: sha256Schema,
    targetKind: { type: 'string', enum: ['own_comment', 'received_on_own_post'] },
    postExpectedDigest: sha256Schema,
  },
  required: ['expectedDigest', 'targetKind'],
  additionalProperties: false,
}
const notificationCategorySchema = {
  type: 'string',
  enum: ['mentions', 'comments', 'likes', 'followers'],
}
const notificationSchema = {
  type: 'object',
  properties: {
    id: opaqueIdSchema,
    category: notificationCategorySchema,
    actor: userSchema,
    text: { type: 'string', maxLength: 5_000 },
    createdAt: { type: 'string', maxLength: 128 },
    unread: { type: 'boolean' },
    userId: userIdSchema,
    postId: postIdSchema,
    url: { type: 'string', maxLength: 512 },
    contentDigest: sha256Schema,
  },
  required: ['id', 'category', 'actor', 'text', 'url', 'contentDigest'],
  additionalProperties: false,
}
const messageThreadSchema = {
  type: 'object',
  properties: {
    userId: userIdSchema,
    userName: { type: 'string', maxLength: 128 },
    profileUrl: { type: 'string', maxLength: 512 },
    lastMessage: { type: 'string', maxLength: 5_000 },
    lastMessageAt: { type: 'string', maxLength: 128 },
    unreadCount: { type: 'integer', minimum: 0 },
    url: { type: 'string', maxLength: 512 },
    contentDigest: sha256Schema,
  },
  required: [
    'userId',
    'userName',
    'profileUrl',
    'lastMessage',
    'unreadCount',
    'url',
    'contentDigest',
  ],
  additionalProperties: false,
}
const messageSchema = {
  type: 'object',
  properties: {
    id: opaqueIdSchema,
    userId: userIdSchema,
    senderId: userIdSchema,
    senderName: { type: 'string', maxLength: 128 },
    text: { type: 'string', maxLength: 5_000 },
    createdAt: { type: 'string', maxLength: 128 },
    mine: { type: 'boolean' },
    contentDigest: sha256Schema,
  },
  required: ['id', 'userId', 'senderId', 'text', 'mine', 'contentDigest'],
  additionalProperties: false,
}
const completeUsersResultSchema = {
  type: 'object',
  properties: {
    users: { type: 'array', maxItems: 50, items: userSchema },
    complete: { type: 'boolean' },
  },
  required: ['users', 'complete'],
  additionalProperties: false,
}

export const WEIBO_NETWORK_ORIGINS = Object.freeze([
  'https://weibo.com',
  'https://m.weibo.cn',
  'https://s.weibo.com',
  'https://passport.weibo.com',
  'https://h5.sinaimg.cn',
  'https://js.t.sinajs.cn',
  'https://img.t.sinajs.cn',
  'https://tvax1.sinaimg.cn',
  'https://tvax2.sinaimg.cn',
  'https://tvax3.sinaimg.cn',
  'https://tvax4.sinaimg.cn',
  'https://wx1.sinaimg.cn',
  'https://wx2.sinaimg.cn',
  'https://wx3.sinaimg.cn',
  'https://wx4.sinaimg.cn',
])

export const WEIBO_PLUGIN_ARTIFACT = Object.freeze({
  schemaVersion: 1,
  pluginType: 'managed-browser',
  id: WEIBO_PLUGIN_SLUG,
  version: WEIBO_PLUGIN_VERSION,
  driver: { id: WEIBO_DRIVER_ID, version: WEIBO_DRIVER_VERSION },
  account: { mode: 'required', contractVersion: 1 },
  accountState: {
    cookieDomains: [
      'weibo.com',
      'passport.weibo.com',
      'm.weibo.cn',
      'weibo.cn',
      's.weibo.com',
      'sina.com.cn',
      'login.sina.com.cn',
    ],
    origins: ['https://weibo.com', 'https://m.weibo.cn', 'https://passport.weibo.com'],
  },
  network: { origins: WEIBO_NETWORK_ORIGINS, methods: ['GET', 'POST', 'DELETE'] },
  actions: [
    {
      id: 'get_self',
      description: '读取当前微博账号的公开资料',
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
      id: 'get_user',
      description: '读取指定微博用户的公开资料',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { userId: userIdSchema },
        required: ['userId'],
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
      id: 'list_home_posts',
      description: '读取微博首页时间线中的近期微博',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
      result: postsResultSchema,
    },
    {
      id: 'list_user_posts',
      description: '读取指定用户公开主页中的近期微博',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { userId: userIdSchema, count: { type: 'integer', minimum: 1, maximum: 20 } },
        required: ['userId'],
        additionalProperties: false,
      },
      result: postsResultSchema,
    },
    {
      id: 'get_post',
      description: '读取指定微博正文和互动状态',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { userId: userIdSchema, postId: postIdSchema },
        required: ['userId', 'postId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { post: postSchema },
        required: ['post'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_comments',
      description: '读取指定微博当前页面可见的近期评论与回复',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['userId', 'postId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          comments: { type: 'array', maxItems: 50, items: commentSchema },
          complete: { type: 'boolean' },
        },
        required: ['comments', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'search_posts',
      description: '按关键词读取微博搜索结果；detailAvailable 标明是否带有可继续操作的精确作者身份',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          keyword: { type: 'string', minLength: 1, maxLength: 100 },
          count: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { posts: { type: 'array', maxItems: 20, items: searchPostSchema } },
        required: ['posts'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_unread_counts',
      description: '读取微博通知与私信的当前未读数量汇总；打开消息箱可能同步刷新网页红点',
      effect: 'read',
      timeoutSeconds: 120,
      params: { type: 'object', properties: {}, additionalProperties: false },
      result: {
        type: 'object',
        properties: {
          counts: {
            type: 'object',
            properties: {
              mentions: { type: 'integer', minimum: 0 },
              comments: { type: 'integer', minimum: 0 },
              likes: { type: 'integer', minimum: 0 },
              followers: { type: 'integer', minimum: 0 },
              privateMessages: { type: 'integer', minimum: 0 },
            },
            required: ['mentions', 'comments', 'likes', 'followers', 'privateMessages'],
            additionalProperties: false,
          },
          complete: { type: 'boolean' },
        },
        required: ['counts', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_notifications',
      description: '读取 @、评论、赞或新粉丝通知；打开消息页可能同步清除网页红点',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          category: notificationCategorySchema,
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['category'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          notifications: { type: 'array', maxItems: 50, items: notificationSchema },
          complete: { type: 'boolean' },
        },
        required: ['notifications', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_message_threads',
      description: '读取近期微博私信会话列表；私信属于非公开内容',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          threads: { type: 'array', maxItems: 50, items: messageThreadSchema },
          complete: { type: 'boolean' },
        },
        required: ['threads', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'get_message_thread',
      description: '读取与指定微博用户的近期私信正文；私信属于非公开内容',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['userId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          messages: { type: 'array', maxItems: 50, items: messageSchema },
          complete: { type: 'boolean' },
        },
        required: ['messages', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_followers',
      description: '读取当前账号或指定用户的近期粉丝列表',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      result: completeUsersResultSchema,
    },
    {
      id: 'list_following',
      description: '读取当前账号或指定用户的近期关注列表',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          count: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      result: completeUsersResultSchema,
    },
    {
      id: 'search_users',
      description: '按关键词搜索公开微博用户',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: {
          keyword: { type: 'string', minLength: 1, maxLength: 100 },
          count: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      result: completeUsersResultSchema,
    },
    {
      id: 'list_favorites',
      description: '读取当前账号近期收藏的微博',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          posts: { type: 'array', maxItems: 20, items: postSchema },
          complete: { type: 'boolean' },
        },
        required: ['posts', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_liked_posts',
      description: '读取当前账号近期赞过的微博',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 20 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          posts: { type: 'array', maxItems: 20, items: postSchema },
          complete: { type: 'boolean' },
        },
        required: ['posts', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'list_hot_searches',
      description: '读取微博公开热搜榜当前可见条目',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          searches: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                rank: { type: 'integer', minimum: 1, maximum: 100 },
                keyword: { type: 'string', minLength: 1, maxLength: 200 },
                url: { type: 'string', maxLength: 512 },
                hotValue: { type: 'integer', minimum: 0 },
                label: { type: 'string', maxLength: 64 },
              },
              required: ['rank', 'keyword', 'url'],
              additionalProperties: false,
            },
          },
          complete: { type: 'boolean' },
        },
        required: ['searches', 'complete'],
        additionalProperties: false,
      },
    },
    {
      id: 'create_post',
      description: '使用当前真实微博身份发布文字或图片微博（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 600,
      params: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 2_000 },
          images: { type: 'array', maxItems: 9, items: mediaPathSchema },
          mediaManifest: { type: 'array', maxItems: 9, items: sealedImageSchema },
        },
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { post: postSchema },
        required: ['post'],
        additionalProperties: false,
      },
    },
    {
      id: 'edit_post',
      description: '编辑自己已发布微博的正文（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 300,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 2_000 },
          editSnapshot: snapshotSchema,
        },
        required: ['userId', 'postId', 'text'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { post: postSchema },
        required: ['post'],
        additionalProperties: false,
      },
    },
    {
      id: 'delete_post',
      description: '永久删除自己发布的微博（不可撤销；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { userId: userIdSchema, postId: postIdSchema, deleteSnapshot: snapshotSchema },
        required: ['userId', 'postId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'create_comment',
      description: '评论指定微博（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
        required: ['userId', 'postId', 'text'],
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
      description: '回复指定微博评论（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          commentId: opaqueIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
        required: ['userId', 'postId', 'commentId', 'text'],
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
      description: '永久删除自己发表的微博评论或回复（不可撤销；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          commentId: opaqueIdSchema,
          deleteSnapshot: commentDeleteSnapshotSchema,
        },
        required: ['userId', 'postId', 'commentId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'repost_post',
      description: '转发指定微博并可附带文字（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          text: { type: 'string', maxLength: 1_000 },
        },
        required: ['userId', 'postId'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_post_like',
      description: '把指定微博点赞状态设置为已赞或未赞（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { userId: userIdSchema, postId: postIdSchema, liked: { type: 'boolean' } },
        required: ['userId', 'postId', 'liked'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_following',
      description: '把指定微博用户关注状态设置为已关注或未关注（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: { userId: userIdSchema, following: { type: 'boolean' } },
        required: ['userId', 'following'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'send_message',
      description: '向指定微博用户发送私信（私信属于非公开内容；默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          text: { type: 'string', minLength: 1, maxLength: 1_000 },
        },
        required: ['userId', 'text'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: { message: messageSchema },
        required: ['message'],
        additionalProperties: false,
      },
    },
    {
      id: 'set_post_favorite',
      description: '把指定微博收藏状态设置为已收藏或未收藏（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          favorited: { type: 'boolean' },
        },
        required: ['userId', 'postId', 'favorited'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
    {
      id: 'set_comment_like',
      description: '把指定微博评论点赞状态设置为已赞或未赞（默认逐次确认；账号授权后可免确认）',
      effect: 'write',
      timeoutSeconds: 180,
      params: {
        type: 'object',
        properties: {
          userId: userIdSchema,
          postId: postIdSchema,
          commentId: opaqueIdSchema,
          liked: { type: 'boolean' },
        },
        required: ['userId', 'postId', 'commentId', 'liked'],
        additionalProperties: false,
      },
      result: mutationResultSchema,
    },
  ],
} as const)

export const COMPILED_WEIBO_PLUGIN = compileRuntimePluginArtifact(WEIBO_PLUGIN_ARTIFACT)
if (COMPILED_WEIBO_PLUGIN.pluginType !== 'managed-browser')
  throw new Error('Weibo Plugin contract subtype mismatch')

/**
 * The production v1.4 account-state contract is unchanged in v1.5. No other
 * historical or user-published Weibo artifact is eligible for this upgrade.
 */
export const WEIBO_SETUP_COMPATIBLE_PREDECESSORS = Object.freeze([
  Object.freeze({
    version: '1.4.0',
    artifactHash: 'e43d0e981530dc05623fd3acf920356ef65b9a172df94c0c8f9f1c93f8a11f2c',
    execContractHash: '328f01e5e0018bfdb2ac69343c0d0e770cb672a3d917022b5efeeaf86eb952dc',
  }),
])

export function classifyWeiboSetupPin(input: {
  version: string
  artifactHash: string
  execContractHash: string
}): 'current' | 'compatible-predecessor' | null {
  if (
    input.version === WEIBO_PLUGIN_VERSION &&
    input.artifactHash === COMPILED_WEIBO_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_WEIBO_PLUGIN.execContractHash
  )
    return 'current'
  return WEIBO_SETUP_COMPATIBLE_PREDECESSORS.some(
    (pin) =>
      pin.version === input.version &&
      pin.artifactHash === input.artifactHash &&
      pin.execContractHash === input.execContractHash,
  )
    ? 'compatible-predecessor'
    : null
}

export function isOfficialWeiboPluginIdentity(input: {
  slug: string
  pluginType: string | null
  artifactHash: string
  execContractHash: string | null
  reviewSource: string | null
}): boolean {
  return (
    input.slug === WEIBO_PLUGIN_SLUG &&
    input.pluginType === 'managed-browser' &&
    input.artifactHash === COMPILED_WEIBO_PLUGIN.artifactHash &&
    input.execContractHash === COMPILED_WEIBO_PLUGIN.execContractHash &&
    input.reviewSource === 'platform'
  )
}

export const WEIBO_PLUGIN_CONTRACT: ManagedBrowserPluginContractV1 =
  COMPILED_WEIBO_PLUGIN.execContract

export const WEIBO_LOGIN_ORIGINS = Object.freeze([
  'https://weibo.com:443',
  'https://passport.weibo.com:443',
  'https://login.sina.com.cn:443',
  'https://v2.qr.weibo.cn:443',
  'https://visitor.passport.weibo.cn:443',
  'https://passport.sinaimg.cn:443',
  'https://a.sinaimg.cn:443',
  'https://h5.sinaimg.cn:443',
  'https://d.sinaimg.cn:443',
  'https://js.t.sinajs.cn:443',
  'https://i.sso.sina.com.cn:443',
  'https://static.geetest.com:443',
  'https://cstaticdun.126.net:443',
])
