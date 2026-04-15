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

/** Predefined tool groups that can be assigned to agents or routes */
export type ToolsetName = 'assistant' | 'research' | 'coding' | 'browser' | string

/** Map toolset name → list of MCP server IDs included in that toolset */
export interface ToolsetDefs {
  [name: string]: string[] // e.g. { research: ['browser'], coding: ['openclaude-memory'] }
}

export interface UserEntry {
  id: string       // e.g. "boss"
  name: string     // display name
  passwordHash: string // scrypt hash
}

export interface OpenClaudeConfig {
  version: 1
  gateway: {
    bind: string // e.g. "127.0.0.1"
    port: number // 18789
    accessToken: string
    users?: UserEntry[] // multi-user: login with username+password
  }
  // 接入方式三选一(实际 token 由 CCB 自己存,这里只记录类型)
  auth: {
    mode: 'subscription' | 'api_key' | 'custom_platform'
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
    model: string // claude-opus-4-6 等
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan'
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
    telegram?: { enabled: boolean; botTokenRef?: string }
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
  updatedAt?: string // ISO timestamp of last config change
}

export interface RouteRule {
  match: { channel?: string; peerKind?: 'dm' | 'group'; peerIdPattern?: string }
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
