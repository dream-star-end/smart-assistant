/**
 * ocConnectorsClient — 容器内应用连接器 CLI(oc-connect)的 master 调用传输层。
 *
 * 照 ocResearchClient 范式:读容器身份 bearer(OPENCLAUDE_V3_CONTAINER_TOKEN[_FILE])
 * + master base(OPENCLAUDE_V3_MASTER_BASE_URL),POST master 的
 * `/v3/connectors/{catalog|list|call}`。**第三方凭据 / 平台 token 全留 master,容器只带自己的
 * 身份 bearer——客户端本来就拿不到任何第三方凭据。** 故本层永不打印上游 body/headers/URL
 * (防泄漏),只把传输/HTTP 故障映射成稳定错误码(ConnectorError.code)。
 *
 * 注意:RPC 契约里 `{kind:'error', code}` 是一次 **正常 200 响应**(业务错误),由上层 CLI
 * 解析 kind 处理;只有真正的传输层/HTTP 失败才在此抛 ConnectorError。
 */
import { readFileSync } from 'node:fs'

// 稳定错误码(绝不含上游明文/凭据;只暴露非敏感上下文如 HTTP 状态数)。
export const CONNECTOR_RPC_TIMEOUT = 'CONNECTOR_RPC_TIMEOUT'
export const CONNECTOR_RPC_NETWORK = 'CONNECTOR_RPC_NETWORK'
export const CONNECTOR_RPC_HTTP = 'CONNECTOR_RPC_HTTP'
export const CONNECTOR_BAD_RESPONSE = 'CONNECTOR_BAD_RESPONSE'
export const CONNECTOR_NO_MASTER_BASE = 'CONNECTOR_NO_MASTER_BASE'
export const CONNECTOR_NO_CONTAINER_TOKEN = 'CONNECTOR_NO_CONTAINER_TOKEN'

export type ConnectorOp = 'list' | 'call' | 'catalog'

/** 传输层错误:message 只承载稳定码 + 可安全展示的非敏感细节(如 HTTP 状态数)。 */
export class ConnectorError extends Error {
  readonly code: string
  constructor(code: string, detail?: string) {
    super(detail ? `${code} ${detail}` : code)
    this.name = 'ConnectorError'
    this.code = code
  }
}

export interface ConnectorCallOptions {
  env?: NodeJS.ProcessEnv
  /** 注入 fetch(测试用);默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 请求总超时(含 body 读取)。默认 75s——略高于后端 60s 总时限,让后端自身错误优先返回。 */
  timeoutMs?: number
}

/** 读容器身份 bearer;缺失 → ConnectorError(CONNECTOR_NO_CONTAINER_TOKEN)。 */
export function readContainerToken(env: NodeJS.ProcessEnv = process.env): string {
  const tok = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (tok) return tok
  const file = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
  if (file) {
    try {
      const fromFile = readFileSync(file, 'utf8').trim()
      if (fromFile) return fromFile
    } catch {
      throw new ConnectorError(CONNECTOR_NO_CONTAINER_TOKEN)
    }
  }
  throw new ConnectorError(CONNECTOR_NO_CONTAINER_TOKEN)
}

/** 解析 master base(去尾 /);缺失 → ConnectorError(CONNECTOR_NO_MASTER_BASE)。 */
export function resolveMasterBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base) throw new ConnectorError(CONNECTOR_NO_MASTER_BASE)
  return base.replace(/\/+$/, '')
}

/**
 * POST /v3/connectors/<op>,带容器 bearer,返回解析后的 JSON body。
 * 非 2xx / 网络失败 / 超时 / body 非 JSON → ConnectorError(稳定码,不透传上游内容)。
 */
export async function callConnectors(
  op: ConnectorOp,
  body: unknown,
  opts: ConnectorCallOptions = {},
): Promise<any> {
  const env = opts.env ?? process.env
  const doFetch = opts.fetchImpl ?? fetch
  const base = resolveMasterBase(env)
  const token = readContainerToken(env)
  const url = `${base}/v3/connectors/${op}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 75_000)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    })
    if (!res.ok) {
      // 上游错误 body/headers/URL 全吞,只暴露非敏感 HTTP 状态数。
      throw new ConnectorError(CONNECTOR_RPC_HTTP, String(res.status))
    }
    const text = await res.text()
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new ConnectorError(CONNECTOR_BAD_RESPONSE)
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw err
    if (ctl.signal.aborted) throw new ConnectorError(CONNECTOR_RPC_TIMEOUT)
    throw new ConnectorError(CONNECTOR_RPC_NETWORK)
  } finally {
    clearTimeout(timer)
  }
}
