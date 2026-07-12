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

/** Selectable thinking-depth levels across the protocol + web composer.
 *  low/medium/high/xhigh/max map 1:1 to the official `claude --effort` flag.
 *  'ultracode' is a COMPOSITE level the CLI does NOT accept via --effort — the
 *  subprocess runner translates it to `--effort xhigh` + the `ultracode` session
 *  setting (xhigh reasoning + standing multi-agent Workflow orchestration).
 *  See buildClaudeCliArgs in gateway/subprocessRunner.ts. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
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
 *  actually in use (which is how the Codex GPT-5 family lost its control once the frontend
 *  stopped hardcoding it). Tolerates id variants (case, `anthropic/`/`openai/`
 *  prefixes). Used by both defaultModels() and /api/agents (per-agent + models
 *  backfill), so any model — pool member or an agent's own default — is gated
 *  consistently. Returns [] = no extra thinking-depth control. */
export function effortsForModel(modelId: string | undefined): EffortLevel[] {
  if (!modelId || typeof modelId !== 'string') return []
  const id = modelId.toLowerCase()
  const modelName = id.split('/').pop() ?? id
  // Codex GPT-5 reasoning depth. Maps to OpenAI Codex `model_reasoning_effort`.
  // Sol also supports `max`; keep Terra/Luna/GPT-5.5 on the verified common
  // subset. Do not add bare `gpt-5.6`, which ChatGPT-auth Codex rejects.
  if (/^gpt[-_]?5\.6[-_]sol$/.test(modelName)) {
    return ['low', 'medium', 'high', 'xhigh', 'max']
  }
  if (/^gpt[-_]?5\.5$/.test(modelName) || /^gpt[-_]?5\.6[-_](terra|luna)$/.test(modelName)) {
    return ['low', 'medium', 'high', 'xhigh']
  }
  // Claude Fable 5 — 旗舰,最强长程 agentic + 异步子代理编排。同 Opus 全档 + ultracode;
  // Fable 5 思考常驻(不接受 --thinking 关),深度全靠 --effort,ultracode 正对其多 agent 强项。
  if (/fable[-_]?5/.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
  // Claude Opus 4.8 — full ladder + ultracode. max 仍触发 buildResearchSlot 高严谨度守则;
  // ultracode = xhigh + 常驻 Workflow(多 agent)编排(runner 翻译,见 subprocessRunner)。
  if (/opus[-_]?4[-_]?8/.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
  // Claude Opus 4.7 — 同样全档 + ultracode,picker 切到 4.7 时档位行为不抖动。
  if (/opus[-_]?4[-_]?7/.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
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
    // Fable 5 — Anthropic 最强公开模型(旗舰)。非默认(默认仍是各 agent 自己的 model),
    // 仅作为可选覆盖;$10/$50 每百万 token 高于 Opus,且需订阅账号有权限 + 30 天数据保留(非 ZDR)。
    { id: 'claude-fable-5', label: 'Fable 5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    // Opus 4.7 仍保留,供想退回前一代模型的会话覆盖使用。
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
     * Personal-instance opt-in: when true, `/api/file` may serve files from ANY
     * directory (not just the generated/uploads allowlist), so the frontend can
     * render & download artifacts the agent writes anywhere on the box. Still
     * gated by login auth, the `..`-traversal block, a regular-file check, and the
     * sensitive-file denylist (FILE_BLOCKED_PATTERNS, checked on the realpath).
     *
     * DEFAULT FALSE — leave unset on the multi-tenant commercial product, where
     * arbitrary-directory reads would be a cross-tenant LFI. Only the single-user
     * personal deployment (boss owns the whole box) should enable this.
     */
    unrestrictedFileAccess?: boolean
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
    /**
     * Personal-instance opt-in: route the embedded ChatGPT web proxy
     * (`/api/chatgpt-web`) upstream through a Chrome-TLS-impersonating sidecar
     * (Python + curl_cffi). chatgpt.com sits behind Cloudflare's *managed
     * challenge*, which fingerprints the TLS handshake — Node's stack always
     * gets `cf-mitigated: challenge` (403), so the iframe shows OpenAI's
     * "Unable to load site" page. A Chrome-JA3 client passes it cleanly.
     *
     * The gateway supervises the sidecar as a child process. A missing venv or
     * a crashed sidecar NEVER blocks gateway startup — `/api/chatgpt-web` just
     * returns 502 with a clear message. Leave disabled unless the venv was
     * provisioned via `packages/gateway/scripts/setup-chatgpt-tls-sidecar.sh`.
     */
    chatgptTlsSidecar?: {
      enabled?: boolean
      /** Loopback port the sidecar listens on. Default 18992. */
      port?: number
      /** venv Python with curl_cffi installed.
       *  Default `/opt/openclaude/chatgpt-tls/venv/bin/python`. */
      pythonPath?: string
      /** Sidecar script path. Default resolved relative to the gateway pkg. */
      scriptPath?: string
      /** Egress proxy the sidecar dials chatgpt.com through (e.g. sing-box).
       *  Default: falls back to `config.proxyUrl`. */
      proxyUrl?: string
      /** curl_cffi impersonation target. Default `chrome`. */
      impersonate?: string
    }
    /**
     * Personal-instance opt-in: the "ChatGPT 实时浏览器" feature — a real headful
     * Chromium (Xvfb) per user, run by a gateway-supervised sidecar, egressing
     * through the sing-box proxy and streamed to the frontend as JPEG frames
     * over `/api/chatgpt-browser/ws`. The only way to deliver login (OAuth +
     * Arkose) / WebSocket / all ChatGPT features (the reverse proxy can't).
     *
     * Requires the runtime provisioned via setup-chatgpt-browser-sidecar.sh and
     * Xvfb installed. Missing runtime / crashed sidecar never blocks gateway
     * startup — the WS relay just fails the connection. Leave disabled otherwise.
     */
    chatgptBrowser?: {
      enabled?: boolean
      /** Loopback port the sidecar WS listens on. Default 18994. */
      port?: number
      /** Node project with playwright + chromium. Default /opt/openclaude/chatgpt-browser. */
      runtimeDir?: string
      /** Egress proxy the browser dials chatgpt through. Default config.proxyUrl. */
      proxyUrl?: string
      /** Per-user persistent profile base (login persists). Default /root/.openclaude/chatgpt-browser. */
      profileDir?: string
      /** Stealth init-script. Default $OPENCLAUDE_HOME/browser-stealth.js. */
      stealthScript?: string
      /** Render size, e.g. "1280x800". */
      viewport?: string
      /** PLAYWRIGHT_BROWSERS_PATH. Default /root/.cache/ms-playwright. */
      browsersPath?: string
      /** Prefer direct WebRTC video/input transport; JPEG-over-WS remains fallback. Default true. */
      webrtcEnabled?: boolean
      /** STUN/TURN URLs for ICE. Default ["stun:stun.cloudflare.com:3478"]. */
      webrtcIceServers?: string[]
      /** Fixed server UDP ICE range. Defaults 19000..19100. */
      webrtcPortMin?: number
      webrtcPortMax?: number
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
  /**
   * Self-heal OS privilege-drop identity. When set, the gateway spawns this
   * agent's codex subprocess under a NON-root Unix user (Node `spawn` uid/gid
   * drop) so a compromised/misbehaving codex cannot touch root-only production
   * assets (deploy scripts, systemd, secrets) — it must go through the
   * self-heal broker socket for any privileged action.
   *
   * NOT a free-form string. Only values in {@link RUN_AS_USER_ALLOWLIST} are
   * accepted; any other value fails config load (`assertValidRunAsUser`). Each
   * whitelisted identity maps to env-provided numeric uid/gid
   * ({@link resolveRunAsUserIds}). Undefined ⇒ no drop (spawns as the gateway
   * user, historical behavior — zero regression for every non-self-heal agent).
   */
  runAsUser?: RunAsUserName
  updatedAt?: string // ISO timestamp of last config change
}

/**
 * Allowlist of accepted `AgentDef.runAsUser` identities. This is the SINGLE
 * authority mapping a symbolic run-as identity → the env vars that hold the
 * numeric uid/gid the gateway must drop to. A fixed table (not a free string)
 * so a config edit can never point an agent at an arbitrary uid, and adding a
 * new drop identity is a deliberate, reviewed code change here.
 */
export const RUN_AS_USER_ALLOWLIST = {
  /** Self-heal codex operator — the non-root user that runs repair sessions. */
  ocheal: { uidEnv: 'OC_SELFHEAL_OCHEAL_UID', gidEnv: 'OC_SELFHEAL_OCHEAL_GID' },
} as const

export type RunAsUserName = keyof typeof RUN_AS_USER_ALLOWLIST

/**
 * The SINGLE agent id permitted to carry a `runAsUser` privilege-drop identity —
 * the self-heal repair operator. Any other agent with `runAsUser` fails config
 * load (Codex HIGH #6). This is the single authority for the id; the gateway's
 * execution ledger re-exports it so both sides agree.
 */
export const SELFHEAL_AGENT_ID = 'codex-v5ops'

/** Type guard: is `v` a whitelisted run-as identity? */
export function isAllowedRunAsUser(v: unknown): v is RunAsUserName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RUN_AS_USER_ALLOWLIST, v)
}

/**
 * Fail-fast validate an agent's `runAsUser`. Throws (at config load) when the
 * field is set to anything outside {@link RUN_AS_USER_ALLOWLIST}. Absent ⇒ ok.
 * This runs on EVERY agent, so a stray/hostile `runAsUser` on a normal agent is
 * rejected before it can ever be spawned.
 */
export function assertValidRunAsUser(
  agent: Pick<AgentDef, 'id' | 'runAsUser' | 'provider' | 'runnerKind'>,
): void {
  const v = agent.runAsUser as unknown
  if (v === undefined || v === null) return
  if (!isAllowedRunAsUser(v)) {
    throw new Error(
      `agent "${agent.id}": runAsUser=${JSON.stringify(v)} is not permitted; ` +
        `only [${Object.keys(RUN_AS_USER_ALLOWLIST).join(', ')}] may be used`,
    )
  }
  // Bind the drop identity to the designated self-heal agent + the only runner
  // that actually performs the uid/gid drop (Codex HIGH #6/#7). A stray
  // runAsUser on any other agent — or on a runner that would silently bypass the
  // drop and launch codex as root — fails config load.
  if (agent.id !== SELFHEAL_AGENT_ID) {
    throw new Error(
      `agent "${agent.id}": runAsUser is permitted only on the self-heal agent "${SELFHEAL_AGENT_ID}"`,
    )
  }
  if (agent.provider !== 'codex-native') {
    throw new Error(`agent "${agent.id}": runAsUser requires provider=codex-native`)
  }
  if (agent.runnerKind !== 'app-server') {
    throw new Error(
      `agent "${agent.id}": runAsUser requires runnerKind=app-server ` +
        `(the only runner that performs the OS privilege drop)`,
    )
  }
}

export interface RunAsUserIds {
  uid: number
  gid: number
}

/**
 * Resolve the numeric uid/gid for a whitelisted `runAsUser` from env. Throws
 * (fail-CLOSED) when:
 *   - the identity is not whitelisted, or
 *   - the env uid/gid is missing / non-integer, or
 *   - it resolves to 0 (root).
 *
 * A throw MUST be treated by callers as "refuse to spawn" — the gateway must
 * NEVER silently fall back to a root spawn for a privilege-drop agent. Reading
 * env (rather than baking numbers in) lets block C provision the real uid/gid
 * without a code change while keeping 0/root categorically rejected.
 */
export function resolveRunAsUserIds(runAsUser: string): RunAsUserIds {
  if (!isAllowedRunAsUser(runAsUser)) {
    throw new Error(`runAsUser=${JSON.stringify(runAsUser)} is not in the allowlist`)
  }
  const { uidEnv, gidEnv } = RUN_AS_USER_ALLOWLIST[runAsUser]
  const uidRaw = process.env[uidEnv]
  const gidRaw = process.env[gidEnv]
  const uid = Number(uidRaw)
  const gid = Number(gidRaw)
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error(
      `${uidEnv} must be a positive integer uid for runAsUser=${runAsUser} (got ${JSON.stringify(
        uidRaw ?? null,
      )})`,
    )
  }
  if (!Number.isInteger(gid) || gid <= 0) {
    throw new Error(
      `${gidEnv} must be a positive integer gid for runAsUser=${runAsUser} (got ${JSON.stringify(
        gidRaw ?? null,
      )})`,
    )
  }
  return { uid, gid }
}

/**
 * Validate an entire agents config at load time. Currently enforces the
 * `runAsUser` allowlist across all agents; extend here for future
 * cross-agent invariants. Throws on the first violation (fail-fast).
 */
export function validateAgentsConfig(cfg: AgentsConfig): void {
  for (const agent of cfg.agents ?? []) {
    assertValidRunAsUser(agent)
  }
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
    const cfg = parseYaml(raw) as AgentsConfig
    // Fail-fast on an illegal runAsUser (see RUN_AS_USER_ALLOWLIST). A normal
    // agents.yaml never carries runAsUser, so this is a no-op for existing
    // configs — it only blocks a stray/hostile drop identity from loading.
    validateAgentsConfig(cfg)
    return cfg
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
