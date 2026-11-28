import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAggregatedSource } from './sourceAggregate.js'

const commercialSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Aggregates `ws/userChatBridge.ts` plus any submodules split into `ws/bridge/**\/*.ts`
 * (safely ignoring `ws/bridge` when the directory does not exist yet).
 */
export function readUserChatBridgeSource(): string {
  return readAggregatedSource({
    baseDir: commercialSrc,
    requiredEntryFiles: ['ws/userChatBridge.ts'],
    scanDirs: ['ws/bridge'],
  })
}
