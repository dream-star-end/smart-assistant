/**
 * server.ts plus the modules split out of it (FINDINGS §7). Source-reading guard tests that assert
 * "the Gateway does X" read this instead of server.ts alone, so moving code between these files
 * keeps the guard meaningful. Add each new split-out module here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gatewaySrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const GATEWAY_SOURCE_FILES: readonly string[] = [
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
  'delegateCompletionSurface.ts',
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

export function readGatewaySource(): string {
  return GATEWAY_SOURCE_FILES.map((f) => readFileSync(join(gatewaySrc, f), 'utf8')).join('\n')
}

/**
 * The implementation of a Gateway method: the `export [async] function name(` a split-out module
 * holds (the class keeps a one-line forwarder), else the class method in server.ts. Ends at the next
 * top-level declaration / class member, like the per-test extractors this replaces.
 */
export function gatewayMethodBody(name: string): string {
  for (const f of GATEWAY_SOURCE_FILES.filter((x) => x !== 'server.ts')) {
    const src = readFileSync(join(gatewaySrc, f), 'utf8')
    const m = new RegExp(`^export (?:async )?function ${name}\\(`, 'm').exec(src)
    if (!m) continue
    const rest = src.slice(m.index + m[0].length)
    const next = /^(?:export |function |async function |const |let |class |interface |type |\/\*\*)/m.exec(rest)
    return src.slice(m.index, next ? m.index + m[0].length + next.index : src.length)
  }
  const src = readFileSync(join(gatewaySrc, 'server.ts'), 'utf8')
  const m = new RegExp(`^ {2}(?:private |public |protected )?(?:async )?${name}\\(`, 'm').exec(src)
  if (!m) throw new Error(`method ${name} not found in the Gateway source set`)
  const rest = src.slice(m.index + m[0].length)
  const next = /^ {2}(?:private|public|protected|async|static)\b/m.exec(rest)
  return src.slice(m.index, next ? m.index + m[0].length + next.index : src.length)
}
