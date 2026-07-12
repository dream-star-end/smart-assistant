/**
 * 默认连接器 · Notion(static-token)。
 *
 * 真实 Notion API:Bearer 集成 token + 必带 `Notion-Version` 头。whoami=GET /v1/users/me 返回
 * bot 用户({id, bot:{workspace_name}}),用作 identity probe 派生账号。read 动作示例:检索页面/
 * 数据库、查询数据库(POST 但只读 → reviewer 签 safe-read-non-get)。
 *
 * 这是**声明层数据**(可过审、拿不到凭据);seed 机制据此建 listing+version 并由 reviewer 编译签名
 * 成 exec_contract。SecurityDecision 是"若由 reviewer 批准时的受众/effect 结论"随附给 seed。
 */

import type { DefaultConnector } from './types.js'

const NOTION_VERSION = '2022-06-28'
const API_ORIGIN = 'https://api.notion.com:443'

export const notionDefault: DefaultConnector = {
  featured: true,
  category: 'productivity',
  spec: {
    id: 'notion',
    label: 'Notion',
    description: 'Notion 集成:检索/查询页面与数据库(需在 Notion 侧创建集成并授权页面)。',
    authMode: 'static-token',
    auth: {
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [{ id: 'api-token', authMode: 'static-token', subject: 'user', audience: 'api' }],
    },
    identity: {
      probeActionId: 'whoami',
      accountKeyPointer: '/id',
      accountHintPointer: '/bot/workspace_name',
    },
    actions: [
      {
        id: 'whoami',
        description: '返回当前集成 bot 的身份(identity probe)。',
        request: {
          method: 'GET',
          pathTemplate: '/v1/users/me',
          staticHeaders: { 'Notion-Version': NOTION_VERSION },
        },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            bot: {
              type: 'object',
              additionalProperties: false,
              properties: { workspace_name: { type: 'string' } },
            },
          },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'retrieve_page',
        description: '按 pageId 检索一个页面。',
        request: {
          method: 'GET',
          pathTemplate: '/v1/pages/{/params/pageId}',
          staticHeaders: { 'Notion-Version': NOTION_VERSION },
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { pageId: { type: 'string' } },
          required: ['pageId'],
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            url: { type: 'string' },
            created_time: { type: 'string' },
            last_edited_time: { type: 'string' },
            archived: { type: 'boolean' },
            properties: { type: 'object', additionalProperties: true },
          },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'query_database',
        description: '查询一个数据库(POST 但只读)。',
        request: {
          method: 'POST',
          pathTemplate: '/v1/databases/{/params/databaseId}/query',
          staticHeaders: { 'Notion-Version': NOTION_VERSION },
          bodyTemplate: {
            obj: {
              page_size: { ref: '/params/pageSize' },
              start_cursor: { ref: '/params/startCursor' },
            },
          },
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: {
            databaseId: { type: 'string' },
            pageSize: { type: 'integer' },
            startCursor: { type: 'string' },
          },
          required: ['databaseId'],
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            object: { type: 'string' },
            has_more: { type: 'boolean' },
            next_cursor: { type: 'string' },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        usesSlot: 'api-token',
      },
    ],
  },
  decision: {
    audience: {
      authorizationOrigins: [],
      tokenOrigins: [],
      apiOrigins: [API_ORIGIN],
      unauthenticatedUploadOrigins: [],
    },
    // POST /v1/databases/:id/query 是只读查询 → reviewer 签 safe-read-non-get。
    actions: { query_database: { safeReadNonGet: true } },
  },
}
