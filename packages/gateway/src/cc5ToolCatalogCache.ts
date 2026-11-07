/** Verified cache of the compiled container tool catalog (OCV5-746).
 *
 * The host that produces the catalog takes ~10 s to boot and the remote CLI is launched with the
 * catalog, so registration used to serialize both halves of the first turn. A cache entry lets the
 * bridge register immediately and boot the host alongside the remote chain.
 *
 * An entry is never trusted by itself: cc5StdioBridge compares the live catalog with the entry
 * before the first tool roundtrip and the relay replaces the remote when it disagrees. The key
 * therefore has to cover everything a *correct* entry depends on, and stay stable across starts.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cc5HostProfile, Cc5ToolCatalog } from './cc5ToolCatalog.js'

/** Bumped when the cache layout, the key inputs or catalog compilation change meaning. */
export const CC5_TOOL_CATALOG_CACHE_VERSION = 1
const CACHE_DIR = 'catalog-cache'
const CATALOG_MAX_BYTES = 1048576
const ENTRY_MAX_BYTES = CATALOG_MAX_BYTES + 262144
const CONFIG_MAX_BYTES = 1048576
const MAX_ENTRIES = 8
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const REMOTE_PREFIX = 'mcp__ocbridge__'
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
/** Environment a start can read that selects which plugin/hook/tool sources the host loads. */
const ENV_KEY = ['HOME', 'CLAUDE_CONFIG_DIR'] as const

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function readBounded(path: string, maxBytes = CONFIG_MAX_BYTES): Buffer | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.size > maxBytes) return undefined
      return readFileSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}
/** MCP server definitions decide which tools exist; their per-session secret values do not. */
function mcpShape(bytes: Buffer): string | undefined {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    const servers = value?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined
    const shape: unknown[] = []
    for (const name of Object.keys(servers as Record<string, unknown>).sort()) {
      const server = (servers as Record<string, unknown>)[name]
      if (!server || typeof server !== 'object' || Array.isArray(server)) return undefined
      const fields = Object.keys(server as Record<string, unknown>).sort().map((field) => {
        const value = (server as Record<string, unknown>)[field]
        if (field === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
          // Every start writes fresh values (session key, delegate file, gateway token) here.
          return ['env', Object.keys(value as Record<string, unknown>).sort()]
        }
        return [field, value]
      })
      shape.push([name, fields])
    }
    const { mcpServers: _servers, ...rest } = value
    return JSON.stringify({ rest, shape })
  } catch {
    return undefined
  }
}
/** The CCB build the host runs: the entry chunk names every content-hashed chunk it can reach. */
function ccbIdentity(): string | undefined {
  const entry = readBounded(join(repoRoot, 'claude-code-best/dist/cli.js'), CONFIG_MAX_BYTES)
  if (!entry) return undefined
  const meta = readBounded(join(repoRoot, 'claude-code-best/package.json'), CONFIG_MAX_BYTES)
  let version = null
  try {
    version = meta ? (JSON.parse(meta.toString('utf8')) as { version?: unknown }).version ?? null : null
  } catch {
    version = null
  }
  return sha256(Buffer.concat([entry, Buffer.from(`\0${String(version)}`)]))
}

/** `undefined` means "cannot key this start"; the caller then behaves exactly as before. */
export function cc5ToolCatalogCacheKey(profile: Cc5HostProfile): string | undefined {
  const ccb = ccbIdentity()
  if (!ccb) return undefined
  const settings = profile.settingsPath ? readBounded(profile.settingsPath) : undefined
  if (profile.settingsPath && !settings) return undefined
  const mcp = profile.mcpConfigPath ? readBounded(profile.mcpConfigPath) : undefined
  const mcpDigest = profile.mcpConfigPath ? (mcp && mcpShape(mcp)) : 'none'
  if (!mcpDigest) return undefined
  return sha256(JSON.stringify({
    version: CC5_TOOL_CATALOG_CACHE_VERSION,
    ccb,
    cwd: profile.cwd,
    disallowedTools: [...profile.disallowedTools].sort(),
    settings: settings ? sha256(settings) : 'none',
    mcp: sha256(mcpDigest),
    env: ENV_KEY.map((key) => [key, process.env[key] ?? null]),
  }))
}

function cacheDir(executionRoot: string): string {
  return join(executionRoot, CACHE_DIR)
}
function ensureCacheDir(dir: string): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch {}
  const st = lstatSync(dir, { throwIfNoEntry: false })
  return Boolean(st && st.isDirectory() && !st.isSymbolicLink() &&
    st.uid === process.getuid?.() && (st.mode & 0o077) === 0)
}
function validEntry(value: unknown, key: string): Cc5ToolCatalog | undefined {
  const entry = value as { version?: unknown; key?: unknown; catalog?: unknown; sha256?: unknown;
    toolNames?: unknown }
  if (!entry || typeof entry !== 'object' || entry.version !== CC5_TOOL_CATALOG_CACHE_VERSION ||
    entry.key !== key || typeof entry.catalog !== 'string' ||
    Buffer.byteLength(entry.catalog) > CATALOG_MAX_BYTES || entry.sha256 !== sha256(entry.catalog) ||
    !entry.toolNames || typeof entry.toolNames !== 'object' || Array.isArray(entry.toolNames)) return undefined
  let tools: unknown
  try {
    tools = (JSON.parse(entry.catalog) as { tools?: unknown }).tools
  } catch {
    return undefined
  }
  const toolNames = entry.toolNames as Record<string, unknown>
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 128 ||
    Object.keys(toolNames).length !== tools.length) return undefined
  for (const tool of tools) {
    const name = (tool as { name?: unknown })?.name
    const remote = typeof name === 'string' ? `${REMOTE_PREFIX}${name}` : ''
    const local = Object.hasOwn(toolNames, remote) ? toolNames[remote] : undefined
    if (!TOOL_NAME.test(remote) || typeof local !== 'string' || !TOOL_NAME.test(local)) return undefined
  }
  return { json: entry.catalog, sha256: entry.sha256 as string,
    clientNameByRemoteName: Object.freeze({ ...toolNames }) as Record<string, string> }
}

/** Never throws: an unreadable or foreign entry is just a miss. */
export function readCc5ToolCatalogCache(executionRoot: string, key: string | undefined): Cc5ToolCatalog | undefined {
  if (!key) return undefined
  try {
    const path = join(cacheDir(executionRoot), `${key}.json`)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 ||
        st.size > ENTRY_MAX_BYTES || st.size < 2) return undefined
      return validEntry(JSON.parse(readFileSync(fd, 'utf8')), key)
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

export function removeCc5ToolCatalogCache(executionRoot: string, key: string | undefined): void {
  if (!key) return
  try {
    unlinkSync(join(cacheDir(executionRoot), `${key}.json`))
  } catch {}
}

/** Atomic and best effort: a failed write only means the next start boots the host again. */
export function writeCc5ToolCatalogCache(executionRoot: string, key: string | undefined,
  catalog: Cc5ToolCatalog): void {
  if (!key) return
  const dir = cacheDir(executionRoot)
  const staging = join(dir, `.${key}.${process.pid}.tmp`)
  try {
    if (!ensureCacheDir(dir)) return
    const body = JSON.stringify({ version: CC5_TOOL_CATALOG_CACHE_VERSION, key,
      catalog: catalog.json, sha256: catalog.sha256, toolNames: catalog.clientNameByRemoteName })
    if (Buffer.byteLength(body) > ENTRY_MAX_BYTES) return
    const fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(staging, join(dir, `${key}.json`))
    const handle = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    try {
      unlinkSync(staging)
    } catch {}
  }
  prune(dir)
}

function prune(dir: string): void {
  try {
    const now = Date.now()
    const entries: Array<{ path: string; mtime: number }> = []
    for (const name of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const path = join(dir, name)
      const st = lstatSync(path, { throwIfNoEntry: false })
      if (!st || !st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.()) continue
      if (now - st.mtimeMs > MAX_AGE_MS) {
        unlinkSync(path)
        continue
      }
      entries.push({ path, mtime: st.mtimeMs })
    }
    entries.sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(MAX_ENTRIES)) unlinkSync(entry.path)
  } catch {}
}
