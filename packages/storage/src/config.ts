import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { paths } from './paths.js'

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

/** Thinking-depth levels the official `claude --effort` flag accepts. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** A selectable model for the web composer's model picker (per-session override). */
export interface ModelChoice {
  /** Model id passed to `claude --model` (gateway does not validate). */
  id: string
  /** Human label shown in the picker. */
  label: string
  /** Thinking-depth levels exposed for this model; empty/undefined hides the
   *  effort control. Must be a subset of EFFORT_LEVELS. */
  efforts?: EffortLevel[]
}

/** Single source of truth for which thinking-depth levels a model exposes in
 *  the UI. Capability is an INTRINSIC property of the model, derived from its id
 *  family — not a hand-maintained table that drifts out of sync with the agents
 *  actually in use (which is how gpt-5.5 lost its control once the frontend
 *  stopped hardcoding it). Tolerates id variants (case, `anthropic/`/`openai/`
 *  prefixes). Used by both defaultModels() and /api/agents (per-agent + models
 *  backfill), so any model — pool member or an agent's own default — is gated
 *  consistently. Returns [] = no extra thinking-depth control. */
export function effortsForModel(modelId: string | undefined): EffortLevel[] {
  if (!modelId || typeof modelId !== 'string') return []
  const id = modelId.toLowerCase()
  // Codex / GPT-5.5 reasoning depth. Maps to codex `model_reasoning_effort`
  // (low/medium/high/xhigh — codex exposes no `max`); see codexLaunchOverrides.
  if (/(^|[/_-])gpt[-_]?5\.5($|[/_-])/.test(id)) return ['low', 'medium', 'high', 'xhigh']
  // Claude Opus 4.8 — full depth incl. 科研模式 (max).
  if (/opus[-_]?4[-_]?8/.test(id)) return ['high', 'xhigh', 'max']
  // Claude Opus 4.7 — legacy 编码/科研模式 (xhigh/max).
  if (/opus[-_]?4[-_]?7/.test(id)) return ['xhigh', 'max']
  // Claude Sonnet 4.6.
  if (/sonnet[-_]?4[-_]?6/.test(id)) return ['high', 'xhigh']
  // Haiku / MiniMax / anything else — no extra thinking-depth control.
  return []
}

/** Default model registry (used when `config.models` is unset). Seeded to the
 *  current subscription Claude family; operators edit `config.models` to add or
 *  remove. ids/labels are editable — keep them in sync with what the account can
 *  actually serve. `efforts` is derived from effortsForModel() (single authority)
 *  so the seed never disagrees with /api/agents capability gating. */
export function defaultModels(): ModelChoice[] {
  return [
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    // Opus 4.7 is the current default agent model on this install — keep it in
    // the seed so the picker lists it AND the thinking-depth control stays
    // available (preserves the legacy 编码/科研模式 = xhigh/max).
    { id: 'claude-opus-4-7', label: 'Opus 4.7' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ].map((m) => {
    const efforts = effortsForModel(m.id)
    return efforts.length > 0 ? { ...m, efforts } : m
  })
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
     * 5MB). On the personal instance, where `boss` regularly backgrounds the
     * mobile tab for >10min during long agent runs, raise `maxAgeMs` so the
     * resume replay path can still serve frames after the default window.
     */
    outboundRing?: {
      maxEntries?: number
      maxAgeMs?: number
      maxBytes?: number
    }
    /**
     * Optional Redis acceleration layer for WebChat outbound frames.
     * SQLite remains the source of truth; Redis is only used for short-lived
     * pub/sub fanout and replay cache. Keep disabled unless a local/private
     * Redis is available (personal deployments should bind Redis to 127.0.0.1).
     */
    redis?: {
      enabled?: boolean
      url?: string
      keyPrefix?: string
      replayTtlMs?: number
      maxReplayFrames?: number
      reserveTimeoutMs?: number
      /** Short-lived Redis cache for client session list/full snapshots. */
      sessionCacheTtlMs?: number
      /** Skip caching oversized full-session snapshots. */
      maxSessionSnapshotBytes?: number
    }
    /**
     * Optional startup warm pool for frequently resumed WebChat sessions.
     * This is intentionally opt-in and bounded because each warmed Codex
     * app-server is a real subprocess with platform-context MCP wiring.
     */
    warmPool?: {
      enabled?: boolean
      /** Number of recent webchat sessions to warm. Clamped by gateway. */
      maxWebchatSessions?: number
      /** Delay after HTTP server start before warming, so /healthz is fast. */
      startupDelayMs?: number
      /** Per-session warmup timeout; timed-out warmups are torn down. */
      warmupTimeoutMs?: number
      /** Keep true for the safe first pass: only codex app-server supports no-turn warmup. */
      codexAppServerOnly?: boolean
      /** Optional owner allowlist used only for ranking recent client sessions. */
      includeUsers?: string[]
    }
  }
  // 接入方式三选一(实际 token 由官方 claude 自己存,这里只记录类型)
  auth: {
    mode: 'subscription' | 'api_key' | 'custom_platform'
    // 可选:官方 `claude` 二进制路径覆盖。缺省时 resolveOfficialClaudePath()
    // 解析 OPENCLAUDE_OFFICIAL_CLAUDE_PATH → ~/.local/bin/claude → PATH 上的 claude。
    claudeCliPath?: string
    // 可选(已弃用):旧的内置 fork 工程目录。聊天引擎已改 spawn 官方 claude,
    // 此字段不再用于 spawn,仅作为 resolveMcpMemoryEntry 的兜底定位提示而保留兼容。
    claudeCodePath?: string
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
    model: string // claude-opus-4-6 等
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan'
    toolsets?: ToolsetName[] // default toolsets for all agents (if not overridden)
  }
  // 前台"模型选择器"的可选列表(per-session 覆盖用)。缺省时用 defaultModels()
  // 的 Claude 家族 seed。`efforts` 列举该 model 在 UI 可调的思考深度档,空/缺省
  // = 不显示思考深度控件。id 即官方 `claude --model` 接受的值,gateway 不本地校验。
  models?: ModelChoice[]
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
    telegram?: { enabled: boolean; botTokenRef?: string }
    wechat?: { enabled: boolean; corpIdRef?: string }
    feishu?: { enabled: boolean; appIdRef?: string }
  }
  // Multi-provider MCP server registry — auto-merged into every CCB subprocess
  mcpServers?: McpServerConfig[]
  /**
   * Global outbound HTTP proxy URL for all provider subprocesses.
   * Format: `http://user:pass@host:port` or `http://host:port`.
   *
   * Effective resolution order: agent.proxyUrl > config.proxyUrl > (provider default).
   *   - codex (codexRunner / codexAppServerRunner): explicit-only — when both
   *     unset, codex subprocess starts without any *_PROXY env (existing
   *     invariant from buildCodexEnv, kept).
   *   - CCB (subprocessRunner) / others: when both unset, the subprocess
   *     inherits the gateway process env (typically systemd HTTPS_PROXY).
   *
   * Empty string / undefined → no override (falls through to provider default).
   * Change semantics: applies to subprocesses spawned after the save. Already
   * running long-lived runners (e.g. codex app-server) keep their original env
   * until they're respawned.
   */
  proxyUrl?: string
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

export async function readConfig(): Promise<OpenClaudeConfig | null> {
  try {
    const raw = await readFile(paths.config, 'utf-8')
    return JSON.parse(raw) as OpenClaudeConfig
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function writeConfig(cfg: OpenClaudeConfig): Promise<void> {
  await mkdir(dirname(paths.config), { recursive: true })
  await writeFile(paths.config, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

// ──────── agents.yaml ────────

export interface AgentDef {
  id: string
  version?: string // Template version for tracking/attribution (auto-bumped on config change)
  model?: string
  persona?: string // 文件路径
  cwd?: string // agent 工作目录
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan'
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
  // Codex backend selection (only consulted when provider === 'codex-native').
  // 'exec'        — legacy `codex exec [resume] --json` subprocess (one process per turn,
  //                 no token-level streaming, current default for backward compat).
  // 'app-server'  — `codex app-server --listen stdio://` long-lived JSON-RPC subprocess
  //                 (token-level item/agentMessage/delta streaming).
  // Undefined on codex-native agents is normalized to 'app-server' by Agent API.
  runnerKind?: 'exec' | 'app-server'
  /**
   * Optional per-agent egress HTTP proxy URL — overrides the global
   * `OpenClaudeConfig.proxyUrl` for this agent only.
   * Format: full URL with optional credentials, e.g.
   * `http://user:pass@host:port` or `http://host:port`.
   *
   * Honored by all runners that `sessionManager` resolves to a non-empty
   * effective URL:
   *   - codex (codex-native / codex-app-server): explicit-only injection
   *     into the spawned codex CLI subprocess env (HTTPS_PROXY/HTTP_PROXY +
   *     lowercase variants). When unset everywhere, codex starts without
   *     any *_PROXY env (does NOT inherit `process.env.HTTPS_PROXY`) — so
   *     a system-level HTTPS_PROXY (e.g. systemd unit) does not silently
   *     change codex behavior.
   *   - CCB (subprocessRunner): non-empty values overlay the inherited
   *     gateway process env. When unset everywhere, CCB keeps its
   *     historical inherit behaviour (systemd `HTTPS_PROXY` / NO_PROXY
   *     carve-outs still apply).
   *
   * undefined / "" → fall through to `OpenClaudeConfig.proxyUrl`, then to
   * the provider default described above.
   */
  proxyUrl?: string
  updatedAt?: string // ISO timestamp of last config change
}

export interface RouteRule {
  match: {
    channel?: string
    peerKind?: 'dm' | 'group'
    peerIdPattern?: string
  }
  agent: string
}

export interface AgentsConfig {
  agents: AgentDef[]
  routes: RouteRule[]
  default: string
}

export async function readAgentsConfig(): Promise<AgentsConfig> {
  try {
    const raw = await readFile(paths.agentsYaml, 'utf-8')
    return parseYaml(raw) as AgentsConfig
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { agents: [{ id: 'main' }], routes: [], default: 'main' }
    }
    throw err
  }
}

export async function writeAgentsConfig(cfg: AgentsConfig): Promise<void> {
  await mkdir(dirname(paths.agentsYaml), { recursive: true })
  await writeFile(paths.agentsYaml, stringifyYaml(cfg), { mode: 0o600 })
}
