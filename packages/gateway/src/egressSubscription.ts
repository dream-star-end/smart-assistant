import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { Agent, fetch as undiciFetch } from 'undici'

const execFileAsync = promisify(execFile)

const DEFAULT_SUBSCRIPTION_SCRIPT = '/opt/openclaude/ops/update-openclaude-egress-subscription.py'
const DEFAULT_CONFIG_PATH = '/etc/sing-box/openclaude-egress-proxy.json'
const DEFAULT_META_PATH = '/etc/sing-box/openclaude-egress-proxy.meta'
const DEFAULT_SERVICE = 'openclaude-egress.service'
const DEFAULT_LISTEN = '127.0.0.1'
const DEFAULT_PORT = 18991
const DEFAULT_TEST_PORT_BASE = 19132
const DEFAULT_SING_BOX = '/usr/local/bin/sing-box'
const DEFAULT_CURL = '/usr/bin/curl'
const MAX_TEST_IDXS = 20
const TEST_CONCURRENCY = 3
const DIRECT_FETCH_DISPATCHER = new Agent()
const PROXY_ENV_KEYS_TO_STRIP = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const

// ── slice ③: 主备 selector + clash_api 无重启切换 ──
// 出站不再是"单节点 route.final=proxy",而是一个 `proxy` selector 指向 node-a(主)/
// node-b(备)两个具名候选 + direct。切换 = clash_api PUT(不重启);watchdog 靠此做
// 异常自动切换。命名稳定(node-a/node-b)以便 cache_file store_selected 跨重启/刷新
// 保持选中。
const SELECTOR_TAG = 'proxy'
const PRIMARY_TAG = 'node-a'
const BACKUP_TAG = 'node-b'
const DIRECT_TAG = 'direct'
const DEFAULT_CLASH_LISTEN = '127.0.0.1'
// 避开商业版 clash_api(19095);个人版独占 19096
const DEFAULT_CLASH_PORT = 19096
// cache_file:持久化 selector 选中(sing-box 1.13 启用即默认持久化)。root 起的 sing-box 可写;
// 目录不存在则降级为不写 cache_file(不持久化,但不影响出海)
const DEFAULT_CACHE_FILE = '/var/lib/openclaude-egress/clash.db'
// 无重启切换时不主动掐断在途连接(任务要求 false),由上层客户端自然重连/重试
const SELECTOR_INTERRUPT_EXISTING = false
// Claude Code 自动更新的下载域名必须直连,否则更新流量灌进出海代理形成黑洞
// (memory: personal-proxy-traffic-autoupdate-loop)。历史 landmine:buildConfig 每次
// 刷新/切换都整写 route,曾把这条直连规则抹掉。现在做成模板常量由 buildRoute() 每次
// 注入,刷新/切换永不再丢 —— 根治。
const ROUTE_DIRECT_DOMAIN_SUFFIXES = ['downloads.claude.ai', 'storage.googleapis.com'] as const

interface EgressOptions {
  env?: NodeJS.ProcessEnv
  gatewayPort?: number
}

interface EgressSettings {
  subscriptionUrl?: string
  subscriptionScript: string
  configPath: string
  metaPath: string
  service: string
  listen: string
  port: number
  testListen: string
  testPortBase: number
  singBoxPath: string
  curlPath: string
  mutationsEnabled: boolean
  mutationDisabledReason?: string
  clashListen: string
  clashPort: number
  clashSecretSeed?: string
  cacheFile: string
}

export interface EgressNodePublic {
  idx: number
  name: string
  scheme: string
  server?: string
  port?: number
  transport?: string
  security?: string
  supported: boolean
  active: boolean
  error?: string
}

interface EgressNodeInternal extends EgressNodePublic {
  uri: string
  uuid?: string
  sni?: string
  wsHost?: string
  path?: string
  fingerprint?: string
  flow?: string
  realityPublicKey?: string
  realityShortId?: string
}

export interface EgressHealth {
  healthy: boolean
  anthropicCode: string
  anthropicMs: number
  cfCode: string
  cfMs: number
  scoreMs: number
  ip?: string
  org?: string
  city?: string
  country?: string
  error?: string
}

interface EgressMeta {
  idx?: number
  name?: string
  server?: string
  sni?: string
  ws_host?: string
  path?: string
  updated_at?: string
  [key: string]: string | number | boolean | undefined
}

export interface EgressStatus {
  configured: boolean
  subscriptionConfigured: boolean
  mutationsEnabled: boolean
  mutationDisabledReason?: string
  localProxy: string
  service: {
    name: string
    active: boolean
  }
  active?: {
    idx?: number
    name?: string
    server?: string
    updatedAt?: string
    health?: Partial<EgressHealth>
    // 备节点(node-b);无备时 undefined。selector 升级后补充,老单节点为 undefined
    standby?: {
      idx?: number
      name?: string
      server?: string
    }
    // 活跃权威 = clash_api selector.now(watchdog/前端切换都改它);读不到为 undefined
    activeTag?: string
  }
}

export interface EgressTestResult {
  idx: number
  health?: EgressHealth
  error?: string
}

export class EgressHttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'EgressHttpError'
  }
}

let installInFlight = false

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim()
  return raw || fallback
}

function envAbsolutePath(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim()
  return raw && isAbsolute(raw) ? raw : fallback
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return false
}

function withoutProxyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of PROXY_ENV_KEYS_TO_STRIP) delete out[key]
  return out
}

function isValidServiceName(name: string): boolean {
  return /^[A-Za-z0-9_.@-]+\.service$/.test(name)
}

function readSubscriptionUrlFromScript(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined
  try {
    const text = readFileSync(path, 'utf-8')
    const m = text.match(
      /SUB_URL\s*=\s*os\.environ\.get\(\s*["']OC_EGRESS_SUB_URL["']\s*,\s*["']([^"']+)["']\s*\)/,
    )
    return m?.[1]
  } catch {
    return undefined
  }
}

function defaultMutationsEnabled(
  env: NodeJS.ProcessEnv,
  gatewayPort?: number,
): {
  enabled: boolean
  reason?: string
} {
  const explicit = envBool(env.OC_EGRESS_UI_MUTATIONS)
  if (explicit !== undefined) {
    return explicit
      ? { enabled: true }
      : { enabled: false, reason: 'OC_EGRESS_UI_MUTATIONS disabled mutations' }
  }
  const home = env.OPENCLAUDE_HOME || ''
  if (gatewayPort === 18790 || /(?:^|\/)\.openclaude-dev\/?$/.test(home)) {
    return { enabled: false, reason: 'disabled on dev instance by default' }
  }
  return { enabled: true }
}

export function resolveEgressSettings(opts: EgressOptions = {}): EgressSettings {
  const env = opts.env ?? process.env
  const subscriptionScript = envAbsolutePath(env, 'OC_EGRESS_SCRIPT', DEFAULT_SUBSCRIPTION_SCRIPT)
  const rawService = envString(env, 'OC_EGRESS_SERVICE', DEFAULT_SERVICE)
  const mutation = defaultMutationsEnabled(env, opts.gatewayPort)
  const subscriptionUrl =
    env.OC_EGRESS_SUB_URL?.trim() || readSubscriptionUrlFromScript(subscriptionScript)
  return {
    subscriptionUrl,
    subscriptionScript,
    configPath: envAbsolutePath(env, 'OC_EGRESS_CONFIG', DEFAULT_CONFIG_PATH),
    metaPath: envAbsolutePath(env, 'OC_EGRESS_META', DEFAULT_META_PATH),
    service: isValidServiceName(rawService) ? rawService : DEFAULT_SERVICE,
    listen: envString(env, 'OC_EGRESS_LISTEN', DEFAULT_LISTEN),
    port: envInt(env, 'OC_EGRESS_PORT', DEFAULT_PORT),
    testListen: DEFAULT_LISTEN,
    testPortBase: envInt(env, 'OC_EGRESS_TEST_PORT_BASE', DEFAULT_TEST_PORT_BASE),
    singBoxPath: envAbsolutePath(env, 'OC_EGRESS_SING_BOX', DEFAULT_SING_BOX),
    curlPath: envAbsolutePath(env, 'OC_EGRESS_CURL', DEFAULT_CURL),
    mutationsEnabled: mutation.enabled,
    mutationDisabledReason: mutation.reason,
    clashListen: DEFAULT_CLASH_LISTEN,
    clashPort: envInt(env, 'OC_EGRESS_CLASH_PORT', DEFAULT_CLASH_PORT),
    clashSecretSeed: env.OC_EGRESS_CLASH_SECRET?.trim() || undefined,
    cacheFile: envAbsolutePath(env, 'OC_EGRESS_CACHE_FILE', DEFAULT_CACHE_FILE),
  }
}

export function redactEgressError(err: unknown): string {
  if (err instanceof EgressHttpError) return redactSecrets(err.message)
  const msg = err instanceof Error ? err.message : String(err)
  return redactSecrets(msg || 'egress proxy operation failed')
}

function redactSecrets(msg: string): string {
  return msg
    .replace(/vless:\/\/\S+/gi, '[redacted-node-uri]')
    .replace(/([?&](?:pbk|sid|sni)=)[^&\s)]+/gi, '$1[redacted]')
    .replace(
      /("?(?:public_key|short_id|server_name|sni)"?\s*[:=]\s*")([^"]+)(")/gi,
      '$1[redacted]$3',
    )
    .replace(/((?:public_key|short_id|server_name|sni)\s*[:=]\s*)([^\s,}]+)/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[redacted-uuid]',
    )
}

function decodeMaybeBase64(raw: string): string {
  const compact = raw.trim().replace(/\s+/g, '')
  if (!compact) return ''
  try {
    const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf-8')
    if (decoded.includes('://')) return decoded
  } catch {}
  return raw
}

export function decodeSubscriptionLines(raw: string | Buffer): string[] {
  const text = decodeMaybeBase64(Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw)
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function one(params: URLSearchParams, key: string, fallback = ''): string {
  return params.get(key) || fallback
}

function parseNode(uri: string, idx: number): EgressNodeInternal {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return {
      idx,
      uri,
      name: `节点 ${idx}`,
      scheme: 'unknown',
      supported: false,
      active: false,
      error: 'invalid uri',
    }
  }
  const scheme = parsed.protocol.replace(/:$/, '')
  const name = decodeURIComponent(parsed.hash ? parsed.hash.slice(1) : `节点 ${idx}`)
  const server = parsed.hostname || undefined
  const port = parsed.port ? Number(parsed.port) : undefined
  const rawTransport = one(parsed.searchParams, 'type') || undefined
  const security = one(parsed.searchParams, 'security') || undefined
  const transport = rawTransport || (security === 'reality' ? 'tcp' : undefined)
  const node: EgressNodeInternal = {
    idx,
    uri,
    name,
    scheme,
    server,
    port,
    transport,
    security,
    supported: false,
    active: false,
  }
  if (scheme !== 'vless') {
    node.error = `unsupported scheme: ${scheme}`
    return node
  }
  const uuid = decodeURIComponent(parsed.username || '')
  if (!uuid || !server) {
    node.error = 'missing uuid or server'
    return node
  }
  if (security === 'reality') {
    if (transport !== 'tcp') {
      node.error = `unsupported transport/security: ${transport || '-'}+${security}`
      return node
    }
    const sni = one(parsed.searchParams, 'sni')
    const realityPublicKey = one(parsed.searchParams, 'pbk')
    if (!sni || !realityPublicKey) {
      node.error = 'missing reality sni or public key'
      return node
    }
    node.supported = true
    node.uuid = uuid
    node.port = port || 443
    node.sni = sni
    node.fingerprint = one(parsed.searchParams, 'fp') || 'chrome'
    node.flow = one(parsed.searchParams, 'flow') || undefined
    node.realityPublicKey = realityPublicKey
    node.realityShortId = one(parsed.searchParams, 'sid') || undefined
    return node
  }
  if (transport !== 'ws' || security !== 'tls') {
    node.error = `unsupported transport/security: ${transport || '-'}+${security || '-'}`
    return node
  }
  node.supported = true
  node.uuid = uuid
  node.port = port || 443
  node.sni = one(parsed.searchParams, 'sni') || one(parsed.searchParams, 'host') || server
  node.wsHost = one(parsed.searchParams, 'host') || node.sni
  node.path = decodeURIComponent(one(parsed.searchParams, 'path') || '/')
  node.fingerprint = one(parsed.searchParams, 'fp') || 'chrome'
  return node
}

export function parseSubscriptionNodes(lines: string[], activeIdx?: number): EgressNodePublic[] {
  return parseSubscriptionNodesInternal(lines, activeIdx).map(publicNode)
}

function parseSubscriptionNodesInternal(lines: string[], activeIdx?: number): EgressNodeInternal[] {
  return lines.map((line, i) => {
    const node = parseNode(line, i + 1)
    node.active = node.idx === activeIdx
    return node
  })
}

function publicNode(node: EgressNodeInternal): EgressNodePublic {
  return {
    idx: node.idx,
    name: node.name,
    scheme: node.scheme,
    server: node.server,
    port: node.port,
    transport: node.transport,
    security: node.security,
    supported: node.supported,
    active: node.active,
    error: node.error,
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * route.rules 模板:把 Claude Code 自动更新的下载域名钉死走 direct。单一权威,
 * 单节点/selector 两条配置都注入,刷新/切换永不再抹掉(根治历史 landmine)。
 */
export function buildRouteRules(): Array<Record<string, unknown>> {
  return [{ domain_suffix: [...ROUTE_DIRECT_DOMAIN_SUFFIXES], outbound: DIRECT_TAG }]
}

function buildRoute(): { rules: Array<Record<string, unknown>>; final: string } {
  return { rules: buildRouteRules(), final: SELECTOR_TAG }
}

/** 把一个节点的私有字段物化成 sing-box vless outbound(给定 tag)。共享原语。 */
function buildVlessOutbound(node: EgressNodeInternal, tag: string): Record<string, any> {
  const isWsTls = node.transport === 'ws' && node.security === 'tls'
  const isTcpReality = node.transport === 'tcp' && node.security === 'reality'
  if (!node.supported || !node.uuid || !node.server || !node.sni) {
    throw new EgressHttpError(400, `node #${node.idx} is not supported`)
  }
  if (isWsTls && !node.wsHost) {
    throw new EgressHttpError(400, `node #${node.idx} is not supported`)
  }
  if (isTcpReality && !node.realityPublicKey) {
    throw new EgressHttpError(400, `node #${node.idx} is not supported`)
  }
  if (!isWsTls && !isTcpReality) {
    throw new EgressHttpError(400, `node #${node.idx} is not supported`)
  }
  const outbound: Record<string, any> = {
    type: 'vless',
    tag,
    server: node.server,
    server_port: node.port || 443,
    uuid: node.uuid,
    tls: {
      enabled: true,
      server_name: node.sni,
      utls: {
        enabled: true,
        fingerprint: node.fingerprint || 'chrome',
      },
    },
  }
  if (node.flow) outbound.flow = node.flow
  if (isWsTls) {
    outbound.transport = {
      type: 'ws',
      path: node.path || '/',
      headers: { Host: node.wsHost },
    }
  } else {
    outbound.tls.reality = {
      enabled: true,
      public_key: node.realityPublicKey,
    }
    if (node.realityShortId) outbound.tls.reality.short_id = node.realityShortId
  }
  return outbound
}

function metaForNode(node: EgressNodeInternal): EgressMeta {
  const meta: EgressMeta = {
    idx: node.idx,
    name: node.name,
    server: `${node.server}:${node.port || 443}`,
    sni: node.sni,
    updated_at: nowIso(),
  }
  if (node.transport === 'ws' && node.security === 'tls') {
    meta.ws_host = node.wsHost
    meta.path = node.path || '/'
  }
  return meta
}

/** 两个节点是否同一落地端点(server:port + uuid)。用于判定备节点冗余是否有效。 */
function sameEndpoint(a: EgressNodeInternal, b: EgressNodeInternal): boolean {
  return a.server === b.server && (a.port || 443) === (b.port || 443) && a.uuid === b.uuid
}

/**
 * 单节点配置:node 直接作为 tag=`proxy` 的 outbound,route.final=proxy。仍用于隔离
 * 探测单个候选节点(testCandidate),不含 selector/clash_api。向后兼容既有断言。
 */
export function buildSingBoxConfig(
  node: EgressNodePublic | EgressNodeInternal,
  listen = DEFAULT_LISTEN,
  port = DEFAULT_PORT,
): { config: any; meta: EgressMeta } {
  const internal = node as EgressNodeInternal
  const outbound = buildVlessOutbound(internal, SELECTOR_TAG)
  const cfg = {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen, listen_port: port }],
    outbounds: [outbound, { type: 'direct', tag: DIRECT_TAG }],
    route: buildRoute(),
  }
  return { config: cfg, meta: metaForNode(internal) }
}

export interface ClashApiConfig {
  listen: string
  port: number
  secret: string
  /** 省略 → 不写 cache_file(不持久化 selector 选中) */
  cacheFile?: string
}

/**
 * 主备 selector 实时配置:`proxy` selector(outbounds=[node-a,(node-b)],default=node-a,
 * interrupt_exist_connections=false)+ 两个具名候选 outbound + direct;route.final=proxy
 * 且注入 ROUTE_RULES;experimental.clash_api(切换/测速)+ cache_file(持久化选中)。
 * backup 缺省或与 primary 同端点 → 退化为单成员 selector(诚实无冗余)。
 */
export function buildSelectorConfig(
  primary: EgressNodeInternal,
  backup: EgressNodeInternal | undefined,
  listen = DEFAULT_LISTEN,
  port = DEFAULT_PORT,
  clash?: ClashApiConfig,
): { config: any; meta: EgressMeta } {
  const hasBackup = !!backup && !sameEndpoint(primary, backup)
  const candidateOutbounds: Record<string, any>[] = [buildVlessOutbound(primary, PRIMARY_TAG)]
  const members: string[] = [PRIMARY_TAG]
  if (hasBackup && backup) {
    candidateOutbounds.push(buildVlessOutbound(backup, BACKUP_TAG))
    members.push(BACKUP_TAG)
  }
  const selector = {
    type: 'selector',
    tag: SELECTOR_TAG,
    outbounds: members,
    default: PRIMARY_TAG,
    interrupt_exist_connections: SELECTOR_INTERRUPT_EXISTING,
  }
  const cfg: any = {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen, listen_port: port }],
    outbounds: [selector, ...candidateOutbounds, { type: 'direct', tag: DIRECT_TAG }],
    route: buildRoute(),
  }
  if (clash) {
    const experimental: any = {
      clash_api: {
        external_controller: `${clash.listen}:${clash.port}`,
        secret: clash.secret,
      },
    }
    if (clash.cacheFile) {
      // sing-box 1.13:cache_file 启用即默认持久化 selector 选中(store_selected 字段已移除)
      experimental.cache_file = { enabled: true, path: clash.cacheFile }
    }
    cfg.experimental = experimental
  }
  const meta = metaForNode(primary)
  if (hasBackup && backup) {
    meta.backup_idx = backup.idx
    meta.backup_name = backup.name
    meta.backup_server = `${backup.server}:${backup.port || 443}`
  }
  return { config: cfg, meta }
}

/** buildVlessOutbound 的逆映射:把已落盘 outbound 原样还原为 internal(迁移/刷新保真)。 */
export function outboundToInternal(
  outbound: any,
  idx: number,
  name: string,
): EgressNodeInternal | undefined {
  if (!outbound || outbound.type !== 'vless' || !outbound.server || !outbound.uuid) return undefined
  const tls = outbound.tls || {}
  const sni = typeof tls.server_name === 'string' ? tls.server_name : undefined
  if (!sni) return undefined
  const base: EgressNodeInternal = {
    idx,
    uri: '',
    name,
    scheme: 'vless',
    server: String(outbound.server),
    port: Number(outbound.server_port) || 443,
    supported: true,
    active: false,
    uuid: String(outbound.uuid),
    sni,
    fingerprint: typeof tls.utls?.fingerprint === 'string' ? tls.utls.fingerprint : 'chrome',
    flow: typeof outbound.flow === 'string' ? outbound.flow : undefined,
  }
  if (tls.reality?.enabled) {
    base.transport = 'tcp'
    base.security = 'reality'
    base.realityPublicKey =
      typeof tls.reality.public_key === 'string' ? tls.reality.public_key : undefined
    base.realityShortId =
      typeof tls.reality.short_id === 'string' ? tls.reality.short_id : undefined
    if (!base.realityPublicKey) return undefined
  } else if (outbound.transport?.type === 'ws') {
    base.transport = 'ws'
    base.security = 'tls'
    base.path = typeof outbound.transport.path === 'string' ? outbound.transport.path : '/'
    base.wsHost =
      typeof outbound.transport.headers?.Host === 'string' ? outbound.transport.headers.Host : sni
  } else {
    return undefined
  }
  return base
}

async function fetchSubscription(settings: EgressSettings): Promise<string[]> {
  if (!settings.subscriptionUrl)
    throw new EgressHttpError(503, 'egress subscription URL is not configured')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await undiciFetch(settings.subscriptionUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 OpenClaudeOps/1.0' },
      dispatcher: DIRECT_FETCH_DISPATCHER,
      signal: ctrl.signal,
    })
    if (!res.ok) throw new EgressHttpError(502, `subscription fetch failed: HTTP ${res.status}`)
    const raw = Buffer.from(await res.arrayBuffer())
    return decodeSubscriptionLines(raw)
  } catch (err) {
    if (err instanceof EgressHttpError) throw err
    throw new EgressHttpError(502, 'subscription fetch failed')
  } finally {
    clearTimeout(timer)
  }
}

function parseMetaText(text: string): EgressMeta {
  const meta: EgressMeta = {}
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx)
    const value = line.slice(idx + 1)
    if (key === 'idx') {
      const n = Number(value)
      if (Number.isInteger(n)) meta.idx = n
    } else meta[key] = value
  }
  return meta
}

async function readMeta(settings: EgressSettings): Promise<EgressMeta> {
  try {
    return parseMetaText(await readFile(settings.metaPath, 'utf-8'))
  } catch {
    return {}
  }
}

function healthFromMeta(meta: EgressMeta): Partial<EgressHealth> | undefined {
  const keys = Object.keys(meta).filter((k) => k.startsWith('health_'))
  if (!keys.length) return undefined
  const h: Partial<EgressHealth> = {}
  const map: Record<string, keyof EgressHealth> = {
    health_healthy: 'healthy',
    health_anthropic_code: 'anthropicCode',
    health_anthropic_sec: 'anthropicMs',
    health_cf_code: 'cfCode',
    health_cf_sec: 'cfMs',
    health_score_sec: 'scoreMs',
    health_ip: 'ip',
    health_org: 'org',
    health_city: 'city',
    health_country: 'country',
  }
  for (const [rawKey, outKey] of Object.entries(map)) {
    const v = meta[rawKey]
    if (v === undefined) continue
    if (outKey === 'healthy') (h as any)[outKey] = String(v).toLowerCase() === 'true'
    else if (outKey.endsWith('Ms')) {
      const n = Number(v)
      if (Number.isFinite(n)) (h as any)[outKey] = Math.round(n * 1000)
    } else (h as any)[outKey] = String(v)
  }
  return h
}

async function execLimited(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      env: withoutProxyEnv(),
      windowsHide: true,
    })
    return { stdout: String(stdout || ''), stderr: String(stderr || '') }
  } catch (err: any) {
    const stderr = String(err?.stderr || err?.stdout || err?.message || '').slice(0, 240)
    throw new Error(stderr || `command failed: ${basename(file)}`)
  }
}

async function serviceActive(settings: EgressSettings): Promise<boolean> {
  try {
    await execLimited('systemctl', ['is-active', '--quiet', settings.service], 5_000)
    return true
  } catch {
    return false
  }
}

/**
 * 活跃节点权威 = clash_api selector.now(watchdog 与前端切换都只改它);meta 只提供
 * 主/备两成员的详情。仅 selector 配置(有 clash_api)才查询;老单节点/查询失败回落 meta 主。
 */
async function resolveActiveNode(
  settings: EgressSettings,
  meta: EgressMeta,
): Promise<EgressStatus['active']> {
  const primary = {
    idx: typeof meta.idx === 'number' ? meta.idx : undefined,
    name: typeof meta.name === 'string' ? meta.name : undefined,
    server: typeof meta.server === 'string' ? meta.server : undefined,
    updatedAt: typeof meta.updated_at === 'string' ? meta.updated_at : undefined,
    health: healthFromMeta(meta),
  }
  const backupIdxNum = Number(meta.backup_idx)
  const standby =
    meta.backup_server !== undefined || meta.backup_name !== undefined
      ? {
          idx: Number.isInteger(backupIdxNum) ? backupIdxNum : undefined,
          name: typeof meta.backup_name === 'string' ? meta.backup_name : undefined,
          server: typeof meta.backup_server === 'string' ? meta.backup_server : undefined,
        }
      : undefined
  const cfg = await readConfigJson(settings)
  const secret = cfg?.experimental?.clash_api?.secret
  const activeTag =
    typeof secret === 'string' ? await clashSelectorNow(settings, secret) : undefined
  if (activeTag === BACKUP_TAG && standby) {
    return {
      idx: standby.idx,
      name: standby.name,
      server: standby.server,
      updatedAt: primary.updatedAt,
      health: undefined,
      standby,
      activeTag,
    }
  }
  return { ...primary, standby, activeTag }
}

export async function getEgressProxyStatus(opts: EgressOptions = {}): Promise<EgressStatus> {
  const settings = resolveEgressSettings(opts)
  const meta = await readMeta(settings)
  return {
    configured: !!settings.subscriptionUrl,
    subscriptionConfigured: !!settings.subscriptionUrl,
    mutationsEnabled: settings.mutationsEnabled,
    mutationDisabledReason: settings.mutationDisabledReason,
    localProxy: `http://${settings.listen}:${settings.port}`,
    service: { name: settings.service, active: await serviceActive(settings) },
    active: await resolveActiveNode(settings, meta),
  }
}

export async function refreshEgressNodes(
  opts: EgressOptions = {},
): Promise<{ nodes: EgressNodePublic[]; status: EgressStatus }> {
  const settings = resolveEgressSettings(opts)
  const [lines, meta] = await Promise.all([fetchSubscription(settings), readMeta(settings)])
  return {
    nodes: parseSubscriptionNodes(lines, typeof meta.idx === 'number' ? meta.idx : undefined),
    status: await getEgressProxyStatus(opts),
  }
}

function validateIdxs(idxs: unknown, nodes: EgressNodeInternal[]): number[] {
  if (!Array.isArray(idxs)) throw new EgressHttpError(400, 'idxs must be an array')
  const out: number[] = []
  const seen = new Set<number>()
  for (const raw of idxs) {
    const idx = Number(raw)
    if (!Number.isInteger(idx) || idx < 1 || idx > nodes.length) {
      throw new EgressHttpError(400, `invalid node idx: ${String(raw)}`)
    }
    if (!seen.has(idx)) {
      seen.add(idx)
      out.push(idx)
    }
  }
  if (out.length > MAX_TEST_IDXS)
    throw new EgressHttpError(400, `idxs supports at most ${MAX_TEST_IDXS} nodes`)
  return out
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitPort(host: string, port: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = createConnection({ host, port })
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (ok) resolve(true)
        else if (Date.now() >= deadline) resolve(false)
        else setTimeout(tryOnce, 200)
      }
      socket.setTimeout(300)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    }
    tryOnce()
  })
}

async function curlProbe(
  settings: EgressSettings,
  proxy: string,
  url: string,
  timeoutSec = 10,
): Promise<{ ok: boolean; code: string; ms: number }> {
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await execLimited(
      settings.curlPath,
      [
        '-sS',
        '--max-time',
        String(timeoutSec),
        '-x',
        proxy,
        '--noproxy',
        '',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        url,
      ],
      (timeoutSec + 3) * 1000,
    )
    const code = stdout.trim() || stderr.trim().slice(0, 120)
    return {
      ok: !!code && code !== '000',
      code: code || 'unknown',
      ms: Date.now() - t0,
    }
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 120) : 'failed'
    return { ok: false, code, ms: Date.now() - t0 }
  }
}

async function ipinfo(settings: EgressSettings, proxy: string): Promise<Partial<EgressHealth>> {
  try {
    const { stdout } = await execLimited(
      settings.curlPath,
      ['-sS', '--max-time', '10', '-x', proxy, '--noproxy', '', 'https://ipinfo.io/json'],
      13_000,
    )
    const data = JSON.parse(stdout)
    return {
      ip: typeof data.ip === 'string' ? data.ip : undefined,
      org: typeof data.org === 'string' ? data.org : undefined,
      city: typeof data.city === 'string' ? data.city : undefined,
      country: typeof data.country === 'string' ? data.country : undefined,
    }
  } catch {
    return {}
  }
}

async function testProxy(settings: EgressSettings, proxy: string): Promise<EgressHealth> {
  const anthropic = await curlProbe(settings, proxy, 'https://api.anthropic.com/')
  const cf = await curlProbe(settings, proxy, 'https://cp.cloudflare.com/generate_204')
  const info = anthropic.ok || cf.ok ? await ipinfo(settings, proxy) : {}
  return {
    healthy: anthropic.ok && cf.ok,
    anthropicCode: anthropic.code,
    anthropicMs: anthropic.ms,
    cfCode: cf.code,
    cfMs: cf.ms,
    scoreMs: anthropic.ms + cf.ms,
    ...info,
  }
}

async function allocateTestPort(settings: EgressSettings): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, settings.testListen, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close((err) => {
        if (err) reject(err)
        else if (port) resolve(port)
        else reject(new Error('failed to allocate test port'))
      })
    })
  })
}

async function killProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => proc.once('exit', () => resolve())),
    wait(3_000).then(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }),
  ])
}

async function testCandidate(
  settings: EgressSettings,
  node: EgressNodeInternal,
): Promise<EgressTestResult> {
  if (!node.supported) return { idx: node.idx, error: node.error || 'unsupported node' }
  const port = await allocateTestPort(settings)
  const { config } = buildSingBoxConfig(node, settings.testListen, port)
  const dir = await mkdtemp(join(tmpdir(), `oc-egress-${node.idx}-`))
  let proc: ChildProcess | null = null
  try {
    const cfgPath = join(dir, 'sing-box.json')
    await writeFile(cfgPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    })
    await execLimited(settings.singBoxPath, ['check', '-c', cfgPath], 10_000)
    proc = spawn(settings.singBoxPath, ['run', '-c', cfgPath], {
      env: withoutProxyEnv(),
      stdio: 'ignore',
    })
    if (!(await waitPort(settings.testListen, port)))
      return { idx: node.idx, error: 'listen_timeout' }
    return {
      idx: node.idx,
      health: await testProxy(settings, `http://${settings.testListen}:${port}`),
    }
  } catch (err) {
    return { idx: node.idx, error: redactEgressError(err) }
  } finally {
    await killProcess(proc)
    await rm(dir, { recursive: true, force: true })
  }
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function testEgressProxy(
  idxs?: unknown,
  opts: EgressOptions = {},
): Promise<{ active?: EgressHealth; results: EgressTestResult[] }> {
  const settings = resolveEgressSettings(opts)
  if (idxs === undefined) {
    return {
      active: await testProxy(settings, `http://${settings.listen}:${settings.port}`),
      results: [],
    }
  }
  const lines = await fetchSubscription(settings)
  const meta = await readMeta(settings)
  const nodes = parseSubscriptionNodesInternal(
    lines,
    typeof meta.idx === 'number' ? meta.idx : undefined,
  )
  const validIdxs = validateIdxs(idxs, nodes)
  const selected = validIdxs.map((idx) => nodes[idx - 1])
  return {
    results: await mapLimited(selected, TEST_CONCURRENCY, (node) => testCandidate(settings, node)),
  }
}

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, data, { mode })
  await chmod(tmp, mode)
  await rename(tmp, path)
}

function metaValue(value: string | number | boolean): string {
  return Array.from(String(value).replace(/[\r\n]+/g, ' '))
    .map((ch) => {
      const code = ch.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : ch
    })
    .join('')
    .trim()
}

export function metaText(meta: EgressMeta, health?: EgressHealth): string {
  const data: Record<string, string | number | boolean | undefined> = {
    ...meta,
  }
  if (health) {
    data.health_healthy = health.healthy
    data.health_anthropic_code = health.anthropicCode
    data.health_anthropic_sec = Math.round(health.anthropicMs) / 1000
    data.health_cf_code = health.cfCode
    data.health_cf_sec = Math.round(health.cfMs) / 1000
    data.health_score_sec = Math.round(health.scoreMs) / 1000
    data.health_ip = health.ip
    data.health_org = health.org
    data.health_city = health.city
    data.health_country = health.country
  }
  return Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${metaValue(value as string | number | boolean)}\n`)
    .join('')
}

// ── clash_api 客户端(本机回环,强制直连不经代理) ──

function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function readConfigJson(settings: EgressSettings): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(settings.configPath, 'utf-8'))
  } catch {
    return undefined
  }
}

/**
 * clash_api secret 解析(稳定优先):已落盘 config 里的 secret 最高优先(保证 watchdog
 * 跨刷新稳定,不因 regen 改 secret)→ env 种子(OC_EGRESS_CLASH_SECRET,块C 可预置)→
 * 随机生成一次并从此固化在 config。watchdog 始终从 config 读 secret,故此为唯一权威。
 */
async function resolveClashSecret(settings: EgressSettings): Promise<string> {
  const existing = await readConfigJson(settings)
  const cur = existing?.experimental?.clash_api?.secret
  if (typeof cur === 'string' && cur.length >= 16) return cur
  if (settings.clashSecretSeed && settings.clashSecretSeed.length >= 8) return settings.clashSecretSeed
  return randomBytes(24).toString('hex')
}

async function clashRequest(
  settings: EgressSettings,
  secret: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 4_000,
): Promise<{ status: number; data: any }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await undiciFetch(`http://${settings.clashListen}:${settings.clashPort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      dispatcher: DIRECT_FETCH_DISPATCHER,
      signal: ctrl.signal,
    })
    const text = await res.text()
    return { status: res.status, data: text ? safeJson(text) : {} }
  } finally {
    clearTimeout(timer)
  }
}

async function clashSelectorNow(settings: EgressSettings, secret: string): Promise<string | undefined> {
  try {
    const { status, data } = await clashRequest(settings, secret, 'GET', `/proxies/${SELECTOR_TAG}`)
    if (status === 200 && typeof data?.now === 'string') return data.now
  } catch {}
  return undefined
}

async function clashSwitch(settings: EgressSettings, secret: string, tag: string): Promise<boolean> {
  try {
    const { status } = await clashRequest(settings, secret, 'PUT', `/proxies/${SELECTOR_TAG}`, {
      name: tag,
    })
    return status === 200 || status === 204
  } catch {
    return false
  }
}

async function clashDelay(
  settings: EgressSettings,
  secret: string,
  tag: string,
  url = 'https://cp.cloudflare.com/generate_204',
  timeoutMs = 5_000,
): Promise<number | undefined> {
  try {
    const q = new URLSearchParams({ timeout: String(timeoutMs), url }).toString()
    const { status, data } = await clashRequest(
      settings,
      secret,
      'GET',
      `/proxies/${encodeURIComponent(tag)}/delay?${q}`,
      undefined,
      timeoutMs + 3_000,
    )
    if (status === 200 && Number.isInteger(data?.delay)) return data.delay as number
  } catch {}
  return undefined
}

/** clash_api 无重启切换后没有完整 anthropic/cf 探测,用 selector delay 合成一个健康摘要。 */
function synthHealthFromDelay(delay?: number): EgressHealth {
  const ok = typeof delay === 'number'
  return {
    healthy: ok,
    anthropicCode: ok ? 'selector' : '000',
    anthropicMs: delay ?? 0,
    cfCode: ok ? '204' : '000',
    cfMs: delay ?? 0,
    scoreMs: delay ?? 0,
  }
}

function findMemberOutbound(config: any, tag: string): any | undefined {
  const outs = Array.isArray(config?.outbounds) ? config.outbounds : []
  return outs.find((o: any) => o?.tag === tag && o?.type === 'vless')
}

/** 目标节点是否已是当前 selector 的某个具名成员(按 server:port+uuid 判定),返回其 tag。 */
function matchLoadedMemberTag(config: any, node: EgressNodeInternal): string | undefined {
  if (!config?.experimental?.clash_api) return undefined
  for (const tag of [PRIMARY_TAG, BACKUP_TAG]) {
    const o = findMemberOutbound(config, tag)
    if (
      o &&
      o.server === node.server &&
      (Number(o.server_port) || 443) === (node.port || 443) &&
      o.uuid === node.uuid
    ) {
      return tag
    }
  }
  return undefined
}

/** 把一个已落盘成员 outbound 匹配回订阅最新行(凭据可能轮转 → 采用订阅最新版本)。 */
function matchSubscriptionNode(
  nodes: EgressNodeInternal[],
  outbound: any,
): EgressNodeInternal | undefined {
  if (!outbound?.server) return undefined
  const port = Number(outbound.server_port) || 443
  return (
    nodes.find(
      (n) =>
        n.supported && n.server === outbound.server && (n.port || 443) === port && n.uuid === outbound.uuid,
    ) || nodes.find((n) => n.supported && n.server === outbound.server && (n.port || 443) === port)
  )
}

/**
 * 从订阅择优一个健康的、与主节点不同落地端点的备节点(best-effort,实测健康)。
 * 逐个候选隔离探测,取首个 healthy;都不健康 → 无备(诚实退化为单成员 selector)。
 */
async function pickHealthyBackup(
  settings: EgressSettings,
  nodes: EgressNodeInternal[],
  primary: EgressNodeInternal,
  maxTests = 3,
): Promise<{ node?: EgressNodeInternal; health?: EgressHealth }> {
  const candidates = nodes
    .filter((n) => n.supported && n.idx !== primary.idx && !sameEndpoint(n, primary))
    .slice(0, maxTests)
  for (const cand of candidates) {
    const tested = await testCandidate(settings, cand)
    if (tested.health?.healthy) return { node: cand, health: tested.health }
  }
  return {}
}

/**
 * 写入主备 selector 实时配置并重启 sing-box。sing-box check 通过才 rename(原子),
 * cache_file 目录建不出来则降级为不持久化(绝不因此让 sing-box 起不来 = boss 出海断)。
 */
async function installSelectorConfig(
  settings: EgressSettings,
  primary: EgressNodeInternal,
  backup: EgressNodeInternal | undefined,
  primaryHealth?: EgressHealth,
): Promise<void> {
  const secret = await resolveClashSecret(settings)
  let cacheFile: string | undefined = settings.cacheFile
  try {
    await mkdir(dirname(cacheFile), { recursive: true })
  } catch {
    cacheFile = undefined
  }
  const { config, meta } = buildSelectorConfig(primary, backup, settings.listen, settings.port, {
    listen: settings.clashListen,
    port: settings.clashPort,
    secret,
    cacheFile,
  })
  const json = `${JSON.stringify(config, null, 2)}\n`
  await mkdir(dirname(settings.configPath), { recursive: true })
  const tmpConfigPath = join(
    dirname(settings.configPath),
    `${basename(settings.configPath)}.${process.pid}.${Date.now()}.check.tmp`,
  )
  try {
    await writeFile(tmpConfigPath, json, { mode: 0o600 })
    await chmod(tmpConfigPath, 0o600)
    await execLimited(settings.singBoxPath, ['check', '-c', tmpConfigPath], 10_000)
    await rename(tmpConfigPath, settings.configPath)
  } catch (err) {
    await rm(tmpConfigPath, { force: true })
    throw err
  }
  await atomicWrite(settings.metaPath, metaText(meta, primaryHealth))
  await execLimited('systemctl', ['restart', settings.service], 25_000)
  await execLimited('systemctl', ['is-active', '--quiet', settings.service], 10_000)
}

export async function selectEgressNode(
  idxRaw: unknown,
  opts: EgressOptions = {},
): Promise<{
  selected: EgressNodePublic
  health: EgressHealth
  status: EgressStatus
  switched?: 'clash_api' | 'restart'
}> {
  const settings = resolveEgressSettings(opts)
  if (!settings.mutationsEnabled) {
    throw new EgressHttpError(
      403,
      settings.mutationDisabledReason || 'egress proxy mutations are disabled',
    )
  }
  if (installInFlight) throw new EgressHttpError(409, 'egress proxy operation already running')
  const idx = Number(idxRaw)
  if (!Number.isInteger(idx) || idx < 1)
    throw new EgressHttpError(400, 'idx must be a positive integer')
  installInFlight = true
  try {
    const lines = await fetchSubscription(settings)
    if (idx > lines.length) throw new EgressHttpError(400, `invalid node idx: ${idx}`)
    const node = parseNode(lines[idx - 1], idx)
    if (!node.supported)
      throw new EgressHttpError(400, node.error || `node #${idx} is not supported`)

    // ── fast path:目标已是当前 selector 成员 → clash_api PUT 无重启切换 ──
    const existing = await readConfigJson(settings)
    const memberTag = matchLoadedMemberTag(existing, node)
    if (memberTag) {
      const secret = existing?.experimental?.clash_api?.secret
      if (typeof secret === 'string' && (await clashSwitch(settings, secret, memberTag))) {
        const delay = await clashDelay(settings, secret, memberTag)
        node.active = true
        return {
          selected: publicNode(node),
          health: synthHealthFromDelay(delay),
          status: await getEgressProxyStatus(opts),
          switched: 'clash_api',
        }
      }
      // PUT 失败 → 回落到重生成路径(下方),不让切换哑火
    }

    // ── slow path:新节点作主 → 健康校验 + 择优备节点 + 重生成 selector + 重启 ──
    const tested = await testCandidate(settings, node)
    if (!tested.health?.healthy) {
      throw new EgressHttpError(
        400,
        `node #${idx} health test failed: ${tested.error || tested.health?.anthropicCode || 'unhealthy'}`,
      )
    }
    const backup = await pickHealthyBackup(settings, parseSubscriptionNodesInternal(lines), node)
    await installSelectorConfig(settings, node, backup.node, tested.health)
    node.active = true
    return {
      selected: publicNode(node),
      health: tested.health,
      status: await getEgressProxyStatus(opts),
      switched: 'restart',
    }
  } finally {
    installInFlight = false
  }
}

/**
 * 向后兼容:把现有单节点配置平滑升级为主备 selector。主节点 = 现有 outbound **原样提取**
 * (server/uuid/reality/ws 全保真,boss 当前节点零改动),备节点从订阅择优(拿不到就单成员)。
 * 已是 selector 则幂等 no-op。块C 首次迁移调用此函数(切换窗口 = 一次 sing-box 重启)。
 */
export async function migrateEgressToSelector(
  opts: EgressOptions = {},
): Promise<{ migrated: boolean; reason?: string; status: EgressStatus }> {
  const settings = resolveEgressSettings(opts)
  if (!settings.mutationsEnabled) {
    throw new EgressHttpError(
      403,
      settings.mutationDisabledReason || 'egress proxy mutations are disabled',
    )
  }
  if (installInFlight) throw new EgressHttpError(409, 'egress proxy operation already running')
  installInFlight = true
  try {
    const cfg = await readConfigJson(settings)
    if (!cfg) throw new EgressHttpError(503, 'no existing egress config to migrate')
    const alreadySelector =
      cfg?.experimental?.clash_api &&
      Array.isArray(cfg.outbounds) &&
      cfg.outbounds.some((o: any) => o?.tag === SELECTOR_TAG && o?.type === 'selector')
    if (alreadySelector) {
      return { migrated: false, reason: 'already a selector config', status: await getEgressProxyStatus(opts) }
    }
    const cur = Array.isArray(cfg.outbounds)
      ? cfg.outbounds.find((o: any) => o?.type === 'vless')
      : undefined
    const meta = await readMeta(settings)
    const primary = outboundToInternal(
      cur,
      typeof meta.idx === 'number' ? meta.idx : 0,
      typeof meta.name === 'string' ? meta.name : '当前节点',
    )
    if (!primary)
      throw new EgressHttpError(400, 'existing egress outbound is not a supported vless node')
    let backup: EgressNodeInternal | undefined
    try {
      const lines = await fetchSubscription(settings)
      backup = (await pickHealthyBackup(settings, parseSubscriptionNodesInternal(lines), primary)).node
    } catch {
      // 订阅暂不可达不阻塞迁移:先单成员 selector,后续 refresh/select 再补备
    }
    await installSelectorConfig(settings, primary, backup)
    return { migrated: true, status: await getEgressProxyStatus(opts) }
  } finally {
    installInFlight = false
  }
}

/**
 * 刷新订阅:重生成 selector 配置,**保持 selector 结构与当前 tag→物理节点映射**
 * (node-a/node-b 端点不变),仅从订阅拉取各成员最新凭据。配合 cache_file store_selected,
 * 当前选中(即便 watchdog 已切到 node-b)跨这次重启依然保持。非 selector 配置先迁移。
 */
export async function resyncEgressSelector(
  opts: EgressOptions = {},
): Promise<{ resynced: boolean; reason?: string; status: EgressStatus }> {
  const settings = resolveEgressSettings(opts)
  if (!settings.mutationsEnabled) {
    throw new EgressHttpError(
      403,
      settings.mutationDisabledReason || 'egress proxy mutations are disabled',
    )
  }
  if (installInFlight) throw new EgressHttpError(409, 'egress proxy operation already running')
  installInFlight = true
  try {
    const cfg = await readConfigJson(settings)
    if (!cfg?.experimental?.clash_api) {
      return {
        resynced: false,
        reason: 'not a selector config; run migrate first',
        status: await getEgressProxyStatus(opts),
      }
    }
    const curPrimary = findMemberOutbound(cfg, PRIMARY_TAG)
    if (!curPrimary) {
      return {
        resynced: false,
        reason: 'no primary member in config',
        status: await getEgressProxyStatus(opts),
      }
    }
    const curBackup = findMemberOutbound(cfg, BACKUP_TAG)
    const meta = await readMeta(settings)
    const lines = await fetchSubscription(settings)
    const allNodes = parseSubscriptionNodesInternal(lines)
    const primary =
      matchSubscriptionNode(allNodes, curPrimary) ||
      outboundToInternal(curPrimary, typeof meta.idx === 'number' ? meta.idx : 0, PRIMARY_TAG)
    if (!primary)
      throw new EgressHttpError(400, 'primary member is not a supported vless node')
    let backup: EgressNodeInternal | undefined
    if (curBackup) {
      backup = matchSubscriptionNode(allNodes, curBackup) || outboundToInternal(curBackup, 0, BACKUP_TAG)
    } else {
      backup = (await pickHealthyBackup(settings, allNodes, primary)).node
    }
    await installSelectorConfig(settings, primary, backup)
    return { resynced: true, status: await getEgressProxyStatus(opts) }
  } finally {
    installInFlight = false
  }
}
