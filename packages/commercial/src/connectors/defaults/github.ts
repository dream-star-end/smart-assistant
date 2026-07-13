/**
 * 默认连接器 · GitHub(static-token:Personal Access Token,classic 或 fine-grained 均可)。
 *
 * 真实 GitHub REST:`Authorization: Bearer <PAT>` + 必带 `User-Agent`(缺则 403)+ 建议
 * `Accept: application/vnd.github+json` 与 `X-GitHub-Api-Version`。whoami=GET /user →
 * {id, login, ...},用作 identity probe(id 稳定数字 → account_key,login → hint)。read 动作:
 * 列出用户仓库(顶层数组)、按 owner/repo 取单仓。
 *
 * 这是**声明层数据**(可过审、拿不到凭据);用户 bind 时填 PAT,引擎仅在 origin ∈ api 受众时
 * 以 Bearer 注入,凭据永不进容器。GitHub API 端点/字段来自公开稳定文档,可直接使用。
 */

import type { DefaultConnector } from './types.js'

const API_ORIGIN = 'https://api.github.com:443'
// GitHub 三件套静态头:UA 必带,Accept/版本头锁定稳定媒体类型与 API 版本。
const GH_HEADERS = {
  'User-Agent': 'OpenClaude-Connector',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const

export const githubDefault: DefaultConnector = {
  featured: true,
  category: 'coding-dev',
  useCases: ['让 AI 查询当前账号可见的 GitHub 仓库与仓库信息'],
  tags: ['连接器', 'GitHub', '开发'],
  spec: {
    id: 'github',
    label: 'GitHub',
    description: 'GitHub 集成:用个人访问令牌(PAT)读取账号信息与仓库(只读)。',
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
      accountHintPointer: '/login',
    },
    actions: [
      {
        id: 'whoami',
        description: '返回当前令牌对应的 GitHub 用户(identity probe)。',
        request: { method: 'GET', pathTemplate: '/user', staticHeaders: { ...GH_HEADERS } },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer' },
            login: { type: 'string' },
            name: { type: 'string' },
            html_url: { type: 'string' },
            type: { type: 'string' },
            company: { type: 'string' },
            public_repos: { type: 'integer' },
          },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'list_repos',
        description: '列出当前用户可见的仓库。',
        request: {
          method: 'GET',
          pathTemplate: '/user/repos',
          staticHeaders: { ...GH_HEADERS },
          query: {
            per_page: '/params/perPage',
            page: '/params/page',
            sort: '/params/sort',
            visibility: '/params/visibility',
          },
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: {
            perPage: { type: 'integer' },
            page: { type: 'integer' },
            sort: { type: 'string' },
            visibility: { type: 'string' },
          },
        },
        result: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              name: { type: 'string' },
              full_name: { type: 'string' },
              private: { type: 'boolean' },
              html_url: { type: 'string' },
              description: { type: 'string' },
              fork: { type: 'boolean' },
              language: { type: 'string' },
              default_branch: { type: 'string' },
              stargazers_count: { type: 'integer' },
              open_issues_count: { type: 'integer' },
              updated_at: { type: 'string' },
            },
          },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'get_repo',
        description: '按 owner/repo 取单个仓库信息。',
        request: {
          method: 'GET',
          pathTemplate: '/repos/{/params/owner}/{/params/repo}',
          staticHeaders: { ...GH_HEADERS },
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { owner: { type: 'string' }, repo: { type: 'string' } },
          required: ['owner', 'repo'],
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            full_name: { type: 'string' },
            private: { type: 'boolean' },
            html_url: { type: 'string' },
            description: { type: 'string' },
            default_branch: { type: 'string' },
            stargazers_count: { type: 'integer' },
            forks_count: { type: 'integer' },
            open_issues_count: { type: 'integer' },
            pushed_at: { type: 'string' },
            updated_at: { type: 'string' },
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
    actions: {},
  },
}
