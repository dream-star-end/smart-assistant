import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['__tests__', 'fixtures', '__fixtures__', 'node_modules', 'dist'])
const EXCLUDE_FILE_RE = /\.(?:test|spec|integ\.test|node-test)\.ts$|\.d\.ts$/

/**
 * Recursively collects production `.ts` file paths under `dir`, sorted deterministically.
 * Safely returns `[]` when `dir` does not exist yet.
 */
export function collectTsFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        out.push(...collectTsFilesRecursive(join(dir, entry.name)))
      }
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !EXCLUDE_FILE_RE.test(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

export interface AggregateSourceOptions {
  readonly baseDir: string
  readonly requiredEntryFiles: readonly string[]
  readonly optionalEntryFiles?: readonly string[]
  readonly scanDirs: readonly string[]
}

/**
 * Reads and joins entry files plus any `.ts` submodules discovered recursively under `scanDirs`.
 * Preserves deterministic order and deduplicates file paths.
 */
export function readAggregatedSource(options: AggregateSourceOptions): string {
  const ordered: string[] = []
  const seen = new Set<string>()
  const addFile = (absPath: string) => {
    if (seen.has(absPath)) return
    seen.add(absPath)
    ordered.push(absPath)
  }
  for (const rel of options.requiredEntryFiles) {
    addFile(join(options.baseDir, rel))
  }
  for (const rel of options.optionalEntryFiles ?? []) {
    const abs = join(options.baseDir, rel)
    if (existsSync(abs)) addFile(abs)
  }
  for (const relDir of options.scanDirs) {
    for (const abs of collectTsFilesRecursive(join(options.baseDir, relDir))) {
      addFile(abs)
    }
  }
  return ordered.map((file) => readFileSync(file, 'utf8')).join('\n')
}
