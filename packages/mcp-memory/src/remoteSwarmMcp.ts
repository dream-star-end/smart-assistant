/**
 * MCP client adapter for Remote Antigravity Swarm tools (`swarm`, `post_message`,
 * `read_board`, `swarm_wait`, OCV5-835).
 *
 * Calls back to the container gateway's loopback-only `/internal/v3/remote-swarm/<tool>`
 * endpoint authenticated with the container gateway token and gateway-injected session/member
 * env vars (`OPENCLAUDE_REMOTE_SWARM_SESSION_KEY` / `OPENCLAUDE_REMOTE_SWARM_MEMBER`).
 */
import { REMOTE_SWARM_LOCAL_PREFIX } from '@openclaude/protocol'
import {
  describeDelegateTransportError,
  gatewayAuthHeaders,
  gatewayBaseUrl,
  postJsonToGateway,
} from './gatewayClient.js'
import { MEMORY_MCP_REMOTE_SWARM_TOOL_NAMES } from './toolNames.js'

const REMOTE_SWARM_TOOL_SET = new Set<string>(MEMORY_MCP_REMOTE_SWARM_TOOL_NAMES)
const REMOTE_SWARM_SESSION_HEADER = 'x-oc-remote-swarm-session'
const REMOTE_SWARM_MEMBER_HEADER = 'x-oc-remote-swarm-member'
const REMOTE_SWARM_TOKEN_HEADER = 'x-oc-remote-swarm-token'

export function isRemoteSwarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENCLAUDE_REMOTE_SWARM_ENABLED ?? '').trim() === '1'
}

export function isRemoteSwarmToolName(name: string): boolean {
  return REMOTE_SWARM_TOOL_SET.has(name)
}

export async function handleRemoteSwarmTool(
  name: string,
  args: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (!isRemoteSwarmEnabled(env)) {
    return {
      content: [{ type: 'text', text: `error: ${name} is only available in remote Antigravity sessions` }],
      isError: true,
    }
  }
  const sessionKey = (
    env.OPENCLAUDE_REMOTE_SWARM_SESSION_KEY ||
    env.OPENCLAUDE_SESSION_KEY ||
    ''
  ).trim()
  if (!sessionKey) {
    return {
      content: [{ type: 'text', text: 'error: missing OPENCLAUDE_REMOTE_SWARM_SESSION_KEY' }],
      isError: true,
    }
  }
  const callerToken = (env.OPENCLAUDE_REMOTE_SWARM_TOKEN ?? '').trim()
  if (!callerToken) {
    return {
      content: [{ type: 'text', text: 'error: missing OPENCLAUDE_REMOTE_SWARM_TOKEN' }],
      isError: true,
    }
  }
  const member = (env.OPENCLAUDE_REMOTE_SWARM_MEMBER || 'coordinator').trim() || 'coordinator'
  const url = `${gatewayBaseUrl()}${REMOTE_SWARM_LOCAL_PREFIX}/${encodeURIComponent(name)}`
  const timeoutMs = name === 'swarm_wait' ? 315_000 : 30_000

  try {
    const res = await postJsonToGateway(url, {
      headers: {
        ...gatewayAuthHeaders(),
        [REMOTE_SWARM_SESSION_HEADER]: sessionKey,
        [REMOTE_SWARM_MEMBER_HEADER]: member,
        [REMOTE_SWARM_TOKEN_HEADER]: callerToken,
      },
      body: JSON.stringify(args ?? {}),
      timeoutMs,
    })
    let parsed: Record<string, unknown> | null = null
    try {
      const obj = JSON.parse(res.body) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>
      }
    } catch {
      /* non-JSON fallback */
    }
    if (res.statusCode < 200 || res.statusCode >= 300 || parsed?.ok === false) {
      const errMsg =
        (typeof parsed?.error === 'string' && parsed.error) ||
        res.body.slice(0, 500) ||
        `HTTP ${res.statusCode}`
      return {
        content: [{ type: 'text', text: `error: ${errMsg}` }],
        isError: true,
      }
    }
    const text =
      typeof parsed?.text === 'string'
        ? parsed.text
        : JSON.stringify(parsed ?? res.body, null, 2)
    return {
      content: [{ type: 'text', text }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `error: remote swarm RPC failed: ${describeDelegateTransportError(err)}` }],
      isError: true,
    }
  }
}
