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
import { homedir } from 'node:os'
import { join } from 'node:path'

// 稳定错误码(绝不含上游明文/凭据;只暴露非敏感上下文如 HTTP 状态数)。
export const CONNECTOR_RPC_TIMEOUT = 'CONNECTOR_RPC_TIMEOUT'
export const CONNECTOR_RPC_NETWORK = 'CONNECTOR_RPC_NETWORK'
export const CONNECTOR_RPC_HTTP = 'CONNECTOR_RPC_HTTP'
export const CONNECTOR_BAD_RESPONSE = 'CONNECTOR_BAD_RESPONSE'
export const CONNECTOR_NO_MASTER_BASE = 'CONNECTOR_NO_MASTER_BASE'
export const CONNECTOR_NO_CONTAINER_TOKEN = 'CONNECTOR_NO_CONTAINER_TOKEN'

export type ConnectorOp = 'list' | 'call' | 'catalog'
export type ConnectorRpcSurface = 'connectors' | 'plugins'

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
  /** 注入文件读取(测试用);默认 readFileSync。 */
  readFile?: FileReader
  /** 请求总超时(含 body 读取)。Plugin 媒体写最长 12min；普通连接器仍为 75s。 */
  timeoutMs?: number
  /** Historical default is connectors; oc-plugin selects the canonical plugins alias. */
  surface?: ConnectorRpcSurface
}

type FileReader = (path: string, encoding: BufferEncoding) => string

interface ConnectorEndpoint {
  masterBaseUrl: string
  containerToken: string
}

function readContainerTokenIfAvailable(
  env: NodeJS.ProcessEnv,
  readFile: FileReader,
): string | null {
  const tok = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (tok) return tok
  const file = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
  if (!file) return null
  try {
    return readFile(file, 'utf8').trim() || null
  } catch {
    return null
  }
}

function readContainerAuthFile(
  env: NodeJS.ProcessEnv,
  readFile: FileReader,
): ConnectorEndpoint | null {
  const openclaudeHome =
    env.OPENCLAUDE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.openclaude')
  try {
    const parsed: unknown = JSON.parse(
      readFile(join(openclaudeHome, 'container-auth.json'), 'utf8'),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const masterBaseUrl = (parsed as Record<string, unknown>).masterBaseUrl
    const containerToken = (parsed as Record<string, unknown>).containerToken
    if (typeof masterBaseUrl !== 'string' || typeof containerToken !== 'string') return null
    const base = masterBaseUrl.trim()
    const token = containerToken.trim()
    if (!base || !token) return null
    return { masterBaseUrl: base.replace(/\/+$/, ''), containerToken: token }
  } catch {
    return null
  }
}

/** 读容器身份 bearer;缺失 → ConnectorError(CONNECTOR_NO_CONTAINER_TOKEN)。 */
export function readContainerToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = readContainerTokenIfAvailable(env, readFileSync)
  if (token) return token
  throw new ConnectorError(CONNECTOR_NO_CONTAINER_TOKEN)
}

/** 解析 master base(去尾 /);缺失 → ConnectorError(CONNECTOR_NO_MASTER_BASE)。 */
export function resolveMasterBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base) throw new ConnectorError(CONNECTOR_NO_MASTER_BASE)
  return base.replace(/\/+$/, '')
}

/**
 * 解析连接器 RPC 的容器身份。CCB 直接使用 supervisor env；Codex 子进程按安全策略
 * 清空 OPENCLAUDE_* 后，整体回退 entrypoint 每次启动成对写入的 container-auth.json。
 * 两个字段必须来自同一通道，禁止把 env 与文件内容拼成一对。
 */
export function resolveConnectorEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  readFile: FileReader = readFileSync,
): ConnectorEndpoint {
  const directBase = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const directToken = readContainerTokenIfAvailable(env, readFile)
  if (directBase && directToken) {
    return {
      masterBaseUrl: directBase.replace(/\/+$/, ''),
      containerToken: directToken,
    }
  }

  const fromFile = readContainerAuthFile(env, readFile)
  if (fromFile) return fromFile
  if (!directBase) throw new ConnectorError(CONNECTOR_NO_MASTER_BASE)
  throw new ConnectorError(CONNECTOR_NO_CONTAINER_TOKEN)
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
  const endpoint = resolveConnectorEndpoint(env, opts.readFile ?? readFileSync)
  const url = `${endpoint.masterBaseUrl}/v3/${opts.surface ?? 'connectors'}/${op}`
  const ctl = new AbortController()
  const defaultTimeoutMs = (opts.surface ?? 'connectors') === 'plugins' ? 720_000 : 75_000
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? defaultTimeoutMs)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.containerToken}`,
        'content-type': 'application/json',
      },
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
