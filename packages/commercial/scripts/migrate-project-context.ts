#!/usr/bin/env tsx
/**
 * Dry-run by default. Does not deploy. Does not bind chat sessions.
 *
 *   OPENCLAUDE_HOME=/path tsx packages/commercial/scripts/migrate-project-context.ts
 *   OPENCLAUDE_HOME=/path tsx ... --apply
 *   OPENCLAUDE_HOME=/path tsx ... --down --manifest /path/to/<ts>.json
 */
import { join } from 'node:path'
import { migrateProjectContext, defaultManifestPath } from '@openclaude/storage'

function parseArgs(argv: string[]): {
  mode: 'dry-run' | 'apply' | 'down'
  home: string
  dbPath?: string
  manifest?: string
} {
  let mode: 'dry-run' | 'apply' | 'down' = 'dry-run'
  let home = process.env.OPENCLAUDE_HOME || ''
  let dbPath: string | undefined
  let manifest: string | undefined
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') mode = 'apply'
    else if (a === '--down') mode = 'down'
    else if (a === '--home') home = argv[++i]
    else if (a.startsWith('--home=')) home = a.slice('--home='.length)
    else if (a === '--db') dbPath = argv[++i]
    else if (a === '--manifest') manifest = argv[++i]
    else if (a.startsWith('--manifest=')) manifest = a.slice('--manifest='.length)
    else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!home) {
    console.error('OPENCLAUDE_HOME or --home is required')
    process.exit(2)
  }
  return { mode, home, dbPath, manifest }
}

const args = parseArgs(process.argv)
const dbPath = args.dbPath || join(args.home, 'taskboard.db')
const result = await migrateProjectContext({
  home: args.home,
  dbPath,
  mode: args.mode,
  downManifestPath: args.manifest,
})
console.log(JSON.stringify(result, null, 2))
if (args.mode === 'apply') {
  console.error(`manifest: ${defaultManifestPath(args.home, result.createdAt)}`)
}
