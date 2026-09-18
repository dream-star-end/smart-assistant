import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, posix as pathPosix, win32 as pathWin32, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { acquireKernelFileLock } from './kernelFileLock.js'
import { paths } from './paths.js'

// ──────── 共享常量(单一权威;cli / gateway 不得再抄字面量)────────

/** selfhost 上可路由的兜底模型:与 sessionManager 的会话级兜底同值(onboard 默认模型也用它,CFG-16)。 */
export const SELFHOST_FALLBACK_MODEL = 'glm-5.3-zai'
export const DEFAULT_GATEWAY_BIND = '127.0.0.1'
export const DEFAULT_GATEWAY_PORT = 18789
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'plan',
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const AUTH_MODES = ['subscription', 'api_key', 'custom_platform'] as const
export type AuthMode = (typeof AUTH_MODES)[number]
/** agent id 词汇(与 POST /api/agents 历史校验同一正则;CLI `agents add` 也走这里,CFG-14)。 */
export const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/

/**
 * 配置文件级错误。`FATAL` = 文件存在但不可安全消费(JSON 非法 / version 不认识 / port 非法),
 * 调用方(cli gateway / doctor)应打印可读原因后退出;`MISSING` = 事务式更新时文件不存在。
 */
export class ConfigValidationError extends Error {
  constructor(
    readonly code: 'FATAL' | 'MISSING',
    message: string,
  ) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

// Extra MCP servers injected into a CCB subprocess's --mcp-config.
// Multi-provider extension point: register new capabilities (vision, search,
// image-gen, audio-gen, etc.) by dropping an MCP server config here.
//
// Provider scoping:
//   If `provider` is set, this MCP is only injected when the currently
//   active provider matches. This prevents e.g. minimax-vision leaking
//   into a DeepSeek or Anthropic session where its tools would just error.
//   If `provider` is unset, the MCP is considered "universal" and always
//   injected (our own openclaude-memory, generic utilities, etc.).
export interface McpServerConfig {
  id: string
  command: string
  args?: string[]
  env?: Record<string, string>
  // Optional human label shown in the web UI
  label?: string
  // Optional list of tool names this server exposes (for UI / inspection)
  tools?: string[]
  enabled?: boolean
  // Scope this MCP to a specific provider id; unset = universal
  provider?: string
}

/** Predefined tool groups that can be assigned to agents or routes */
export type ToolsetName = 'assistant' | 'research' | 'coding' | 'browser' | string

/** Map toolset name → list of MCP server IDs included in that toolset */
export interface ToolsetDefs {
  [name: string]: string[] // e.g. { research: ['browser'], coding: ['openclaude-memory'] }
}

export interface UserEntry {
  id: string // e.g. "boss"
  name: string // display name
  passwordHash: string // scrypt hash
}

export interface OpenClaudeConfig {
  version: 1
  gateway: {
    bind: string // e.g. "127.0.0.1"
    port: number // 18789
    accessToken: string
    users?: UserEntry[] // multi-user: login with username+password
    /**
     * Per-session outbound frame ring buffer overrides. All fields optional —
     * any unset field falls back to DEFAULT_RING_CONFIG (2000 entries / 10min /
     * 5MB). On commercial hosts, where mobile-Safari users may keep tabs
     * backgrounded for >10min, raise `maxAgeMs` so the resume replay path can
     * still serve frames after the default window.
     */
    outboundRing?: {
      maxEntries?: number
      maxAgeMs?: number
      maxBytes?: number
    }
  }
  // 接入方式三选一(实际 token 由 CCB 自己存,这里只记录类型)
  auth: {
    mode: AuthMode
    // CCB 工程目录(我们 spawn 它)
    claudeCodePath: string
    // CCB cli 入口(相对 claudeCodePath),默认 src/entrypoints/cli.tsx
    claudeCodeEntry?: string
    // 运行 CCB 的解释器(bun / node)
    claudeCodeRuntime?: 'bun' | 'node'
    // Claude.ai OAuth tokens (when mode='subscription')
    claudeOAuth?: {
      accessToken: string
      refreshToken: string
      expiresAt: number // unix ms
      scope: string
    }
    // OpenAI Codex OAuth tokens
    codexOAuth?: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      scope: string
    }
  }
  defaults: {
    model: string // glm-5.3-zai 等(onboard 默认 = SELFHOST_FALLBACK_MODEL)
    permissionMode: PermissionMode
    toolsets?: ToolsetName[] // default toolsets for all agents (if not overridden)
  }
  // Named toolset definitions: group MCP servers by purpose
  // e.g. { research: ['browser'], coding: ['openclaude-memory'], browser: ['browser'] }
  // If undefined, all MCP servers are available to all agents (current behavior)
  toolsets?: ToolsetDefs
  // Which provider ecosystem this install is wired to. Used to scope
  // provider-specific MCP servers (e.g. minimax-vision only loads when
  // provider="minimax"). Free-form string — common values: "minimax",
  // "anthropic", "deepseek", "openai", "gemini".
  provider?: string
  channels: {
    webchat: { enabled: boolean }
    // 运行时字段与 cli pairing/gateway 命令对齐(CFG-09):pairing 写 botTokenRef:'inline' + botToken 明文,
    // gateway 启动读 botToken(或 OPENCLAUDE_TELEGRAM_BOT_TOKEN env)与 mentionRequired。
    telegram?: {
      enabled: boolean
      botTokenRef?: string
      botToken?: string
      mentionRequired?: boolean
    }
    wechat?: { enabled: boolean; corpIdRef?: string }
    feishu?: { enabled: boolean; appIdRef?: string }
  }
  // Multi-provider MCP server registry — auto-merged into every CCB subprocess
  mcpServers?: McpServerConfig[]
  // Terminal backend for CCB subprocess execution
  terminal?: {
    type: 'local' | 'docker' // future: 'ssh' | 'remote'
    // Remote host (future extension point)
    host?: string
    port?: number
    user?: string
    keyPath?: string
    // Docker-specific options
    image?: string
    volumes?: string[]
    envAllowlist?: string[]
    timeoutMs?: number
  }
}

// ──────── openclaude.json:schema 归一(CFG-04)────────
//
// 原则(指挥官拍板 2026-09-18):致命面只有两条 —— version ≠ 1、gateway.port 存在但不是
// 1..65535 的整数(以及根本不是 JSON 对象)。其余缺字段一律填默认 + warning,不扩大致命面;
// 未知字段原样透传(写回时保留)。手写归一,不引 zod 等依赖。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 把任意 JSON 归一成可安全消费的 OpenClaudeConfig;返回 warnings 供启动日志 / doctor 打印。 */
export function parseOpenClaudeConfig(raw: unknown): {
  config: OpenClaudeConfig
  warnings: string[]
} {
  if (!isPlainObject(raw)) {
    throw new ConfigValidationError(
      'FATAL',
      `openclaude.json: root must be a JSON object (got ${Array.isArray(raw) ? 'array' : typeof raw})`,
    )
  }
  const warnings: string[] = []
  const out: Record<string, unknown> = { ...raw }

  if (out.version === undefined) {
    warnings.push('version missing → assuming 1')
    out.version = 1
  } else if (out.version !== 1) {
    throw new ConfigValidationError(
      'FATAL',
      `openclaude.json: unsupported version ${JSON.stringify(out.version)} (this build understands version 1)`,
    )
  }

  // gateway
  const gw: Record<string, unknown> = isPlainObject(out.gateway) ? { ...out.gateway } : {}
  if (!isPlainObject(out.gateway))
    warnings.push(
      'gateway section missing → using defaults (bind 127.0.0.1, port 18789, empty accessToken)',
    )
  if (typeof gw.bind !== 'string' || gw.bind.trim() === '') {
    if (gw.bind !== undefined)
      warnings.push(
        `gateway.bind ${JSON.stringify(gw.bind)} is not a string → ${DEFAULT_GATEWAY_BIND}`,
      )
    else if (isPlainObject(out.gateway))
      warnings.push(`gateway.bind missing → ${DEFAULT_GATEWAY_BIND}`)
    gw.bind = DEFAULT_GATEWAY_BIND
  }
  if (gw.port === undefined) {
    if (isPlainObject(out.gateway)) warnings.push(`gateway.port missing → ${DEFAULT_GATEWAY_PORT}`)
    gw.port = DEFAULT_GATEWAY_PORT
  } else if (
    typeof gw.port !== 'number' ||
    !Number.isInteger(gw.port) ||
    gw.port < 1 ||
    gw.port > 65535
  ) {
    throw new ConfigValidationError(
      'FATAL',
      `openclaude.json: gateway.port must be an integer in 1..65535 (got ${JSON.stringify(gw.port)})`,
    )
  }
  if (typeof gw.accessToken !== 'string') {
    warnings.push(
      'gateway.accessToken missing or not a string → empty (nobody can authenticate until `openclaude onboard` regenerates it)',
    )
    gw.accessToken = ''
  } else if (gw.accessToken === '') {
    warnings.push('gateway.accessToken is empty → nobody can authenticate')
  }
  if (gw.users !== undefined && !Array.isArray(gw.users)) {
    warnings.push('gateway.users is not an array → ignored (single-token mode)')
    gw.users = undefined
  }
  if (gw.outboundRing !== undefined && !isPlainObject(gw.outboundRing)) {
    warnings.push('gateway.outboundRing is not an object → ignored')
    gw.outboundRing = undefined
  }
  out.gateway = gw

  // auth
  const auth: Record<string, unknown> = isPlainObject(out.auth) ? { ...out.auth } : {}
  if (!isPlainObject(out.auth))
    warnings.push('auth section missing → mode subscription, empty claudeCodePath')
  if (!(AUTH_MODES as readonly unknown[]).includes(auth.mode)) {
    if (auth.mode !== undefined)
      warnings.push(
        `auth.mode ${JSON.stringify(auth.mode)} not in ${AUTH_MODES.join('|')} → subscription`,
      )
    else if (isPlainObject(out.auth)) warnings.push('auth.mode missing → subscription')
    auth.mode = 'subscription'
  }
  if (typeof auth.claudeCodePath !== 'string') {
    if (auth.claudeCodePath !== undefined)
      warnings.push('auth.claudeCodePath is not a string → empty')
    else if (isPlainObject(out.auth)) warnings.push('auth.claudeCodePath missing → empty')
    auth.claudeCodePath = ''
  }
  out.auth = auth

  // defaults
  const defaults: Record<string, unknown> = isPlainObject(out.defaults) ? { ...out.defaults } : {}
  if (!isPlainObject(out.defaults))
    warnings.push(
      `defaults section missing → model ${SELFHOST_FALLBACK_MODEL}, permissionMode default`,
    )
  if (typeof defaults.model !== 'string' || defaults.model.trim() === '') {
    if (defaults.model !== undefined)
      warnings.push(
        `defaults.model ${JSON.stringify(defaults.model)} invalid → ${SELFHOST_FALLBACK_MODEL}`,
      )
    else if (isPlainObject(out.defaults))
      warnings.push(`defaults.model missing → ${SELFHOST_FALLBACK_MODEL}`)
    defaults.model = SELFHOST_FALLBACK_MODEL
  }
  if (!(PERMISSION_MODES as readonly unknown[]).includes(defaults.permissionMode)) {
    if (defaults.permissionMode !== undefined)
      warnings.push(
        `defaults.permissionMode ${JSON.stringify(defaults.permissionMode)} not in ${PERMISSION_MODES.join('|')} → default`,
      )
    else if (isPlainObject(out.defaults)) warnings.push('defaults.permissionMode missing → default')
    defaults.permissionMode = 'default'
  }
  if (defaults.toolsets !== undefined && !Array.isArray(defaults.toolsets)) {
    warnings.push('defaults.toolsets is not an array → ignored (all tools)')
    defaults.toolsets = undefined
  }
  out.defaults = defaults

  // channels
  if (!isPlainObject(out.channels)) {
    warnings.push('channels section missing → { webchat: { enabled: true } }')
    out.channels = { webchat: { enabled: true } }
  } else {
    const channels: Record<string, unknown> = { ...out.channels }
    if (!isPlainObject(channels.webchat)) {
      warnings.push('channels.webchat missing → enabled')
      channels.webchat = { enabled: true }
    }
    out.channels = channels
  }

  // optional collections
  if (out.mcpServers !== undefined) {
    if (!Array.isArray(out.mcpServers)) {
      warnings.push('mcpServers is not an array → ignored')
      out.mcpServers = undefined
    } else {
      const kept = out.mcpServers.filter((srv) => {
        const ok =
          isPlainObject(srv) &&
          typeof srv.id === 'string' &&
          srv.id !== '' &&
          typeof srv.command === 'string' &&
          srv.command !== ''
        if (!ok)
          warnings.push(
            `mcpServers entry without string id/command dropped: ${JSON.stringify(srv).slice(0, 80)}`,
          )
        return ok
      })
      out.mcpServers = kept
    }
  }
  if (out.toolsets !== undefined && !isPlainObject(out.toolsets)) {
    warnings.push('toolsets is not an object → ignored')
    out.toolsets = undefined
  }
  if (out.terminal !== undefined && !isPlainObject(out.terminal)) {
    warnings.push('terminal is not an object → ignored (local)')
    out.terminal = undefined
  }
  if (out.provider !== undefined && typeof out.provider !== 'string') {
    warnings.push('provider is not a string → ignored')
    out.provider = undefined
  }

  return { config: out as unknown as OpenClaudeConfig, warnings }
}

async function readConfigRaw(): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(paths.config, 'utf-8')
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ConfigValidationError(
      'FATAL',
      `openclaude.json is not valid JSON (${(err as Error).message}); file left untouched at ${paths.config}`,
    )
  }
}

/** 读 + 归一 + warnings。ENOENT → null;JSON 非法 / version / port 致命 → ConfigValidationError('FATAL')。 */
export async function readConfigWithWarnings(): Promise<{
  config: OpenClaudeConfig
  warnings: string[]
} | null> {
  const raw = await readConfigRaw()
  if (raw === null) return null
  return parseOpenClaudeConfig(raw)
}

export async function readConfig(): Promise<OpenClaudeConfig | null> {
  const parsed = await readConfigWithWarnings()
  return parsed?.config ?? null
}

// ──────── openclaude.json:原子写 + 跨进程锁 + 事务(CFG-02)────────
//
// gateway 的 OAuth 定时刷新(≤10min 一次)是运行时高频写入方;半写 = 下次启动 JSON.parse 抛 +
// 凭据全丢。与 agents.yaml 同形态:内核文件锁 + tmp + rename;锁超时 8s(同 advisorConfigStore)。

const CONFIG_LOCK_TIMEOUT_MS = 8_000

async function writeConfigUnlocked(cfg: OpenClaudeConfig): Promise<void> {
  await mkdir(dirname(paths.config), { recursive: true })
  const tmp = `${paths.config}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    await rename(tmp, paths.config)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** 整文件替换(onboard / pairing 等 CLI 一次性写)。运行时读-改-写请用 updateConfig。 */
export async function writeConfig(cfg: OpenClaudeConfig): Promise<void> {
  const lock = await acquireKernelFileLock(`${paths.config}.lock`, CONFIG_LOCK_TIMEOUT_MS)
  try {
    await writeConfigUnlocked(cfg)
  } finally {
    await lock.release()
  }
}

/**
 * 一次跨进程事务:锁内读(归一后)→ 回调就地修改 → 有变化才写回。
 * 文件不存在 → ConfigValidationError('MISSING')(不凭空发明一份配置);回调抛 → 不落盘、锁释放。
 */
export async function updateConfig<T>(
  update: (cfg: OpenClaudeConfig) => T | Promise<T>,
): Promise<{ config: OpenClaudeConfig; result: T }> {
  const lock = await acquireKernelFileLock(`${paths.config}.lock`, CONFIG_LOCK_TIMEOUT_MS)
  try {
    const config = await readConfig()
    if (!config)
      throw new ConfigValidationError(
        'MISSING',
        `openclaude.json not found at ${paths.config}; run \`openclaude onboard\` first`,
      )
    const before = JSON.stringify(config)
    const result = await update(config)
    if (JSON.stringify(config) !== before) await writeConfigUnlocked(config)
    return { config, result }
  } finally {
    await lock.release()
  }
}

// ──────── agents.yaml ────────

export interface AgentDef {
  id: string
  version?: string // Template version for tracking/attribution (auto-bumped on config change)
  model?: string
  persona?: string // 文件路径
  cwd?: string // agent 工作目录
  permissionMode?: PermissionMode
  // Toolsets: which named tool groups this agent has access to.
  // If undefined → inherits defaults.toolsets; if defaults.toolsets also undefined → all tools.
  toolsets?: ToolsetName[]
  // Persona display
  displayName?: string // 显示名称,如 "小克"
  avatarEmoji?: string // 头像 emoji,如 "🐱"
  greeting?: string // 新会话问候语
  // Per-agent provider & MCP overrides
  provider?: string // 覆盖全局 config.provider (如 "minimax", "anthropic", "deepseek")
  mcpServers?: McpServerConfig[] // agent 专属 MCP servers (合并到系统共享工具之上)
  updatedAt?: string // ISO timestamp of last config change
  // Provenance marker. 'marketplace' = installed from the AI market and managed by
  // the container pull-sync (added/updated/removed automatically); absent =
  // platform/user-authored (the sync never touches these). Used by the agents.yaml
  // reconcile to scope its add/remove to market-managed entries only.
  source?: 'marketplace'
  // Codex runner mode: 'exec' = legacy per-turn `codex exec` spawn (default);
  // 'app-server' = long-lived `codex app-server --listen stdio://` JSON-RPC
  // process with token-streaming via item/agentMessage/delta. Only meaningful
  // when provider='codex-native'.
  runnerKind?: 'exec' | 'app-server'
}

export interface RouteRule {
  match: { channel?: string; peerKind?: 'dm' | 'group'; peerIdPattern?: string }
  agent: string
}

// 旧重量级团队模式的 AgentTeamDef/AgentTeamMemberDef/AgentTeamPolicy 类型及
// AgentsConfig.teams 字段已随 team_run 子系统整套删除。agents.yaml 里若残留
// teams 键,parseYaml 只是原样带过,无消费方。
export interface AgentsConfig {
  agents: AgentDef[]
  routes: RouteRule[]
  default: string
}

function bootstrapAgentsConfig(): AgentsConfig {
  return { agents: [{ id: 'main' }], routes: [], default: 'main' }
}

/**
 * agents.yaml shape 归一(CFG-03):空文件 / 仅注释(parseYaml → null)与 ENOENT 同语义;
 * `agents` / `routes` 非数组 → 归一为数组(agents 为空时补 main);id 非字符串的条目丢弃;
 * `default` 缺失或指向不存在的 agent → 首个 agent。未知键(含残留 `teams:`)原样保留,写回不丢。
 */
export function normalizeAgentsConfig(raw: unknown): { config: AgentsConfig; warnings: string[] } {
  const warnings: string[] = []
  if (raw === null || raw === undefined) {
    return {
      config: bootstrapAgentsConfig(),
      warnings: ['agents.yaml is empty → bootstrap default (main)'],
    }
  }
  if (!isPlainObject(raw)) {
    warnings.push(
      `agents.yaml root is ${Array.isArray(raw) ? 'an array' : typeof raw}, expected a mapping → bootstrap default (main)`,
    )
    return { config: bootstrapAgentsConfig(), warnings }
  }
  const out: Record<string, unknown> = { ...raw }
  let agents: AgentDef[]
  if (!Array.isArray(out.agents)) {
    warnings.push(
      out.agents === undefined ? 'agents key missing → [main]' : 'agents is not a list → [main]',
    )
    agents = [{ id: 'main' }]
  } else {
    agents = out.agents.filter((a): a is AgentDef => {
      const ok = isPlainObject(a) && typeof a.id === 'string' && a.id !== ''
      if (!ok)
        warnings.push(`agents entry without string id dropped: ${JSON.stringify(a).slice(0, 80)}`)
      return ok
    })
    if (agents.length === 0) {
      warnings.push('agents list is empty → [main]')
      agents = [{ id: 'main' }]
    }
  }
  out.agents = agents
  if (!Array.isArray(out.routes)) {
    if (out.routes !== undefined) warnings.push('routes is not a list → []')
    out.routes = []
  }
  if (typeof out.default !== 'string' || !agents.some((a) => a.id === out.default)) {
    const fallback = agents[0].id
    warnings.push(
      out.default === undefined
        ? `default missing → ${fallback}`
        : `default ${JSON.stringify(out.default)} is not a configured agent → ${fallback}`,
    )
    out.default = fallback
  }
  return { config: out as unknown as AgentsConfig, warnings }
}

export async function readAgentsConfigWithWarnings(): Promise<{
  config: AgentsConfig
  warnings: string[]
}> {
  try {
    const raw = await readFile(paths.agentsYaml, 'utf-8')
    return normalizeAgentsConfig(parseYaml(raw))
  } catch (err: any) {
    if (err.code === 'ENOENT') return { config: bootstrapAgentsConfig(), warnings: [] }
    throw err
  }
}

export async function readAgentsConfig(): Promise<AgentsConfig> {
  return (await readAgentsConfigWithWarnings()).config
}

// ──────── agents.yaml:字段级校验(CFG-05 / CFG-07,API 与 CLI 写入前共用)────────
//
// 拍板口径(2026-09-18):persona 解析后必须在 OPENCLAUDE_HOME 内;cwd 必须是绝对路径、不得是
// 文件系统根 / 盘符根、不得位于系统目录;permissionMode / toolsets / mcpServers 做形状校验;
// mcpServers.command 只校非空字符串。只对**新写入**生效,读侧与存量不动。

export type AgentPatchValidation =
  | { ok: true; value: Partial<AgentDef> }
  | { ok: false; error: string }

const POSIX_SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot']

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? pathWin32 : pathPosix
}

function isWithinRoot(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const p = pathApi(platform)
  let c = p.resolve(candidate)
  let r = p.resolve(root)
  if (platform === 'win32') {
    c = c.toLowerCase()
    r = r.toLowerCase()
  }
  if (c === r) return true
  return c.startsWith(r.endsWith(p.sep) ? r : r + p.sep)
}

/** persona 路径必须落在 HOME 内(相对路径按 HOME 解析,与 identityCompatAssets.personaCandidate 同口径)。 */
export function isPersonaPathAllowed(
  persona: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof persona !== 'string' || persona.trim() === '' || persona.includes('\0')) return false
  const p = pathApi(platform)
  const absolute = p.isAbsolute(persona) ? p.resolve(persona) : p.resolve(home, persona)
  return isWithinRoot(absolute, home, platform)
}

/** cwd:绝对、非根、非系统目录。返回 null = 允许,否则给出拒绝原因。 */
export function cwdRejectReason(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0'))
    return 'cwd must be a non-empty string'
  const p = pathApi(platform)
  if (!p.isAbsolute(cwd)) return 'cwd must be an absolute path'
  const resolved = p.resolve(cwd)
  if (platform === 'win32') {
    const lower = resolved.toLowerCase()
    if (/^[a-z]:\\?$/.test(lower) || lower === '\\' || /^\\\\[^\\]+\\[^\\]+\\?$/.test(lower))
      return 'cwd must not be a drive or filesystem root'
    if (/^[a-z]:\\windows(\\|$)/.test(lower))
      return 'cwd must not be inside the Windows system directory'
    return null
  }
  if (resolved === '/') return 'cwd must not be the filesystem root'
  for (const dir of POSIX_SYSTEM_DIRS) {
    if (resolved === dir || resolved.startsWith(`${dir}/`)) return `cwd must not be inside ${dir}`
  }
  return null
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '')
}

function validateMcpServer(raw: unknown, index: number): string | null {
  if (!isPlainObject(raw)) return `mcpServers[${index}] must be an object`
  if (typeof raw.id !== 'string' || raw.id.trim() === '')
    return `mcpServers[${index}].id must be a non-empty string`
  if (typeof raw.command !== 'string' || raw.command.trim() === '')
    return `mcpServers[${index}].command must be a non-empty string`
  if (
    raw.args !== undefined &&
    !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string'))
  )
    return `mcpServers[${index}].args must be a string[]`
  if (
    raw.env !== undefined &&
    !(isPlainObject(raw.env) && Object.values(raw.env).every((v) => typeof v === 'string'))
  )
    return `mcpServers[${index}].env must be a Record<string,string>`
  for (const key of ['label', 'provider'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string')
      return `mcpServers[${index}].${key} must be a string`
  }
  if (
    raw.tools !== undefined &&
    !(Array.isArray(raw.tools) && raw.tools.every((t) => typeof t === 'string'))
  )
    return `mcpServers[${index}].tools must be a string[]`
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
    return `mcpServers[${index}].enabled must be a boolean`
  return null
}

/**
 * 校验 POST/PUT /api/agents 与 CLI 传入的 agent 字段。只回已知且合法的字段(`source` 等归属
 * 标记永远不从请求体来);未知键忽略;任一字段非法 → `{ok:false,error}`,调用方回 400 且不落盘。
 */
export function validateAgentPatch(
  body: unknown,
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): AgentPatchValidation {
  if (!isPlainObject(body)) return { ok: false, error: 'body must be a JSON object' }
  const home = opts.home ?? paths.home
  const platform = opts.platform ?? process.platform
  const value: Partial<AgentDef> = {}

  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !AGENT_ID_RE.test(body.id))
      return { ok: false, error: 'invalid agent id (use only a-z 0-9 _ -)' }
    value.id = body.id
  }
  for (const key of [
    'model',
    'displayName',
    'avatarEmoji',
    'greeting',
    'provider',
    'version',
  ] as const) {
    const v = body[key]
    if (v === undefined) continue
    if (typeof v !== 'string' || v.trim() === '')
      return { ok: false, error: `${key} must be a non-empty string` }
    value[key] = v
  }
  if (body.permissionMode !== undefined) {
    if (!(PERMISSION_MODES as readonly unknown[]).includes(body.permissionMode)) {
      return { ok: false, error: `permissionMode must be one of ${PERMISSION_MODES.join('|')}` }
    }
    value.permissionMode = body.permissionMode as PermissionMode
  }
  if (body.toolsets !== undefined) {
    if (!isStringArray(body.toolsets))
      return { ok: false, error: 'toolsets must be a string[] of toolset names' }
    value.toolsets = body.toolsets
  }
  if (body.mcpServers !== undefined) {
    if (!Array.isArray(body.mcpServers)) return { ok: false, error: 'mcpServers must be an array' }
    for (let i = 0; i < body.mcpServers.length; i++) {
      const problem = validateMcpServer(body.mcpServers[i], i)
      if (problem) return { ok: false, error: problem }
    }
    value.mcpServers = body.mcpServers as McpServerConfig[]
  }
  if (body.persona !== undefined) {
    if (!isPersonaPathAllowed(body.persona as string, home, platform)) {
      return { ok: false, error: 'persona must be a path inside OPENCLAUDE_HOME' }
    }
    value.persona = body.persona as string
  }
  if (body.cwd !== undefined) {
    const reason = cwdRejectReason(body.cwd as string, platform)
    if (reason) return { ok: false, error: reason }
    value.cwd = body.cwd as string
  }
  if (body.runnerKind !== undefined) {
    if (body.runnerKind !== 'exec' && body.runnerKind !== 'app-server')
      return { ok: false, error: 'runnerKind must be exec|app-server' }
    value.runnerKind = body.runnerKind
  }
  return { ok: true, value }
}

/** Whole-file replacement for bootstrap/import only. Live edits use updateAgentsConfig. */
export async function writeAgentsConfig(cfg: AgentsConfig): Promise<void> {
  const lock = await acquireKernelFileLock(`${paths.agentsYaml}.lock`)
  try {
    await writeAgentsConfigUnlocked(cfg)
  } finally {
    await lock.release()
  }
}

/**
 * One cross-process transaction for API/CLI edits and marketplace projection.
 * Lock BEFORE reading; locking only rename still loses concurrent local edits.
 * The callback may edit cfg in place. Do not nest a config writer inside it.
 * Persona writes coupled to agent ownership must also happen in this callback.
 */
export async function updateAgentsConfig<T>(
  update: (cfg: AgentsConfig) => T | Promise<T>,
): Promise<{ config: AgentsConfig; result: T }> {
  const lock = await acquireKernelFileLock(`${paths.agentsYaml}.lock`)
  try {
    const config = await readAgentsConfig()
    const before = JSON.stringify(config)
    const result = await update(config)
    if (JSON.stringify(config) !== before) await writeAgentsConfigUnlocked(config)
    return { config, result }
  } finally {
    await lock.release()
  }
}

async function writeAgentsConfigUnlocked(cfg: AgentsConfig): Promise<void> {
  await mkdir(dirname(paths.agentsYaml), { recursive: true })
  const tmp = `${paths.agentsYaml}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await writeFile(tmp, stringifyYaml(cfg), { mode: 0o600 })
    await rename(tmp, paths.agentsYaml)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Called inside updateAgentsConfig: ownership follows the FILE, not just its API id. */
export async function isMarketplacePersonaTarget(
  cfg: AgentsConfig,
  target: string,
): Promise<boolean> {
  async function identity(file: string) {
    const absolute = resolve(file)
    try {
      const canonical = await realpath(absolute)
      const info = await stat(canonical)
      return { absolute, canonical, dev: info.dev, ino: info.ino }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return { absolute, canonical: absolute, dev: undefined, ino: undefined }
    }
  }
  const requested = await identity(target)
  for (const agent of cfg.agents) {
    if (agent.source !== 'marketplace') continue
    const owned = await identity(agent.persona ?? paths.agentClaudeMd(agent.id))
    if (
      requested.absolute === owned.absolute ||
      requested.canonical === owned.canonical ||
      (requested.ino !== undefined && requested.ino === owned.ino && requested.dev === owned.dev)
    )
      return true
  }
  return false
}
