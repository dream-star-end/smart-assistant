import type { InboundFrame, OutboundMessage } from '@openclaude/protocol'

// ══════════════════════════════════════════════════════
// Plugin base — all plugin types share these fundamentals
// ══════════════════════════════════════════════════════

export interface PluginMeta {
  /** Unique plugin ID (e.g. "telegram", "minimax-vision", "docker-backend") */
  readonly id: string
  /** Human-readable name */
  readonly name: string
  /** Plugin type discriminator */
  readonly type: PluginType
}

export type PluginType = 'channel' | 'provider' | 'automation' | 'capability'

export interface PluginContext {
  /** Dispatch an inbound frame to the gateway */
  dispatch(frame: InboundFrame): void
  /** Logger */
  log: { info: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void }
  /** Configuration from ~/.openclaude/openclaude.json */
  config: Record<string, unknown>
}

// ══════════════════════════════════════════════════════
// Channel Plugin (existing ChannelAdapter, now with PluginMeta)
// ══════════════════════════════════════════════════════

export interface ChannelAdapter extends PluginMeta {
  readonly type: 'channel'
  init(ctx: ChannelContext): Promise<void>
  send(out: OutboundMessage): Promise<void>
  shutdown(): Promise<void>
}

export interface ChannelContext extends PluginContext {}

export type ChannelFactory = (channelConfig: unknown) => ChannelAdapter

// ══════════════════════════════════════════════════════
// Provider Plugin — model provider extensions
// ══════════════════════════════════════════════════════

export interface ProviderPlugin extends PluginMeta {
  readonly type: 'provider'
  /** Provider ID (e.g. "minimax", "deepseek", "gemini") */
  readonly providerId: string
  /** Available models */
  models: string[]
  /** MCP server configs to inject when this provider is active */
  mcpServers?: Array<{
    id: string
    command: string
    args?: string[]
    env?: Record<string, string>
  }>
  /** Initialize the provider */
  init?(ctx: PluginContext): Promise<void>
  /** Shutdown */
  shutdown?(): Promise<void>
}

// ══════════════════════════════════════════════════════
// Automation Plugin — webhook handlers, event processors
// ══════════════════════════════════════════════════════

export interface AutomationPlugin extends PluginMeta {
  readonly type: 'automation'
  /** Event types this plugin listens to */
  eventTypes: string[]
  /** Initialize with context */
  init(ctx: PluginContext): Promise<void>
  /** Handle an event */
  handle(event: { type: string; payload: unknown }): Promise<void>
  /** Shutdown */
  shutdown(): Promise<void>
}

// ══════════════════════════════════════════════════════
// Capability Plugin — extends agent capabilities
// (e.g. remote execution nodes, hardware access)
// ══════════════════════════════════════════════════════

export interface CapabilityPlugin extends PluginMeta {
  readonly type: 'capability'
  /** Capabilities this plugin provides (e.g. "bash", "filesystem", "gpu", "browser") */
  capabilities: string[]
  /**
   * Host identifier for remote capability nodes (future extension).
   * When undefined, the capability runs on the local machine.
   * Future: "worker-1.example.com", "gpu-node-3", etc.
   */
  host?: string
  /** Initialize */
  init(ctx: PluginContext): Promise<void>
  /** Shutdown */
  shutdown(): Promise<void>
}

// ══════════════════════════════════════════════════════
// Union type for all plugins
// ══════════════════════════════════════════════════════

export type OpenClaudePlugin = ChannelAdapter | ProviderPlugin | AutomationPlugin | CapabilityPlugin

/** Plugin factory: called during gateway startup to create plugin instances */
export type PluginFactory = (config: unknown) => OpenClaudePlugin
