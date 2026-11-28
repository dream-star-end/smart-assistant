import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAggregatedSource } from './sourceAggregate.js'

const storageSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'storage',
  'src',
)

/**
 * Aggregates `storage/src/sessionsDb*.ts` plus any submodules split into `storage/src/sessions/**\/*.ts`
 * (safely ignoring `sessions` when the directory does not exist yet).
 */
export function readSqliteSessionsSource(): string {
  return readAggregatedSource({
    baseDir: storageSrc,
    requiredEntryFiles: ['sessionsDb.ts'],
    optionalEntryFiles: ['sessionsDbProjects.ts', 'sessionsDbSidebar.ts'],
    scanDirs: ['sessions'],
  })
}
