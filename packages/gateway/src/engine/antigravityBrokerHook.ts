/**
 * OCV5-915 P3-2 — Live Antigravity `PreToolUse` ToolBroker hook projection (`gateway-engines` L2).
 *
 * Installs a fail-closed `PreToolUse` hook (`matcher: ".*"`, 65s timeout) on ALL
 * Antigravity turns (`normal`, `read_only`, `hermetic_no_tools`) whenever the
 * container ToolBroker is active, combining local fast read-only/hermetic guards
 * with live loopback HTTP evaluation at `/internal/v3/tool-broker/hook-evaluate`
 * (ActionPolicy + readOnly/hermetic + 55s blocking-then-detached approval).
 *
 * Architecture invariants:
 * - L2 `gateway-engines`: imports ONLY L0 `@openclaude/protocol/exec-env` and sibling
 *   `./antigravityReadOnlyGuard.js` (ZERO L3 `gateway-runtime` imports!).
 * - Zero `process.env`, zero `node:http`/`fetch`, zero `syncIo`, zero `emptyCatch`,
 *   zero `typeEscape`. Atomic 0400 writes delegate to `atomicWriteVerifiedMode400`.
 */
import { join } from 'node:path'
import {
  isLoopbackBrokerUrl,
  type ExecutionPolicyMode,
} from '@openclaude/protocol/exec-env'
import {
  ANTIGRAVITY_READ_ONLY_DIRECT_MCP_TOOLS,
  ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE,
  ANTIGRAVITY_READ_ONLY_HOOK_GROUP,
  ANTIGRAVITY_READ_ONLY_MCP_TOOLS,
  ANTIGRAVITY_READ_ONLY_NATIVE_TOOLS,
  atomicWriteVerifiedMode400,
  clearAntigravityHookGroupIfPresent,
  formatShellPath,
  installAntigravityReadOnlyGuard,
  resolveAntigravityReadOnlyPythonBin,
  type AntigravityReadOnlyGuardArtifacts,
} from './antigravityReadOnlyGuard.js'

const TOOL_BROKER_LOCAL_PREFIX = '/internal/v3/tool-broker'

export const ANTIGRAVITY_BROKER_HOOK_GROUP = 'openclaude-tool-broker'
export const ANTIGRAVITY_BROKER_GUARD_SCRIPT_NAME = 'broker_pretool_guard.py'
export const ANTIGRAVITY_HERMETIC_GUARD_SCRIPT_NAME = 'hermetic_guard.py'
export const ANTIGRAVITY_BROKER_HOOK_TOKEN_FILE = 'broker-hook-token'
export const ANTIGRAVITY_BROKER_MCP_TOKEN_FILE = 'broker-mcp-token'
export const ANTIGRAVITY_BROKER_HOOK_TIMEOUT_SEC = 65

const BROKER_READ_ONLY_NATIVE_TOOLS: readonly string[] = [
  ...ANTIGRAVITY_READ_ONLY_NATIVE_TOOLS,
  'search_extra_tools',
]

export interface AntigravityBrokerHookBinding {
  readonly brokerUrl: string
  readonly hookToken: string
  readonly mcpToken?: string
  readonly leaseId?: string
  readonly turnId?: string
  readonly credDir?: string
  readonly mode?: ExecutionPolicyMode
  readonly timeoutSec?: number
  readonly trackCredFile?: (filePath: string) => void
  readonly revoke?: () => void
}

export interface AntigravityBrokerHookProviderRequest {
  readonly sessionKey: string
  readonly gatewayPort: number
  readonly mode: ExecutionPolicyMode
  readonly workspaceCwd?: string
}

export type AntigravityBrokerHookProvider = (
  req: AntigravityBrokerHookProviderRequest,
) => AntigravityBrokerHookBinding | null

export interface AntigravityBrokerHookArtifacts {
  readonly pythonBin: string
  readonly guardScriptPath: string
  readonly guardScriptSha256: string
  readonly hooksConfigPath: string
  readonly hooksConfigSha256: string
  readonly hookTokenFile: string
  readonly mcpTokenFile: string | null
  readonly mode: ExecutionPolicyMode
  readonly timeoutSec: number
}

let activeBrokerHookProvider: AntigravityBrokerHookProvider | null = null

/** Register container ToolBroker hook provider (L3 -> L2 downward registration). */
export function registerAntigravityBrokerHookProvider(
  provider: AntigravityBrokerHookProvider | null,
): () => void {
  activeBrokerHookProvider = provider
  return () => {
    if (activeBrokerHookProvider === provider) {
      activeBrokerHookProvider = null
    }
  }
}

export function resolveActiveAntigravityBrokerHook(
  req: AntigravityBrokerHookProviderRequest,
): AntigravityBrokerHookBinding | null {
  return activeBrokerHookProvider ? activeBrokerHookProvider(req) : null
}

function formatPyStringSet(items: readonly string[]): string {
  return items.map((item) => `    ${JSON.stringify(item)},`).join('\n')
}

const ANTIGRAVITY_BROKER_HOOK_PY_BODY = `

def _emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\\n")
    sys.stdout.flush()


def _allow():
    _emit({"decision": "allow"})


def _deny(reason):
    _emit({"decision": "deny", "reason": str(reason or "broker_hook_denied")})


def _extract_tool_calls(payload):
    calls = []
    for key in ("toolCall", "tool_call"):
        if key in payload and payload[key] is not None:
            val = payload[key]
            if not isinstance(val, dict):
                return None
            calls.append(val)
    return calls


def _extract_tool_name(payload, calls):
    names = []
    for call in calls:
        for key in ("name", "tool_name", "toolName"):
            if key in call and call[key] is not None:
                val = call[key]
                if not isinstance(val, str) or not val or val.strip() != val:
                    return None
                names.append(val)
    for key in ("tool_name", "toolName"):
        if key in payload and payload[key] is not None:
            val = payload[key]
            if not isinstance(val, str) or not val or val.strip() != val:
                return None
            names.append(val)
    if not names:
        return None
    first = names[0]
    if any(n != first for n in names[1:]):
        return None
    return first


def _extract_args(payload, calls):
    found = []
    for call in calls:
        for key in ("args", "arguments", "input"):
            if key in call and call[key] is not None:
                val = call[key]
                if not isinstance(val, dict):
                    return None
                found.append(val)
    for key in ("tool_input", "toolInput"):
        if key in payload and payload[key] is not None:
            val = payload[key]
            if not isinstance(val, dict):
                return None
            found.append(val)
    if not found:
        return {}
    first = found[0]
    if any(item != first for item in found[1:]):
        return None
    return first


def _local_read_only_check(name, args):
    if name in ALLOWED_NATIVE_TOOLS or name in ALLOWED_DIRECT_MCP_TOOLS:
        return None
    if name == "call_mcp_tool":
        if not isinstance(args, dict):
            return "readonly_turn_forbidden:call_mcp_tool"
        server_keys = [k for k in ("ServerName", "server_name", "serverName") if k in args]
        tool_keys = [k for k in ("ToolName", "tool_name", "toolName") if k in args]
        if len(server_keys) != 1 or len(tool_keys) != 1:
            return "readonly_turn_forbidden:call_mcp_tool"
        server_name = args[server_keys[0]]
        tool_name = args[tool_keys[0]]
        if (
            isinstance(server_name, str)
            and server_name == "openclaude-memory"
            and isinstance(tool_name, str)
            and tool_name in ALLOWED_CALL_MCP_TOOLS
        ):
            return None
        if isinstance(tool_name, str) and tool_name.strip():
            return "readonly_turn_forbidden:call_mcp_tool:" + tool_name.strip()
        return "readonly_turn_forbidden:call_mcp_tool"
    return "readonly_turn_forbidden:" + name


def _extract_command(args):
    if not isinstance(args, dict):
        return None
    for key in ("command", "CommandLine", "cmd", "script"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return None


def main():
    try:
        raw = sys.stdin.read()
        if not raw or not raw.strip():
            _deny("broker_hook_invalid_payload")
            return
        payload = json.loads(raw)
    except Exception:
        _deny("broker_hook_invalid_payload")
        return

    if not isinstance(payload, dict):
        _deny("broker_hook_invalid_payload")
        return

    calls = _extract_tool_calls(payload)
    if calls is None:
        _deny("broker_hook_invalid_payload")
        return

    name = _extract_tool_name(payload, calls)
    if name is None:
        _deny("broker_hook_invalid_payload")
        return

    args = _extract_args(payload, calls)
    if args is None:
        _deny("broker_hook_invalid_payload")
        return

    if MODE == "hermetic_no_tools":
        _deny("hermetic_turn_forbidden:" + name)
        return

    if MODE == "read_only":
        local_err = _local_read_only_check(name, args)
        if local_err is not None:
            _deny(local_err)
            return

    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            hook_token = fh.read().strip()
    except Exception:
        _deny("broker_hook_token_unavailable")
        return

    if not hook_token.startswith("octh1."):
        _deny("broker_hook_token_invalid")
        return

    req_body = {"toolName": name, "arguments": args}
    cmd = _extract_command(args)
    if cmd is not None:
        req_body["command"] = cmd

    req = urllib.request.Request(
        EVALUATE_URL,
        data=json.dumps(req_body, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-OpenClaude-Broker-Hook-Token": hook_token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            status = getattr(resp, "status", resp.getcode())
            resp_raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        try:
            err_body = json.loads(exc.read().decode("utf-8", errors="replace"))
            reason = err_body.get("reason") or err_body.get("code") or ("broker_http_" + str(exc.code))
        except Exception:
            reason = "broker_http_" + str(exc.code)
        _deny(reason)
        return
    except Exception as exc:
        _deny("broker_hook_unreachable:" + type(exc).__name__)
        return

    if status != 200:
        _deny("broker_http_" + str(status))
        return

    try:
        parsed = json.loads(resp_raw)
    except Exception:
        _deny("broker_hook_invalid_response")
        return

    if isinstance(parsed, dict) and parsed.get("decision") == "allow":
        _allow()
        return

    reason = None
    if isinstance(parsed, dict):
        reason = parsed.get("reason") or parsed.get("code")
    _deny(reason or "broker_hook_denied")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        _deny("broker_hook_fatal")
`

export function buildAntigravityBrokerPreToolHookPy(opts: {
  readonly mode: ExecutionPolicyMode
  readonly brokerUrl: string
  readonly tokenFile: string
}): string {
  if (!isLoopbackBrokerUrl(opts.brokerUrl)) {
    throw new Error(
      `${ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE}: brokerUrl must be loopback HTTP`,
    )
  }
  const evaluateUrl = `${opts.brokerUrl.replace(/\/+$/, '')}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`
  const header = `#!/usr/bin/env python3
import json
import sys
import urllib.error
import urllib.request

MODE = ${JSON.stringify(opts.mode)}
EVALUATE_URL = ${JSON.stringify(evaluateUrl)}
TOKEN_FILE = ${JSON.stringify(opts.tokenFile)}
HTTP_TIMEOUT_SEC = 62

ALLOWED_NATIVE_TOOLS = frozenset({
${formatPyStringSet(BROKER_READ_ONLY_NATIVE_TOOLS)}
})

ALLOWED_DIRECT_MCP_TOOLS = frozenset({
${formatPyStringSet(ANTIGRAVITY_READ_ONLY_DIRECT_MCP_TOOLS)}
})

ALLOWED_CALL_MCP_TOOLS = frozenset({
${formatPyStringSet(ANTIGRAVITY_READ_ONLY_MCP_TOOLS)}
})`
  return `${header}${ANTIGRAVITY_BROKER_HOOK_PY_BODY}`
}

const ANTIGRAVITY_HERMETIC_OFFLINE_HOOK_PY = `#!/usr/bin/env python3
import json
import sys

def main():
    sys.stdout.write(json.dumps({"decision": "deny", "reason": "hermetic_turn_forbidden"}, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
`

export function buildAntigravityBrokerHooksConfig(
  pythonBin: string,
  scriptPath: string,
  timeoutSec: number = ANTIGRAVITY_BROKER_HOOK_TIMEOUT_SEC,
): Record<string, unknown> {
  const command = `${formatShellPath(pythonBin)} -I -B ${formatShellPath(scriptPath)}`
  return {
    [ANTIGRAVITY_BROKER_HOOK_GROUP]: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command,
              timeout: Math.max(5, Math.floor(timeoutSec)),
            },
          ],
        },
      ],
    },
  }
}

export function installAntigravityBrokerHook(opts: {
  readonly launchHome: string
  readonly configDir: string
  readonly credDir?: string
  readonly ensurePrivateDir?: (dir: string) => string
  readonly tokenFilePrefix?: string
  readonly mode: ExecutionPolicyMode
  readonly brokerUrl: string
  readonly hookToken: string
  readonly mcpToken?: string
  readonly pythonBinCandidates?: readonly string[]
  readonly timeoutSec?: number
  readonly trackCredFile?: (filePath: string) => void
}): AntigravityBrokerHookArtifacts {
  const pythonBin = resolveAntigravityReadOnlyPythonBin(opts.pythonBinCandidates)
  const timeoutSec = Math.max(5, Math.floor(opts.timeoutSec ?? ANTIGRAVITY_BROKER_HOOK_TIMEOUT_SEC))
  // B02: Place turn credentials outside launchHome (in gateway-private 0700 credDir) whenever supplied.
  const credBase = opts.credDir ?? opts.launchHome
  opts.ensurePrivateDir?.(credBase)
  const prefix = opts.tokenFilePrefix ? `${opts.tokenFilePrefix.replace(/[^A-Za-z0-9._-]/g, '_')}-` : ''
  const hookTokenFile = join(credBase, `${prefix}${ANTIGRAVITY_BROKER_HOOK_TOKEN_FILE}`)
  atomicWriteVerifiedMode400(hookTokenFile, `${opts.hookToken.trim()}\n`)
  opts.trackCredFile?.(hookTokenFile)

  let mcpTokenFile: string | null = null
  const trimmedMcpToken = opts.mcpToken?.trim()
  if (trimmedMcpToken) {
    mcpTokenFile = join(credBase, `${prefix}${ANTIGRAVITY_BROKER_MCP_TOKEN_FILE}`)
    atomicWriteVerifiedMode400(mcpTokenFile, `${trimmedMcpToken}\n`)
    opts.trackCredFile?.(mcpTokenFile)
  }

  const guardScriptPath = join(opts.launchHome, ANTIGRAVITY_BROKER_GUARD_SCRIPT_NAME)
  const guardSource = buildAntigravityBrokerPreToolHookPy({
    mode: opts.mode,
    brokerUrl: opts.brokerUrl,
    tokenFile: hookTokenFile,
  })
  const guardScriptSha256 = atomicWriteVerifiedMode400(guardScriptPath, guardSource)

  const hooksConfig = buildAntigravityBrokerHooksConfig(pythonBin, guardScriptPath, timeoutSec)
  const hooksConfigPath = join(opts.configDir, 'hooks.json')
  const hooksConfigSha256 = atomicWriteVerifiedMode400(
    hooksConfigPath,
    `${JSON.stringify(hooksConfig)}\n`,
  )

  return {
    pythonBin,
    guardScriptPath,
    guardScriptSha256,
    hooksConfigPath,
    hooksConfigSha256,
    hookTokenFile,
    mcpTokenFile,
    mode: opts.mode,
    timeoutSec,
  }
}

export function installAntigravityHermeticGuard(opts: {
  readonly launchHome: string
  readonly configDir: string
  readonly pythonBinCandidates?: readonly string[]
}): AntigravityReadOnlyGuardArtifacts {
  const pythonBin = resolveAntigravityReadOnlyPythonBin(opts.pythonBinCandidates)
  const guardScriptPath = join(opts.launchHome, ANTIGRAVITY_HERMETIC_GUARD_SCRIPT_NAME)
  const guardScriptSha256 = atomicWriteVerifiedMode400(
    guardScriptPath,
    ANTIGRAVITY_HERMETIC_OFFLINE_HOOK_PY,
  )
  const hooksConfig = buildAntigravityBrokerHooksConfig(pythonBin, guardScriptPath, 5)
  const hooksConfigPath = join(opts.configDir, 'hooks.json')
  const hooksConfigSha256 = atomicWriteVerifiedMode400(
    hooksConfigPath,
    `${JSON.stringify(hooksConfig)}\n`,
  )
  return {
    pythonBin,
    guardScriptPath,
    guardScriptSha256,
    hooksConfigPath,
    hooksConfigSha256,
  }
}

export interface ProjectAntigravityTurnHooksResult {
  readonly readOnlyGuard: AntigravityReadOnlyGuardArtifacts | null
  readonly brokerHook: AntigravityBrokerHookArtifacts | null
  readonly mcpBrokerEnv: Readonly<Record<string, string>>
  readonly revokeTurnTokens: (() => void) | null
}

function mergeEffectiveMode(
  turnMode: ExecutionPolicyMode,
  bindingMode?: ExecutionPolicyMode,
): ExecutionPolicyMode {
  if (turnMode === 'hermetic_no_tools' || bindingMode === 'hermetic_no_tools') {
    return 'hermetic_no_tools'
  }
  if (turnMode === 'read_only' || bindingMode === 'read_only') return 'read_only'
  return 'normal'
}

function projectBoundAntigravityBrokerHook(
  opts: {
    readonly launchHome: string
    readonly configDir: string
    readonly credDir?: string
    readonly ensurePrivateDir?: (dir: string) => string
  },
  mode: ExecutionPolicyMode,
  binding: AntigravityBrokerHookBinding,
): ProjectAntigravityTurnHooksResult {
  const effectiveMode = mergeEffectiveMode(mode, binding.mode)
  const resolvedCredDir = binding.credDir ?? opts.credDir
  const tokenFilePrefix = binding.turnId ?? `turn_${Date.now().toString(36)}`
  let artifacts: AntigravityBrokerHookArtifacts
  try {
    artifacts = installAntigravityBrokerHook({
      launchHome: opts.launchHome,
      configDir: opts.configDir,
      ...(resolvedCredDir ? { credDir: resolvedCredDir, tokenFilePrefix } : {}),
      ensurePrivateDir: opts.ensurePrivateDir,
      mode: effectiveMode,
      brokerUrl: binding.brokerUrl,
      hookToken: binding.hookToken,
      mcpToken: binding.mcpToken,
      timeoutSec: binding.timeoutSec ?? ANTIGRAVITY_BROKER_HOOK_TIMEOUT_SEC,
      trackCredFile: binding.trackCredFile,
    })
  } catch (err) {
    binding.revoke?.()
    throw err
  }
  const mcpBrokerEnv: Record<string, string> = {
    OPENCLAUDE_TOOL_BROKER_URL: binding.brokerUrl,
    ...(artifacts.mcpTokenFile
      ? { OPENCLAUDE_TOOL_BROKER_MCP_TOKEN_FILE: artifacts.mcpTokenFile }
      : {}),
    ...(binding.leaseId ? { OPENCLAUDE_TOOL_BROKER_LEASE_ID: binding.leaseId } : {}),
    ...(binding.turnId ? { OPENCLAUDE_TOOL_BROKER_TURN_ID: binding.turnId } : {}),
  }
  const readOnlyGuard: AntigravityReadOnlyGuardArtifacts | null =
    effectiveMode === 'normal'
      ? null
      : {
          pythonBin: artifacts.pythonBin,
          guardScriptPath: artifacts.guardScriptPath,
          guardScriptSha256: artifacts.guardScriptSha256,
          hooksConfigPath: artifacts.hooksConfigPath,
          hooksConfigSha256: artifacts.hooksConfigSha256,
        }
  return {
    readOnlyGuard,
    brokerHook: artifacts,
    mcpBrokerEnv,
    revokeTurnTokens: binding.revoke ?? null,
  }
}

/**
 * Unified turn hook projection for `antigravityPlatform.ts`.
 * - When a live ToolBroker binding is present (explicit or registered by Gateway),
 *   installs the 65s `PreToolUse` broker hook on ALL turns (`normal`, `read_only`,
 *   `hermetic_no_tools`) with credentials isolated outside `launchHome` (B02) and
 *   returns scoped MCP broker env variables plus synchronous `revokeTurnTokens`.
 * - When standalone (no Gateway broker active), preserves fail-closed offline
 *   `readonly_guard.py` / hermetic guard and scrubs stale hooks on normal turns.
 */
export function projectAntigravityTurnHooks(opts: {
  readonly launchHome: string
  readonly configDir: string
  readonly sharedConfigDir: string
  readonly credDir?: string
  readonly ensurePrivateDir?: (dir: string) => string
  readonly sessionKey: string
  readonly gatewayPort: number
  readonly readOnly: boolean
  readonly hermeticNoTools: boolean
  readonly workspaceCwd?: string
  readonly explicitBrokerHook?: AntigravityBrokerHookBinding | null
}): ProjectAntigravityTurnHooksResult {
  const mode: ExecutionPolicyMode = opts.hermeticNoTools
    ? 'hermetic_no_tools'
    : opts.readOnly
      ? 'read_only'
      : 'normal'

  if (!opts.readOnly && !opts.hermeticNoTools) {
    clearAntigravityHookGroupIfPresent(opts.sharedConfigDir, ANTIGRAVITY_READ_ONLY_HOOK_GROUP)
    clearAntigravityHookGroupIfPresent(opts.sharedConfigDir, ANTIGRAVITY_BROKER_HOOK_GROUP)
  }

  const binding =
    opts.explicitBrokerHook !== undefined
      ? opts.explicitBrokerHook
      : resolveActiveAntigravityBrokerHook({
          sessionKey: opts.sessionKey,
          gatewayPort: opts.gatewayPort,
          mode,
          ...(opts.workspaceCwd ? { workspaceCwd: opts.workspaceCwd } : {}),
        })

  if (binding) return projectBoundAntigravityBrokerHook(opts, mode, binding)

  if (opts.hermeticNoTools) {
    return {
      readOnlyGuard: installAntigravityHermeticGuard({
        launchHome: opts.launchHome,
        configDir: opts.configDir,
      }),
      brokerHook: null,
      mcpBrokerEnv: {},
      revokeTurnTokens: null,
    }
  }

  if (opts.readOnly) {
    return {
      readOnlyGuard: installAntigravityReadOnlyGuard({
        launchHome: opts.launchHome,
        configDir: opts.configDir,
      }),
      brokerHook: null,
      mcpBrokerEnv: {},
      revokeTurnTokens: null,
    }
  }

  clearAntigravityHookGroupIfPresent(opts.configDir, ANTIGRAVITY_READ_ONLY_HOOK_GROUP)
  clearAntigravityHookGroupIfPresent(opts.configDir, ANTIGRAVITY_BROKER_HOOK_GROUP)
  return { readOnlyGuard: null, brokerHook: null, mcpBrokerEnv: {}, revokeTurnTokens: null }
}
