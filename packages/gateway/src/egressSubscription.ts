import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

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
  const transport = one(parsed.searchParams, 'type') || undefined
  const security = one(parsed.searchParams, 'security') || undefined
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

export function buildSingBoxConfig(
  node: EgressNodePublic | EgressNodeInternal,
  listen = DEFAULT_LISTEN,
  port = DEFAULT_PORT,
): { config: any; meta: EgressMeta } {
  const internal = node as EgressNodeInternal
  if (
    !internal.supported ||
    !internal.uuid ||
    !internal.server ||
    !internal.sni ||
    !internal.wsHost
  ) {
    throw new EgressHttpError(400, `node #${internal.idx} is not supported`)
  }
  const cfg = {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen, listen_port: port }],
    outbounds: [
      {
        type: 'vless',
        tag: 'proxy',
        server: internal.server,
        server_port: internal.port || 443,
        uuid: internal.uuid,
        tls: {
          enabled: true,
          server_name: internal.sni,
          utls: {
            enabled: true,
            fingerprint: internal.fingerprint || 'chrome',
          },
        },
        transport: {
          type: 'ws',
          path: internal.path || '/',
          headers: { Host: internal.wsHost },
        },
      },
      { type: 'direct', tag: 'direct' },
    ],
    route: { final: 'proxy' },
  }
  const meta: EgressMeta = {
    idx: internal.idx,
    name: internal.name,
    server: `${internal.server}:${internal.port || 443}`,
    sni: internal.sni,
    ws_host: internal.wsHost,
    path: internal.path || '/',
    updated_at: nowIso(),
  }
  return { config: cfg, meta }
}

async function fetchSubscription(settings: EgressSettings): Promise<string[]> {
  if (!settings.subscriptionUrl)
    throw new EgressHttpError(503, 'egress subscription URL is not configured')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(settings.subscriptionUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 OpenClaudeOps/1.0' },
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
    active: {
      idx: typeof meta.idx === 'number' ? meta.idx : undefined,
      name: typeof meta.name === 'string' ? meta.name : undefined,
      server: typeof meta.server === 'string' ? meta.server : undefined,
      updatedAt: typeof meta.updated_at === 'string' ? meta.updated_at : undefined,
      health: healthFromMeta(meta),
    },
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
      ['-sS', '--max-time', '10', '-x', proxy, 'https://ipinfo.io/json'],
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

async function installNode(
  settings: EgressSettings,
  node: EgressNodeInternal,
  health: EgressHealth,
): Promise<void> {
  const { config, meta } = buildSingBoxConfig(node, settings.listen, settings.port)
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
  await atomicWrite(settings.metaPath, metaText(meta, health))
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
    const tested = await testCandidate(settings, node)
    if (!tested.health?.healthy) {
      throw new EgressHttpError(
        400,
        `node #${idx} health test failed: ${tested.error || tested.health?.anthropicCode || 'unhealthy'}`,
      )
    }
    await installNode(settings, node, tested.health)
    node.active = true
    return {
      selected: publicNode(node),
      health: tested.health,
      status: await getEgressProxyStatus(opts),
    }
  } finally {
    installInFlight = false
  }
}
