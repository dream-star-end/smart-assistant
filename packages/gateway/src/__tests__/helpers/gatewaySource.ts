/**
 * server.ts plus the modules split out of it (FINDINGS §7). Source-reading guard tests that assert
 * "the Gateway does X" read this instead of server.ts alone, so moving code between these files
 * keeps the guard meaningful. Automatically scans `inbound/`, `session/`, `delegate/`,
 * `remoteSwarm/`, and `routes/` subdirectories recursively (ignoring absent directories).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gatewaySrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const BASE_GATEWAY_SOURCE_FILES: readonly string[] = [
  'server.ts',
  'routes/preAuth.ts',
  'routes/platform.ts',
  'routes/system.ts',
  'routes/appConfig.ts',
  'routes/agents.ts',
  'routes/workspaceApi.ts',
  'agentHandlers.ts',
  'skillHandlers.ts',
  'delegateRuntime.ts',
  'delegateCallbacks.ts',
  'delegateSupervision.ts',
  'advisorHandlers.ts',
  'askUserPermissions.ts',
  'cronTaskWebhook.ts',
  'httpMiscHandlers.ts',
  'channelHandlers.ts',
  'inboundDispatch.ts',
  'wsConnection.ts',
  'gatewayFilePolicy.ts',
  'localExecution.ts',
  'routeOverrides.ts',
  'turnFrames.ts',
  'askUserSanitize.ts',
  'gatewayTypes.ts',
  'gatewayLifecycle.ts',
  'gatewayHttp.ts',
  'sessionRepoBinding.ts',
  'turnDispatch.ts',
  'promptQueueDispatch.ts',
  'delegateGuard.ts',
  'skillTrainRuns.ts',
  'agentMessage.ts',
  'delegatePolicy.ts',
  'wechatInboundCompensate.ts',
  'autoDreamSchedule.ts',
  'httpUploadStatic.ts',
]

const GATEWAY_SCAN_DIRS = ['inbound', 'session', 'delegate', 'remoteSwarm', 'routes'] as const
const SKIP_DIRS = new Set(['__tests__', 'fixtures', '__fixtures__', 'node_modules', 'dist'])
const EXCLUDE_FILE_RE = /\.(?:test|spec|integ\.test|node-test)\.ts$|\.d\.ts$/

function scanGatewaySubdir(relDir: string): string[] {
  const absDir = join(gatewaySrc, relDir)
  if (!existsSync(absDir)) return []
  const out: string[] = []
  const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    const childRel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        out.push(...scanGatewaySubdir(childRel))
      }
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !EXCLUDE_FILE_RE.test(entry.name)) {
      out.push(childRel)
    }
  }
  return out
}

function resolveGatewaySourceFiles(): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  const add = (rel: string) => {
    if (seen.has(rel)) return
    seen.add(rel)
    ordered.push(rel)
  }
  for (const f of BASE_GATEWAY_SOURCE_FILES) add(f)
  for (const dir of GATEWAY_SCAN_DIRS) {
    for (const f of scanGatewaySubdir(dir)) add(f)
  }
  return ordered
}

export const GATEWAY_SOURCE_FILES: readonly string[] = resolveGatewaySourceFiles()

export function readGatewaySource(): string {
  return resolveGatewaySourceFiles()
    .map((f) => readFileSync(join(gatewaySrc, f), 'utf8'))
    .join('\n')
}

function findExportedFunctionBody(files: readonly string[], fnName: string): string | null {
  const re = new RegExp(`^export (?:async )?function ${fnName}\\(`, 'm')
  for (const f of files) {
    const src = readFileSync(join(gatewaySrc, f), 'utf8')
    const m = re.exec(src)
    if (!m) continue
    const rest = src.slice(m.index + m[0].length)
    const next = /^(?:export |function |async function |const |let |class |interface |type |\/\*\*)/m.exec(
      rest,
    )
    return src.slice(m.index, next ? m.index + m[0].length + next.index : src.length)
  }
  return null
}

/**
 * The implementation of a Gateway method: the `export [async] function name(` (or `nameImpl(`) a
 * split-out module holds (the class keeps a one-line forwarder), else the class method in server.ts.
 * Ends at the next top-level declaration / class member, like the per-test extractors this replaces.
 */
export function gatewayMethodBody(name: string): string {
  const splitFiles = resolveGatewaySourceFiles().filter((x) => x !== 'server.ts')
  const exact = findExportedFunctionBody(splitFiles, name)
  if (exact !== null) return exact
  const impl = findExportedFunctionBody(splitFiles, `${name}Impl`)
  if (impl !== null) return impl

  const src = readFileSync(join(gatewaySrc, 'server.ts'), 'utf8')
  const m = new RegExp(`^ {2}(?:private |public |protected )?(?:async )?${name}\\(`, 'm').exec(src)
  if (!m) throw new Error(`method ${name} not found in the Gateway source set`)
  const rest = src.slice(m.index + m[0].length)
  const next = /^ {2}(?:private|public|protected|async|static)\b/m.exec(rest)
  return src.slice(m.index, next ? m.index + m[0].length + next.index : src.length)
}
