/**
 * oc-browser shared layout — paths + wire protocol shared by the daemon
 * (ocBrowserDaemon.ts) and the thin CLI (ocBrowserCli.ts).
 *
 * Architecture: the daemon keeps ONE `@playwright/mcp` child alive (so a
 * `snapshot → click` workflow shares the browser session across separate CLI
 * invocations) and exposes its tools over a per-agent Unix socket. The CLI is a
 * stateless client that maps argv → {tool,args}, (lazy-)starts the daemon, sends
 * one request, prints the result, and exits.
 *
 * Per-agent isolation: each agent gets its own daemon + socket + browser profile.
 * Within one container (single Unix user) this is accidental isolation, not a
 * security boundary — it only stops the captain and team members from clobbering
 * each other's browser state.
 */

import { join } from 'node:path'

// Root for per-agent runtime state. /run/oc is the established v3 runtime tmp
// root (codex-auth, agent dirs); fall back to /tmp outside the container image.
export function ocBrowserStateRoot(): string {
  return process.env.OPENCLAUDE_OC_BROWSER_ROOT?.trim() || '/run/oc/browser'
}

export function ocBrowserAgentId(): string {
  return process.env.OPENCLAUDE_AGENT_ID?.trim() || 'default'
}

// Per-agent dir (0700), holding the socket + start lock + pid file.
export function ocBrowserAgentDir(agentId: string): string {
  // Sanitize: agent ids are platform-controlled, but keep the path a single
  // segment so a malformed id can never escape the state root.
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default'
  return join(ocBrowserStateRoot(), safe)
}

export function ocBrowserSocketPath(agentId: string): string {
  return join(ocBrowserAgentDir(agentId), 'daemon.sock')
}

export function ocBrowserLockDir(agentId: string): string {
  return join(ocBrowserAgentDir(agentId), 'start.lock')
}

// Playwright user-data-dir — preserves the historical per-agent profile that
// SubprocessRunner used to append to the browser MCP args.
export function ocBrowserUserDataDir(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default'
  return `/tmp/openclaude-browser-${safe}`
}

// The 7 browser tools the daemon must expose (kept in sync with @playwright/mcp).
// The daemon validates these exist via tools/list at startup so a pinned-version
// bump that renames a tool fails loudly instead of at call time.
export const OC_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_take_screenshot',
  'browser_wait_for',
] as const

export type OcBrowserRequest = { tool: string; args: Record<string, unknown> }
export type OcBrowserResponse = { ok: true; result: unknown } | { ok: false; error: string }
