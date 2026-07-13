/**
 * 默认连接器 · 飞书 Feishu(token-exchange:应用凭据换 tenant_access_token)。
 *
 * 真实飞书:POST /open-apis/auth/v3/tenant_access_token/internal(JSON {app_id, app_secret})→
 * {code, tenant_access_token, expire};API 带 Bearer tenant_access_token。identity probe=
 * GET /open-apis/bot/v3/info → {bot:{open_id, app_name}}。
 *
 * 注:飞书 API 端点/响应形状按公开文档最佳努力编写,上真实 app 凭据后需按实测校准(声明式数据,
 * 可 republish 纠正)。用户 bind 时填 app_id/app_secret,引擎向 token 受众换 token,凭据永不进容器。
 * read 动作:bot_info(identity probe)、list_chats;write 动作:send_message(POST /open-apis/im/v1/messages,
 * 走 propose-then-commit 确认门,与 v1 feishu 发消息对等)。
 */

import type { DefaultConnector } from './types.js'

const ORIGIN = 'https://open.feishu.cn:443'

export const feishuDefault: DefaultConnector = {
  featured: true,
  category: 'daily-tools',
  useCases: ['让 AI 读取飞书会话，并在逐次确认后发送消息'],
  tags: ['连接器', '飞书', '沟通'],
  spec: {
    id: 'feishu',
    label: '飞书',
    description: '飞书自建应用:用 app_id/app_secret 换取租户凭据,读取机器人信息与会话。',
    authMode: 'token-exchange',
    auth: {
      exchangeRequest: {
        method: 'POST',
        path: '/open-apis/auth/v3/tenant_access_token/internal',
        encoding: 'json',
        credentialFieldNames: { app_id: 'client_id', app_secret: 'client_secret' },
        staticFields: {},
      },
      tokenResponse: { successPredicate: '/code' },
      tokenOutputs: { accessToken: '/tenant_access_token', expiresIn: '/expire' },
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [
        { id: 'tenant-token', authMode: 'token-exchange', subject: 'app', audience: 'token' },
        {
          id: 'api-cred',
          authMode: 'token-exchange',
          subject: 'app',
          audience: 'api',
          dependsOn: ['tenant-token'],
        },
      ],
    },
    identity: {
      probeActionId: 'bot_info',
      accountKeyPointer: '/bot/open_id',
      accountHintPointer: '/bot/app_name',
    },
    actions: [
      {
        id: 'bot_info',
        description: '机器人信息(identity probe)。',
        request: { method: 'GET', pathTemplate: '/open-apis/bot/v3/info' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'integer' },
            bot: {
              type: 'object',
              additionalProperties: false,
              properties: {
                open_id: { type: 'string' },
                app_name: { type: 'string' },
                avatar_url: { type: 'string' },
                activate_status: { type: 'integer' },
              },
            },
          },
        },
        usesSlot: 'api-cred',
      },
      {
        id: 'list_chats',
        description: '机器人所在群列表。',
        request: {
          method: 'GET',
          pathTemplate: '/open-apis/im/v1/chats',
          query: { page_size: '/params/pageSize', page_token: '/params/pageToken' },
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { pageSize: { type: 'integer' }, pageToken: { type: 'string' } },
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'integer' },
            data: {
              type: 'object',
              additionalProperties: false,
              properties: {
                has_more: { type: 'boolean' },
                page_token: { type: 'string' },
                items: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
          },
        },
        usesSlot: 'api-cred',
      },
      {
        id: 'send_message',
        description: '向指定会话/用户发送消息(写操作,需用户确认)。',
        request: {
          method: 'POST',
          pathTemplate: '/open-apis/im/v1/messages',
          // receive_id_type 决定 receive_id 语义(chat_id / open_id / user_id 等)。
          query: { receive_id_type: '/params/receiveIdType' },
          // content 为飞书要求的 JSON 序列化字符串(如 {"text":"hi"}),由调用方预先序列化后传入。
          bodyTemplate: {
            obj: {
              receive_id: { ref: '/params/receiveId' },
              msg_type: { ref: '/params/msgType' },
              content: { ref: '/params/content' },
            },
          },
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: {
            receiveIdType: { type: 'string' },
            receiveId: { type: 'string' },
            msgType: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['receiveIdType', 'receiveId', 'msgType', 'content'],
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'integer' },
            data: {
              type: 'object',
              additionalProperties: false,
              properties: { message_id: { type: 'string' }, msg_type: { type: 'string' } },
            },
          },
        },
        usesSlot: 'api-cred',
      },
    ],
  },
  decision: {
    audience: {
      authorizationOrigins: [],
      tokenOrigins: [ORIGIN],
      apiOrigins: [ORIGIN],
      unauthenticatedUploadOrigins: [],
    },
    actions: { send_message: { effect: 'send' } },
  },
}
