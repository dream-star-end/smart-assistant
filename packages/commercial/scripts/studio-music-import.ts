#!/usr/bin/env tsx
/**
 * OCV5-591 M1 — load hand-verified tracks into the media studio music catalog.
 *
 *   npx tsx packages/commercial/scripts/studio-music-import.ts --manifest <import.json> [--dry-run]
 *
 * Paths in the manifest are relative to its directory. Blobs go under OC_STUDIO_ROOT (default
 * /var/lib/openclaude-v5/studio). Production runs only as a manual migration step after a release
 * that carries 0325 (commercial release needs the user's approval).
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { closePool, getPool } from '../src/db/index.js'
import { STUDIO_DEFAULT_ROOT } from '../src/media-studio/assemble.js'
import { StudioBlobStore } from '../src/media-studio/blobs.js'
import {
  importCatalogEntries,
  parseCatalogManifest,
} from '../src/media-studio/music/catalogImport.js'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const at = args.indexOf('--manifest')
  const manifest = at >= 0 ? args[at + 1] : undefined
  if (!manifest) {
    process.stderr.write('usage: studio-music-import.ts --manifest <import.json> [--dry-run]\n')
    return 2
  }
  const dryRun = args.includes('--dry-run')
  const path = resolve(manifest)
  const entries = parseCatalogManifest(JSON.parse(await readFile(path, 'utf8')))
  const pool = getPool()
  try {
    const root = process.env.OC_STUDIO_ROOT?.trim() || STUDIO_DEFAULT_ROOT
    const out = await importCatalogEntries({
      pool,
      blobs: new StudioBlobStore({ pool, root }),
      dir: dirname(path),
      entries,
      dryRun,
    })
    process.stdout.write(
      `${dryRun ? '[dry run] ' : ''}inserted ${out.inserted.length}, already there ${out.skipped.length}, failed ${out.failed.length}\n`,
    )
    for (const f of out.failed) process.stdout.write(`FAIL ${f.sourceTrackId}: ${f.reason}\n`)
    return out.failed.length ? 1 : 0
  } finally {
    await closePool()
  }
}

process.exitCode = await main()
