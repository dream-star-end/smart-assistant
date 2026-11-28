import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAggregatedSource } from './sourceAggregate.js'

const commercialSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Aggregates `db/pgSessionsBackend.ts` plus any submodules split into `db/sessions/**\/*.ts`
 * (safely ignoring `db/sessions` when the directory does not exist yet).
 */
export function readPgSessionsBackendSource(): string {
  return readAggregatedSource({
    baseDir: commercialSrc,
    requiredEntryFiles: ['db/pgSessionsBackend.ts'],
    scanDirs: ['db/sessions'],
  })
}
