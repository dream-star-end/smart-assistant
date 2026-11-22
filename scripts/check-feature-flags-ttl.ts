/**
 * Feature Flag TTL & Registry Hygiene Gate (Governance Blueprint §4.2 ③).
 *
 * Validates `deploy/v5/feature-flags-registry.json`:
 *   1. Schema & field integrity (`schema: 1`, unique `UPPER_SNAKE_CASE` names, `owner`,
 *      valid ISO `createdAt`, `permanent` boolean, required `expireAt >= createdAt` when
 *      `permanent === false`, non-empty `description` justification).
 *   2. Unregistered `OC_FLAG_*` scan across `packages/<pkg>/src/**` production TS/TSX files
 *      (any new `OC_FLAG_*` constant in production code must be registered).
 *   3. Expired flag detection (`permanent === false && expireAt < today`):
 *      - Prints a structured cleanup debt checklist (`WARNING` by default, rc=0 so weekly GC can clean).
 *      - With `--fail-on-expired`, emits `[GATE-ERROR] FEATURE-FLAG-EXPIRED` and exits 1.
 *
 * Usage:
 *   npx tsx scripts/check-feature-flags-ttl.ts [--root <repo>] [--registry <rel>]
 *                                              [--today YYYY-MM-DD] [--fail-on-expired]
 *
 * Exit: 0 ok (or warnings only), 1 schema/unregistered/expired(strict) error, 2 usage/IO error.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEFAULT_REGISTRY_PATH = 'deploy/v5/feature-flags-registry.json'

export interface FeatureFlagEntry {
  name: string
  owner: string
  createdAt: string
  expireAt: string | null
  permanent: boolean
  ticket?: string
  scope?: string
  description: string
}

export interface FeatureFlagsRegistry {
  schema: number
  note?: string
  flags: FeatureFlagEntry[]
}

export interface FlagSchemaProblem {
  flag: string
  message: string
}

export interface ExpiredFlag {
  name: string
  owner: string
  expireAt: string
  overdueDays: number
  scope?: string
  ticket?: string
}

export interface UnregisteredFlag {
  name: string
  file: string
  line: number
}

const FLAG_NAME_RE = /^[A-Z][A-Z0-9_]{2,80}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const OC_FLAG_SCAN_RE = /\b(OC_FLAG_[A-Z0-9_]+)\b/g
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-types', 'build', '__tests__', '__smoke__', 'generated'])

function parseIsoDateMs(dateStr: string): number {
  if (!ISO_DATE_RE.test(dateStr)) return Number.NaN
  const ms = Date.parse(`${dateStr}T00:00:00Z`)
  if (!Number.isFinite(ms)) return Number.NaN
  // Reject calendar rollovers like 2026-02-31
  const normalized = new Date(ms).toISOString().slice(0, 10)
  return normalized === dateStr ? ms : Number.NaN
}

export function validateRegistry(
  raw: unknown,
  today: string,
): {
  entries: FeatureFlagEntry[]
  schemaProblems: FlagSchemaProblem[]
  expired: ExpiredFlag[]
} {
  const schemaProblems: FlagSchemaProblem[] = []
  const expired: ExpiredFlag[] = []
  const entries: FeatureFlagEntry[] = []

  const todayMs = parseIsoDateMs(today)
  if (!Number.isFinite(todayMs)) {
    schemaProblems.push({ flag: '<cli>', message: `invalid --today date ${JSON.stringify(today)} (expected YYYY-MM-DD)` })
    return { entries, schemaProblems, expired }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    schemaProblems.push({ flag: '<root>', message: 'registry must be a JSON object' })
    return { entries, schemaProblems, expired }
  }
  const obj = raw as Record<string, unknown>
  if (obj.schema !== 1) {
    schemaProblems.push({ flag: '<root>', message: `schema must be 1 (got ${JSON.stringify(obj.schema)})` })
  }
  if (!Array.isArray(obj.flags)) {
    schemaProblems.push({ flag: '<root>', message: 'flags must be an array' })
    return { entries, schemaProblems, expired }
  }

  const seen = new Set<string>()
  for (const [idx, item] of obj.flags.entries()) {
    const label =
      item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
        ? String((item as Record<string, unknown>).name)
        : `flags[${idx}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      schemaProblems.push({ flag: label, message: 'entry must be an object' })
      continue
    }
    const f = item as Record<string, unknown>
    let ok = true
    const bad = (msg: string) => {
      ok = false
      schemaProblems.push({ flag: label, message: msg })
    }

    if (typeof f.name !== 'string' || !FLAG_NAME_RE.test(f.name)) {
      bad('name must be UPPER_SNAKE_CASE (3-81 chars)')
    } else if (seen.has(f.name)) {
      bad(`duplicate flag name ${f.name}`)
    } else {
      seen.add(f.name)
    }

    if (typeof f.owner !== 'string' || f.owner.trim().length < 2) {
      bad('owner must be a non-empty handle (e.g. @dream-star-end)')
    }
    const createdMs = typeof f.createdAt === 'string' ? parseIsoDateMs(f.createdAt) : Number.NaN
    if (!Number.isFinite(createdMs)) {
      bad('createdAt must be a valid YYYY-MM-DD date')
    }
    if (typeof f.permanent !== 'boolean') {
      bad('permanent must be a boolean')
    }
    if (typeof f.description !== 'string' || f.description.trim().length < 8) {
      bad('description must be a meaningful string (>= 8 chars)')
    }

    if (f.permanent === false) {
      const expireMs = typeof f.expireAt === 'string' ? parseIsoDateMs(f.expireAt) : Number.NaN
      if (!Number.isFinite(expireMs)) {
        bad('temporary flag (permanent=false) must specify valid YYYY-MM-DD expireAt')
      } else {
        if (Number.isFinite(createdMs) && expireMs < createdMs) {
          bad(`expireAt (${f.expireAt}) must not be earlier than createdAt (${f.createdAt})`)
        }
        if (expireMs < todayMs && typeof f.name === 'string' && typeof f.owner === 'string') {
          const overdueDays = Math.floor((todayMs - expireMs) / 86_400_000)
          expired.push({
            name: f.name,
            owner: f.owner,
            expireAt: f.expireAt as string,
            overdueDays,
            scope: typeof f.scope === 'string' ? f.scope : undefined,
            ticket: typeof f.ticket === 'string' ? f.ticket : undefined,
          })
        }
      }
    } else if (f.permanent === true) {
      if (f.expireAt !== null && f.expireAt !== undefined) {
        bad('permanent flag (permanent=true) must set expireAt to null (or omit it)')
      }
    }

    if (ok) {
      entries.push({
        name: f.name as string,
        owner: f.owner as string,
        createdAt: f.createdAt as string,
        expireAt: f.permanent ? null : (f.expireAt as string),
        permanent: f.permanent as boolean,
        ticket: typeof f.ticket === 'string' ? f.ticket : undefined,
        scope: typeof f.scope === 'string' ? f.scope : undefined,
        description: f.description as string,
      })
    }
  }

  return { entries, schemaProblems, expired }
}

export function scanUnregisteredOcFlags(
  root: string,
  registeredNames: ReadonlySet<string>,
): UnregisteredFlag[] {
  const pkgRoot = path.join(root, 'packages')
  if (!existsSync(pkgRoot)) return []
  const found: UnregisteredFlag[] = []
  const seen = new Set<string>()

  const walk = (rel: string) => {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) return
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue
      const next = `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(next)
      else if (
        ent.isFile() &&
        /\.(ts|tsx|mts)$/.test(ent.name) &&
        !/\.d\.ts$/.test(ent.name) &&
        !/\.(test|spec)\.(ts|tsx)$/.test(ent.name)
      ) {
        const lines = readFileSync(path.join(root, next), 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const m of lines[i]!.matchAll(OC_FLAG_SCAN_RE)) {
            const flag = m[1]!
            if (!registeredNames.has(flag) && !seen.has(flag)) {
              seen.add(flag)
              found.push({ name: flag, file: next, line: i + 1 })
            }
          }
        }
      }
    }
  }

  for (const pkg of readdirSync(pkgRoot)) {
    if (pkg === 'channels') {
      const chDir = path.join(pkgRoot, 'channels')
      for (const ch of readdirSync(chDir)) walk(`packages/channels/${ch}/src`)
    } else {
      walk(`packages/${pkg}/src`)
    }
  }
  return found
}

export function checkFeatureFlagsTtl(opts: {
  root: string
  registryRel?: string
  today?: string
}): {
  entries: FeatureFlagEntry[]
  schemaProblems: FlagSchemaProblem[]
  expired: ExpiredFlag[]
  unregistered: UnregisteredFlag[]
} {
  const registryRel = opts.registryRel ?? DEFAULT_REGISTRY_PATH
  const registryAbs = path.join(opts.root, registryRel)
  if (!existsSync(registryAbs)) {
    return {
      entries: [],
      schemaProblems: [{ flag: '<file>', message: `missing ${registryRel}` }],
      expired: [],
      unregistered: [],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(registryAbs, 'utf8'))
  } catch (err) {
    return {
      entries: [],
      schemaProblems: [{ flag: '<json>', message: `invalid JSON: ${(err as Error).message}` }],
      expired: [],
      unregistered: [],
    }
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  const { entries, schemaProblems, expired } = validateRegistry(raw, today)
  const registeredNames = new Set(entries.map((e) => e.name))
  const unregistered = scanUnregisteredOcFlags(opts.root, registeredNames)
  return { entries, schemaProblems, expired, unregistered }
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let registryRel = DEFAULT_REGISTRY_PATH
  let today: string | undefined
  let failOnExpired = false

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] ?? '')
    else if (argv[i] === '--registry') registryRel = argv[++i] ?? ''
    else if (argv[i] === '--today') today = argv[++i]
    else if (argv[i] === '--fail-on-expired') failOnExpired = true
    else {
      console.error(`[feature-flags-ttl] unknown arg: ${argv[i]}`)
      return 2
    }
  }

  const res = checkFeatureFlagsTtl({ root, registryRel, today })
  for (const p of res.schemaProblems) {
    console.error(
      [
        `[GATE-ERROR] FEATURE-FLAG-SCHEMA at ${registryRel}`,
        `  Violation : ${p.flag}: ${p.message}`,
        '  Why       : Feature flag registry must remain well-formed so TTL enforcement and monotonic checks stay reliable.',
        `  How to Fix: Fix the entry in ${registryRel} (required: name, owner, createdAt YYYY-MM-DD, permanent boolean, expireAt YYYY-MM-DD if temporary, description >= 8 chars).`,
        '  Re-verify : npx tsx scripts/check-feature-flags-ttl.ts',
      ].join('\n'),
    )
  }
  for (const u of res.unregistered) {
    console.error(
      [
        `[GATE-ERROR] FEATURE-FLAG-UNREGISTERED at ${u.file}:${u.line}`,
        `  Violation : Active flag ${u.name} is not registered in ${registryRel}.`,
        '  Why       : Unregistered rollout flags accumulate silently without TTL cleanup (OCV5-829).',
        `  How to Fix: Register ${u.name} in ${registryRel} with owner, createdAt, expireAt (<= 30 days for temporary flags), and description.`,
        '  Re-verify : npx tsx scripts/check-feature-flags-ttl.ts',
      ].join('\n'),
    )
  }
  if (res.expired.length > 0) {
    console.warn(`[feature-flags-ttl] EXPIRED FLAG CLEANUP LIST (${res.expired.length}):`)
    for (const e of res.expired) {
      const msg = `${e.name} expired on ${e.expireAt} (${e.overdueDays}d overdue, owner=${e.owner}${e.ticket ? `, ticket=${e.ticket}` : ''}${e.scope ? `, scope=${e.scope}` : ''})`
      if (failOnExpired) {
        console.error(
          [
            `[GATE-ERROR] FEATURE-FLAG-EXPIRED at ${registryRel}`,
            `  Violation : ${msg}`,
            '  Why       : Expired rollout flags must be removed once stabilized rather than left permanently in code (OCV5-829).',
            `  How to Fix: Delete the obsolete flag branch in code and remove ${e.name} from ${registryRel}.`,
            '  Re-verify : npx tsx scripts/check-feature-flags-ttl.ts --fail-on-expired',
          ].join('\n'),
        )
      } else {
        console.warn(`  - [WARN] ${msg}`)
      }
    }
  }

  const temporaryCount = res.entries.filter((e) => !e.permanent).length
  const permanentCount = res.entries.filter((e) => e.permanent).length
  console.log(
    `[feature-flags-ttl] total=${res.entries.length} (temporary=${temporaryCount}, permanent=${permanentCount}) schemaProblems=${res.schemaProblems.length} unregistered=${res.unregistered.length} expired=${res.expired.length}`,
  )

  if (res.schemaProblems.length > 0 || res.unregistered.length > 0) return 1
  if (failOnExpired && res.expired.length > 0) return 1
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
