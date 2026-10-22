/** Immutable platform artifact. No compiler import: the compiler pins this complete data hash. */
import { canonicalSha256Hex } from '../../connectors/spec/canonical.js'

export const LITERATURE_PLUGIN_SLUG = 'literature-db'
export const LITERATURE_PLUGIN_VERSION = '0.1.0'
export const LITERATURE_DRIVER_ID = 'builtin-jieyou-http'
export const LITERATURE_HTTP_TRANSPORT = 'jieyou-http-v1'
export const LITERATURE_HTTP_STATE_FORMAT = 'jieyou-http-cookies-v1'
export const LITERATURE_HTTP_ORIGINS = [
  'http://www.jieyoutsg.com:80',
  'https://www.jieyoutsg.com:443',
] as const
const opaqueId = {
  type: 'string',
  pattern: '^[A-Za-z0-9-]{16,128}$',
  minLength: 16,
  maxLength: 128,
} as const
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export const LITERATURE_PLUGIN_ARTIFACT = freeze({
  schemaVersion: 1,
  pluginType: 'managed-browser',
  id: LITERATURE_PLUGIN_SLUG,
  version: LITERATURE_PLUGIN_VERSION,
  driver: { id: LITERATURE_DRIVER_ID, version: LITERATURE_PLUGIN_VERSION },
  account: { mode: 'required', contractVersion: 1 },
  accountState: {
    cookieDomains: ['jieyoutsg.com', 'www.jieyoutsg.com'],
    origins: LITERATURE_HTTP_ORIGINS,
  },
  network: { origins: LITERATURE_HTTP_ORIGINS, methods: ['GET', 'POST'] },
  actions: [
    {
      id: 'search',
      description: '检索已授权文献数据库，返回有界结果与私有文献编号。',
      effect: 'read',
      timeoutSeconds: 60,
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 256 },
          page: { type: 'integer', minimum: 1, maximum: 10000 },
          pageSize: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                documentId: opaqueId,
                title: { type: 'string', maxLength: 512 },
                authors: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 128 } },
                year: { type: 'integer', minimum: 1500, maximum: 2100 },
                source: { type: 'string', maxLength: 128 },
                snippet: { type: 'string', maxLength: 2048 },
              },
              required: ['documentId', 'title'],
              additionalProperties: false,
            },
          },
          nextPage: { type: 'integer', minimum: 0, maximum: 10000 },
        },
        required: ['items', 'nextPage'],
        additionalProperties: false,
      },
    },
    {
      id: 'download',
      description: '下载本账号检索结果中的一篇文献，返回平台文件编号。',
      effect: 'read',
      timeoutSeconds: 120,
      params: {
        type: 'object',
        properties: { documentId: opaqueId },
        required: ['documentId'],
        additionalProperties: false,
      },
      result: {
        type: 'object',
        properties: {
          artifactId: opaqueId,
          filename: { type: 'string', minLength: 1, maxLength: 256 },
          mimeType: { type: 'string', enum: ['application/pdf'] },
          bytes: { type: 'integer', minimum: 1, maximum: 26214400 },
        },
        required: ['artifactId', 'filename', 'mimeType', 'bytes'],
        additionalProperties: false,
      },
    },
  ],
} as const)
export const LITERATURE_PLUGIN_ARTIFACT_HASH = canonicalSha256Hex(LITERATURE_PLUGIN_ARTIFACT)
