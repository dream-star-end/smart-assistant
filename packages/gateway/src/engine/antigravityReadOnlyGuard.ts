/**
 * Hard out-of-process read-only sandbox guard for local Antigravity CLI turns
 * (OCV5-893). Uses Antigravity CLI's native `$HOME/.gemini/config/hooks.json`
 * `PreToolUse` command hook with a strict fail-closed Python allowlist.
 *
 * Kept in its own `gateway-engines` module (zero `process.env` reads) to avoid
 * bloating `antigravityAdapter.ts` / `antigravityPlatform.ts` and to satisfy
 * architecture rule R3-env and the file-size ratchet.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const ANTIGRAVITY_READ_ONLY_HOOK_GROUP = 'openclaude-local-readonly'
export const ANTIGRAVITY_READ_ONLY_GUARD_SCRIPT_NAME = 'readonly_guard.py'
export const ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE = 'ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE'

export const ANTIGRAVITY_READ_ONLY_NATIVE_TOOLS = [
  'read_file',
  'search_web',
  'list_resources',
  'read_resource',
  'exit_plan_mode',
] as const

export const ANTIGRAVITY_READ_ONLY_EAGER_MCP_TOOLS = [
  'oc_grep',
  'oc_glob',
  'skill_search',
  'skill_view',
] as const

export const ANTIGRAVITY_READ_ONLY_MCP_TOOLS = [
  'oc_grep',
  'oc_glob',
  'skill_search',
  'skill_view',
  'skill_list',
  'list_reminders',
  'task_list',
  'task_get',
  'project_search',
] as const

export const ANTIGRAVITY_READ_ONLY_DIRECT_MCP_TOOLS = [
  'mcp_openclaude-memory_oc_grep',
  'mcp_openclaude-memory_oc_glob',
  'mcp_openclaude-memory_skill_search',
  'mcp_openclaude-memory_skill_view',
] as const

const DEFAULT_PYTHON3_CANDIDATES: readonly string[] = Object.freeze([
  '/usr/bin/python3',
  '/usr/local/bin/python3',
  '/bin/python3',
])

const SAFE_UNQUOTED_PATH_RE = /^\/[A-Za-z0-9._/@:+-]+$/
const verifiedPythonCache = new Set<string>()

let testPythonCandidatesOverride: readonly string[] | null = null

export interface AntigravityReadOnlyGuardArtifacts {
  readonly pythonBin: string
  readonly guardScriptPath: string
  readonly guardScriptSha256: string
  readonly hooksConfigPath: string
  readonly hooksConfigSha256: string
}

export interface AntigravityReadOnlyHooksConfig {
  readonly [ANTIGRAVITY_READ_ONLY_HOOK_GROUP]: {
    readonly PreToolUse: ReadonlyArray<{
      readonly matcher: string
      readonly hooks: ReadonlyArray<{
        readonly type: 'command'
        readonly command: string
        readonly timeout: number
      }>
    }>
  }
}

export const ANTIGRAVITY_READ_ONLY_PRETOOL_HOOK_PY = `#!/usr/bin/env python3
import json
import sys

ALLOWED_NATIVE_TOOLS = frozenset({
    "read_file",
    "search_web",
    "list_resources",
    "read_resource",
    "exit_plan_mode",
})

ALLOWED_DIRECT_MCP_TOOLS = frozenset({
    "mcp_openclaude-memory_oc_grep",
    "mcp_openclaude-memory_oc_glob",
    "mcp_openclaude-memory_skill_search",
    "mcp_openclaude-memory_skill_view",
})

ALLOWED_CALL_MCP_TOOLS = frozenset({
    "oc_grep",
    "oc_glob",
    "skill_search",
    "skill_view",
    "skill_list",
    "list_reminders",
    "task_list",
    "task_get",
    "project_search",
})


def _emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\\n")
    sys.stdout.flush()


def _allow():
    _emit({"decision": "allow"})


def _deny(reason):
    _emit({"decision": "deny", "reason": reason})


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
        return None
    first = found[0]
    if any(item != first for item in found[1:]):
        return None
    return first


def main():
    try:
        raw = sys.stdin.read()
        if not raw or not raw.strip():
            _deny("readonly_hook_invalid_payload")
            return
        payload = json.loads(raw)
    except Exception:
        _deny("readonly_hook_invalid_payload")
        return

    if not isinstance(payload, dict):
        _deny("readonly_hook_invalid_payload")
        return

    calls = _extract_tool_calls(payload)
    if calls is None:
        _deny("readonly_hook_invalid_payload")
        return

    name = _extract_tool_name(payload, calls)
    if name is None:
        _deny("readonly_hook_invalid_payload")
        return

    if name in ALLOWED_NATIVE_TOOLS:
        _allow()
        return

    if name in ALLOWED_DIRECT_MCP_TOOLS:
        _allow()
        return

    if name == "call_mcp_tool":
        args = _extract_args(payload, calls)
        if not isinstance(args, dict):
            _deny("readonly_turn_forbidden:call_mcp_tool")
            return
        server_keys = [k for k in ("ServerName", "server_name", "serverName") if k in args]
        tool_keys = [k for k in ("ToolName", "tool_name", "toolName") if k in args]
        if len(server_keys) != 1 or len(tool_keys) != 1:
            _deny("readonly_turn_forbidden:call_mcp_tool")
            return
        server_name = args[server_keys[0]]
        tool_name = args[tool_keys[0]]
        if (
            isinstance(server_name, str)
            and server_name == "openclaude-memory"
            and isinstance(tool_name, str)
            and tool_name in ALLOWED_CALL_MCP_TOOLS
        ):
            _allow()
            return
        if isinstance(tool_name, str) and tool_name.strip():
            _deny("readonly_turn_forbidden:call_mcp_tool:" + tool_name.strip())
        else:
            _deny("readonly_turn_forbidden:call_mcp_tool")
        return

    _deny("readonly_turn_forbidden:" + name)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        _deny("readonly_hook_invalid_payload")
`

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function formatShellPath(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE}: unsafe path for hook command`)
  }
  if (SAFE_UNQUOTED_PATH_RE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function resolveAntigravityReadOnlyPythonBin(
  candidates?: readonly string[],
): string {
  const list = candidates ?? testPythonCandidatesOverride ?? DEFAULT_PYTHON3_CANDIDATES
  for (const candidate of list) {
    if (!candidate || !isAbsolute(candidate)) continue
    try {
      accessSync(candidate, fsConstants.X_OK)
      const st = statSync(candidate)
      if (!st.isFile()) continue
      const cacheKey = `${candidate}:${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`
      if (verifiedPythonCache.has(cacheKey)) return candidate
      execFileSync(
        candidate,
        ['-I', '-B', '-c', 'import json, sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)'],
        { timeout: 3_000, stdio: 'ignore' },
      )
      verifiedPythonCache.add(cacheKey)
      return candidate
    } catch {
      // Try next candidate; fail closed below if none work.
    }
  }
  throw new Error(
    `${ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE}: usable python3 binary not found for local Antigravity read-only PreToolUse hook`,
  )
}

export function buildAntigravityReadOnlyHooksConfig(
  pythonBin: string,
  scriptPath: string,
): AntigravityReadOnlyHooksConfig {
  const command = `${formatShellPath(pythonBin)} -I -B ${formatShellPath(scriptPath)}`
  return {
    [ANTIGRAVITY_READ_ONLY_HOOK_GROUP]: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command,
              timeout: 5,
            },
          ],
        },
      ],
    },
  }
}

export function atomicWriteVerifiedMode400(dstPath: string, content: string): string {
  const expectedBytes = Buffer.from(content, 'utf8')
  const expectedSha256 = sha256Hex(expectedBytes)
  const tmpPath = `${dstPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    const flags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fd = openSync(tmpPath, flags, 0o400)
    let offset = 0
    while (offset < expectedBytes.length) {
      const written = writeSync(fd, expectedBytes, offset, expectedBytes.length - offset)
      if (written <= 0) throw new Error('short write')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    chmodSync(tmpPath, 0o400)
    renameSync(tmpPath, dstPath)
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
    try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
    throw new Error(
      `${ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE}: failed writing ${dstPath}: ${String((err as Error)?.message ?? err)}`,
    )
  }

  try {
    const st = lstatSync(dstPath)
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new Error('target is not a regular file')
    }
    if ((st.mode & 0o777) !== 0o400) {
      throw new Error(`unexpected mode 0o${(st.mode & 0o777).toString(8)}`)
    }
    const actualSha256 = sha256Hex(readFileSync(dstPath))
    if (actualSha256 !== expectedSha256) {
      throw new Error('sha256 mismatch after atomic write')
    }
    return actualSha256
  } catch (err) {
    throw new Error(
      `${ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE}: verification failed for ${dstPath}: ${String((err as Error)?.message ?? err)}`,
    )
  }
}

/**
 * Atomically install `readonly_guard.py` (0400) and `hooks.json` (0400) into an
 * isolated read-only launch HOME, verifying SHA-256 on both files. Fails closed
 * with `ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE` if python3 or disk writes fail.
 */
export function installAntigravityReadOnlyGuard(opts: {
  launchHome: string
  configDir: string
  pythonBinCandidates?: readonly string[]
}): AntigravityReadOnlyGuardArtifacts {
  const pythonBin = resolveAntigravityReadOnlyPythonBin(opts.pythonBinCandidates)
  const guardScriptPath = join(opts.launchHome, ANTIGRAVITY_READ_ONLY_GUARD_SCRIPT_NAME)
  const guardScriptSha256 = atomicWriteVerifiedMode400(
    guardScriptPath,
    ANTIGRAVITY_READ_ONLY_PRETOOL_HOOK_PY,
  )
  const hooksConfig = buildAntigravityReadOnlyHooksConfig(pythonBin, guardScriptPath)
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

/** Remove a named hook group from `hooks.json` if present, deleting empty files. */
export function clearAntigravityHookGroupIfPresent(configDir: string, groupName: string): void {
  const hooksPath = join(configDir, 'hooks.json')
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(hooksPath)
  } catch {
    return
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    try { rmSync(hooksPath, { force: true }) } catch { /* ignore */ }
    return
  }
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rmSync(hooksPath, { force: true })
      return
    }
    const obj = parsed as Record<string, unknown>
    if (!(groupName in obj)) return
    delete obj[groupName]
    const remainingKeys = Object.keys(obj)
    if (remainingKeys.length === 0) {
      rmSync(hooksPath, { force: true })
      return
    }
    const tmpPath = `${hooksPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const bytes = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')
    const fd = openSync(
      tmpPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0),
      0o600,
    )
    try {
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error('short write')
        offset += written
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, hooksPath)
  } catch {
    try { rmSync(hooksPath, { force: true }) } catch { /* ignore */ }
  }
}

/**
 * Ensure a non-read-only launch config directory contains no stale local
 * read-only PreToolUse hook entry.
 */
export function clearAntigravityReadOnlyHookIfPresent(configDir: string): void {
  clearAntigravityHookGroupIfPresent(configDir, ANTIGRAVITY_READ_ONLY_HOOK_GROUP)
}

export const _readOnlyGuardInternals = {
  setPythonCandidatesOverride(candidates: readonly string[] | null): void {
    testPythonCandidatesOverride = candidates
    verifiedPythonCache.clear()
  },
  clearVerifiedPythonCache(): void {
    verifiedPythonCache.clear()
  },
}
