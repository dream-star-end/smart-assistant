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
]

export function readGatewaySource(): string {
  return GATEWAY_SOURCE_FILES.map((f) => readFileSync(join(gatewaySrc, f), 'utf8')).join('\n')
}
