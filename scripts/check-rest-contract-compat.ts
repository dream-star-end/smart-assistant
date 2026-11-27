/**
 * Core 5-Domain REST API Contract Snapshot & Backward-Compatibility Gate.
 *
 * Performs two checks:
 *   1. Snapshot Sync: ensures `packages/protocol/rest-contract-snapshot.json` exactly
 *      matches the live TypeBox export `serializeRestContractSnapshot()` in
 *      `packages/protocol/src/httpContracts.ts` (prevents forgetting `--write-snapshot`).
 *   2. Recursive Backward-Compatibility Diff (when `--base <ref>` is provided and
 *      `<base>:packages/protocol/rest-contract-snapshot.json` exists):
 *      Mechanically blocks breaking wire changes:
 *        - Deleting an existing route contract or removing its request/query/params section
 *        - Deleting a response field (or downgrading a required response field to optional)
 *        - Changing or narrowing a response field type (or changing/narrowing a request field type)
 *        - Adding a required request/query/params field (or promoting an optional one to required)
 *        - Deleting an existing enum / literal-union value or union branch
 *        - Direction-sensitive constraint breakage: tightening request bounds or relaxing
 *          response bounds (`minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`,
 *          `minLength`, `maxLength`, `minItems`, `maxItems`)
 *      Permits additive backward-compatible changes:
 *        - Adding a new route
 *        - Adding a new optional response field
 *        - Adding a new optional request/query/params field
 *
 * Usage:
 *   npx tsx scripts/check-rest-contract-compat.ts --write-snapshot [--root <repo>]
 *   npx tsx scripts/check-rest-contract-compat.ts [--base <git-ref>] [--root <repo>] [--snapshot <rel>]
 *
 * Exit: 0 ok, 1 snapshot drift or breaking contract change, 2 usage/git/IO error (fail-closed).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEFAULT_CONTRACTS_SOURCE_PATH,
  type RestContractSnapshot,
  type SerializedRouteContract,
  loadLiveRestContractSnapshot,
} from './lib/restContractLoader.js'

export {
  DEFAULT_CONTRACTS_SOURCE_PATH,
  type RestContractSnapshot,
  type SerializedRouteContract,
  loadLiveRestContractSnapshot,
}

export const DEFAULT_SNAPSHOT_PATH = 'packages/protocol/rest-contract-snapshot.json'

export type RestContractBreakRule =
  | 'REST-CONTRACT-SNAPSHOT-DRIFT'
  | 'REST-CONTRACT-ROUTE-REMOVED'
  | 'REST-CONTRACT-ROUTE-CHANGED'
  | 'REST-CONTRACT-SECTION-REMOVED'
  | 'REST-CONTRACT-RESPONSE-FIELD-REMOVED'
  | 'REST-CONTRACT-RESPONSE-FIELD-MADE-OPTIONAL'
  | 'REST-CONTRACT-REQUIRED-REQUEST-FIELD-ADDED'
  | 'REST-CONTRACT-REQUEST-FIELD-MADE-REQUIRED'
  | 'REST-CONTRACT-REQUEST-FIELD-REMOVED'
  | 'REST-CONTRACT-ENUM-VALUE-REMOVED'
  | 'REST-CONTRACT-UNION-BRANCH-REMOVED'
  | 'REST-CONTRACT-TYPE-NARROWED'
  | 'REST-CONTRACT-TYPE-CHANGED'
  | 'REST-CONTRACT-CONSTRAINT-TIGHTENED'
  | 'REST-CONTRACT-CONSTRAINT-RELAXED'

export interface RestContractBreak {
  rule: RestContractBreakRule
  route: string
  path: string
  message: string
}

type JsonSchema = Record<string, unknown>

const LOWER_BOUND_KEYWORDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'] as const
const UPPER_BOUND_KEYWORDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Extract closed set of literal/enum values if the schema represents an enum or literal union. */
function extractEnumLiterals(schema: JsonSchema): string[] | null {
  if ('const' in schema) {
    return [JSON.stringify(schema.const)]
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v))
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const vals: string[] = []
    for (const branch of schema.anyOf) {
      if (!isRecord(branch)) return null
      const sub = extractEnumLiterals(branch)
      if (sub === null) return null
      vals.push(...sub)
    }
    return [...new Set(vals)].sort()
  }
  return null
}

/** Extract top-level JSON Schema primitive/structural type tags (handling `anyOf` unions). */
function extractTypeSet(schema: JsonSchema): Set<string> | null {
  // Empty schema `{}` represents Type.Unknown() / Type.Any()
  if (
    !('type' in schema) &&
    !('anyOf' in schema) &&
    !('const' in schema) &&
    !('enum' in schema)
  ) {
    return null
  }
  const out = new Set<string>()
  if (typeof schema.type === 'string') {
    out.add(schema.type)
  } else if (Array.isArray(schema.type)) {
    for (const t of schema.type) {
      if (typeof t === 'string') out.add(t)
    }
  }
  if ('const' in schema) {
    const v = schema.const
    if (v === null) out.add('null')
    else out.add(typeof v)
  }
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      if (!isRecord(branch)) continue
      const sub = extractTypeSet(branch)
      if (sub === null) return null
      for (const t of sub) out.add(t)
    }
  }
  return out.size > 0 ? out : null
}

/** Check if a schema is a `T | null` nullable union and return the non-null branch if unambiguous. */
function unwrapNullableBranch(schema: JsonSchema): JsonSchema | null {
  if (!Array.isArray(schema.anyOf)) return null
  const nonNull = schema.anyOf.filter(
    (b) => isRecord(b) && b.type !== 'null' && b.const !== null,
  ) as JsonSchema[]
  if (nonNull.length === 1 && nonNull.length < schema.anyOf.length) {
    return nonNull[0]!
  }
  return null
}

/**
 * Direction-sensitive numeric, length, and array-size constraint check:
 *   - Request/query/params (contravariant): tightening a bound breaks existing callers.
 *   - Response (covariant): relaxing a bound breaks existing consumers relying on the guarantee.
 */
function diffConstraintBounds(
  base: JsonSchema,
  curr: JsonSchema,
  role: 'response' | 'request',
  route: string,
  jsonPath: string,
  out: RestContractBreak[],
): void {
  for (const kw of LOWER_BOUND_KEYWORDS) {
    const bVal = typeof base[kw] === 'number' ? (base[kw] as number) : undefined
    const cVal = typeof curr[kw] === 'number' ? (curr[kw] as number) : undefined
    if (bVal === cVal) continue
    if (role === 'request') {
      if ((bVal === undefined && cVal !== undefined) || (bVal !== undefined && cVal !== undefined && cVal > bVal)) {
        out.push({
          rule: 'REST-CONTRACT-CONSTRAINT-TIGHTENED',
          route,
          path: jsonPath,
          message: `request constraint "${kw}" tightened (${bVal ?? 'unbounded'} -> ${cVal})`,
        })
      }
    } else {
      if ((bVal !== undefined && cVal === undefined) || (bVal !== undefined && cVal !== undefined && cVal < bVal)) {
        out.push({
          rule: 'REST-CONTRACT-CONSTRAINT-RELAXED',
          route,
          path: jsonPath,
          message: `response constraint "${kw}" relaxed (${bVal} -> ${cVal ?? 'unbounded'})`,
        })
      }
    }
  }

  for (const kw of UPPER_BOUND_KEYWORDS) {
    const bVal = typeof base[kw] === 'number' ? (base[kw] as number) : undefined
    const cVal = typeof curr[kw] === 'number' ? (curr[kw] as number) : undefined
    if (bVal === cVal) continue
    if (role === 'request') {
      if ((bVal === undefined && cVal !== undefined) || (bVal !== undefined && cVal !== undefined && cVal < bVal)) {
        out.push({
          rule: 'REST-CONTRACT-CONSTRAINT-TIGHTENED',
          route,
          path: jsonPath,
          message: `request constraint "${kw}" tightened (${bVal ?? 'unbounded'} -> ${cVal})`,
        })
      }
    } else {
      if ((bVal !== undefined && cVal === undefined) || (bVal !== undefined && cVal !== undefined && cVal > bVal)) {
        out.push({
          rule: 'REST-CONTRACT-CONSTRAINT-RELAXED',
          route,
          path: jsonPath,
          message: `response constraint "${kw}" relaxed (${bVal} -> ${cVal ?? 'unbounded'})`,
        })
      }
    }
  }
}

/**
 * Recursively diff two JSON Schemas for backward compatibility.
 *   - `role === 'response'`: server output — must not remove fields, make required fields optional,
 *     narrow/change types, drop enum/union variants, or relax numeric/length bounds.
 *   - `role === 'request'`: client input (body, query, or params) — must not add required fields,
 *     promote optional fields to required, remove supported fields, narrow/change accepted types,
 *     drop enum/union variants, or tighten numeric/length bounds.
 */
export function diffSchemas(
  base: JsonSchema,
  curr: JsonSchema,
  role: 'response' | 'request',
  route: string,
  jsonPath: string,
  out: RestContractBreak[],
): void {
  // 1. Enum / literal union compatibility
  const baseEnum = extractEnumLiterals(base)
  const currEnum = extractEnumLiterals(curr)
  if (baseEnum !== null) {
    if (currEnum === null) {
      const baseTypes = extractTypeSet(base)
      const currTypes = extractTypeSet(curr)
      if (baseTypes && currTypes) {
        const incompatible = [...baseTypes].some((t) => !currTypes.has(t))
        if (incompatible) {
          out.push({
            rule: 'REST-CONTRACT-TYPE-CHANGED',
            route,
            path: jsonPath,
            message: `${role} enum type changed from [${[...baseTypes].join('|')}] to [${[...currTypes].join('|')}]`,
          })
          return
        }
      }
    } else {
      const currSet = new Set(currEnum)
      for (const lit of baseEnum) {
        if (!currSet.has(lit)) {
          out.push({
            rule: 'REST-CONTRACT-ENUM-VALUE-REMOVED',
            route,
            path: jsonPath,
            message: `removed existing enum value ${lit} from ${role} schema`,
          })
        }
      }
      return
    }
  } else if (currEnum !== null) {
    out.push({
      rule: 'REST-CONTRACT-TYPE-NARROWED',
      route,
      path: jsonPath,
      message: `${role} field narrowed from open schema to closed enum [${currEnum.join(', ')}]`,
    })
    return
  }

  // 2. Primitive / union type compatibility
  const baseTypes = extractTypeSet(base)
  const currTypes = extractTypeSet(curr)
  if (baseTypes !== null && currTypes !== null) {
    const dropped = [...baseTypes].filter((t) => {
      if (currTypes.has(t)) return false
      if (role === 'request' && t === 'integer' && currTypes.has('number')) return false
      return true
    })
    const added = [...currTypes].filter((t) => !baseTypes.has(t))

    if (dropped.length > 0) {
      const isNumberToIntegerNarrowing =
        baseTypes.size === 1 &&
        baseTypes.has('number') &&
        currTypes.size === 1 &&
        currTypes.has('integer')
      const isCompleteSwap =
        !isNumberToIntegerNarrowing && [...baseTypes].every((t) => !currTypes.has(t))
      out.push({
        rule: isCompleteSwap ? 'REST-CONTRACT-TYPE-CHANGED' : 'REST-CONTRACT-TYPE-NARROWED',
        route,
        path: jsonPath,
        message: `${role} type ${isCompleteSwap ? 'changed' : 'narrowed'} from [${[...baseTypes].sort().join(' | ')}] to [${[...currTypes].sort().join(' | ')}]`,
      })
      return
    }

    if (role === 'response' && added.length > 0) {
      out.push({
        rule: 'REST-CONTRACT-TYPE-CHANGED',
        route,
        path: jsonPath,
        message: `response type widened incompatibly from [${[...baseTypes].sort().join(' | ')}] to [${[...currTypes].sort().join(' | ')}]`,
      })
      return
    }
  } else if (baseTypes === null && currTypes !== null) {
    out.push({
      rule: 'REST-CONTRACT-TYPE-NARROWED',
      route,
      path: jsonPath,
      message: `${role} field narrowed from unknown/any to [${[...currTypes].sort().join(' | ')}]`,
    })
    return
  }

  // 3. Unwrap nullable union (`T | null`) to diff inner non-null schema recursively
  const baseInner = unwrapNullableBranch(base)
  const currInner = unwrapNullableBranch(curr)
  if (baseInner && currInner) {
    diffSchemas(baseInner, currInner, role, route, jsonPath, out)
    return
  }

  // 4. General `anyOf` unions — also handles union collapsed into a single non-anyOf schema (or vice versa)
  if (Array.isArray(base.anyOf) || Array.isArray(curr.anyOf)) {
    const baseBranches = Array.isArray(base.anyOf) ? base.anyOf.filter(isRecord) : [base]
    const currBranches = Array.isArray(curr.anyOf) ? curr.anyOf.filter(isRecord) : [curr]
    for (let i = 0; i < baseBranches.length; i++) {
      const bBranch = baseBranches[i]!
      const matched = currBranches.some((cBranch) => {
        const probe: RestContractBreak[] = []
        diffSchemas(bBranch, cBranch, role, route, `${jsonPath}|${i}`, probe)
        return probe.length === 0
      })
      if (!matched) {
        out.push({
          rule: 'REST-CONTRACT-UNION-BRANCH-REMOVED',
          route,
          path: `${jsonPath}|${i}`,
          message: `${role} union branch #${i} was removed or broken incompatibly`,
        })
      }
    }
    return
  }

  // 5. Direction-sensitive numeric, string length, and array length bounds
  diffConstraintBounds(base, curr, role, route, jsonPath, out)

  // 6. Object properties
  if (base.type === 'object' && curr.type === 'object') {
    const baseProps = isRecord(base.properties) ? (base.properties as Record<string, JsonSchema>) : {}
    const currProps = isRecord(curr.properties) ? (curr.properties as Record<string, JsonSchema>) : {}
    const baseReq = new Set(Array.isArray(base.required) ? (base.required as string[]) : [])
    const currReq = new Set(Array.isArray(curr.required) ? (curr.required as string[]) : [])

    if (role === 'response') {
      for (const prop of Object.keys(baseProps).sort()) {
        const nextPath = `${jsonPath}.${prop}`
        if (!(prop in currProps)) {
          out.push({
            rule: 'REST-CONTRACT-RESPONSE-FIELD-REMOVED',
            route,
            path: nextPath,
            message: `response field "${prop}" was removed`,
          })
          continue
        }
        if (baseReq.has(prop) && !currReq.has(prop)) {
          out.push({
            rule: 'REST-CONTRACT-RESPONSE-FIELD-MADE-OPTIONAL',
            route,
            path: nextPath,
            message: `previously required response field "${prop}" became optional`,
          })
        }
        diffSchemas(baseProps[prop]!, currProps[prop]!, 'response', route, nextPath, out)
      }
      // New properties in response are additive and allowed.
    } else {
      // Request / query / params
      for (const prop of Object.keys(currProps).sort()) {
        const nextPath = `${jsonPath}.${prop}`
        if (!(prop in baseProps)) {
          if (currReq.has(prop)) {
            out.push({
              rule: 'REST-CONTRACT-REQUIRED-REQUEST-FIELD-ADDED',
              route,
              path: nextPath,
              message: `new required request field "${prop}" breaks existing callers`,
            })
          }
          // New optional request field is additive and allowed.
        }
      }
      for (const prop of Object.keys(baseProps).sort()) {
        const nextPath = `${jsonPath}.${prop}`
        if (!(prop in currProps)) {
          out.push({
            rule: 'REST-CONTRACT-REQUEST-FIELD-REMOVED',
            route,
            path: nextPath,
            message: `existing request field "${prop}" was removed`,
          })
          continue
        }
        if (!baseReq.has(prop) && currReq.has(prop)) {
          out.push({
            rule: 'REST-CONTRACT-REQUEST-FIELD-MADE-REQUIRED',
            route,
            path: nextPath,
            message: `previously optional request field "${prop}" became required`,
          })
        }
        diffSchemas(baseProps[prop]!, currProps[prop]!, 'request', route, nextPath, out)
      }
    }

    // Record<string, V> via additionalProperties schema
    if (isRecord(base.additionalProperties) && isRecord(curr.additionalProperties)) {
      diffSchemas(
        base.additionalProperties,
        curr.additionalProperties,
        role,
        route,
        `${jsonPath}.*`,
        out,
      )
    }
    return
  }

  // 7. Array items
  if (base.type === 'array' && curr.type === 'array' && isRecord(base.items) && isRecord(curr.items)) {
    diffSchemas(base.items, curr.items, role, route, `${jsonPath}[]`, out)
  }
}

export function diffRestContractSnapshots(
  base: RestContractSnapshot,
  curr: RestContractSnapshot,
): RestContractBreak[] {
  const breaks: RestContractBreak[] = []
  const baseRoutes = base.routes ?? {}
  const currRoutes = curr.routes ?? {}

  for (const routeKey of Object.keys(baseRoutes).sort()) {
    const bRoute = baseRoutes[routeKey]!
    const cRoute = currRoutes[routeKey]
    if (!cRoute) {
      breaks.push({
        rule: 'REST-CONTRACT-ROUTE-REMOVED',
        route: routeKey,
        path: '$',
        message: `existing REST route contract "${routeKey}" was deleted`,
      })
      continue
    }
    if (
      bRoute.method !== cRoute.method ||
      bRoute.path !== cRoute.path ||
      bRoute.domain !== cRoute.domain
    ) {
      breaks.push({
        rule: 'REST-CONTRACT-ROUTE-CHANGED',
        route: routeKey,
        path: '$',
        message: `route metadata changed (${bRoute.domain} ${bRoute.method} ${bRoute.path} -> ${cRoute.domain} ${cRoute.method} ${cRoute.path})`,
      })
      continue
    }

    // Response schema
    diffSchemas(bRoute.response, cRoute.response, 'response', routeKey, 'response', breaks)

    // Input sections: request body, query parameters, path params
    for (const secName of ['request', 'query', 'params'] as const) {
      const bSec = bRoute[secName]
      const cSec = cRoute[secName]
      if (bSec && !cSec) {
        breaks.push({
          rule: 'REST-CONTRACT-SECTION-REMOVED',
          route: routeKey,
          path: secName,
          message: `existing "${secName}" schema block was removed from route "${routeKey}"`,
        })
      } else if (bSec && cSec) {
        diffSchemas(bSec, cSec, 'request', routeKey, secName, breaks)
      } else if (!bSec && cSec) {
        const reqFields = Array.isArray(cSec.required) ? (cSec.required as string[]) : []
        if (reqFields.length > 0) {
          for (const f of reqFields) {
            breaks.push({
              rule: 'REST-CONTRACT-REQUIRED-REQUEST-FIELD-ADDED',
              route: routeKey,
              path: `${secName}.${f}`,
              message: `added required ${secName} field "${f}" to previously ${secName}-less route`,
            })
          }
        } else if (cSec.type !== 'object') {
          breaks.push({
            rule: 'REST-CONTRACT-REQUIRED-REQUEST-FIELD-ADDED',
            route: routeKey,
            path: secName,
            message: `added non-object "${secName}" schema to previously ${secName}-less route`,
          })
        }
      }
    }
  }

  return breaks
}

export function formatSnapshotJson(snapshot: RestContractSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

export function formatContractBreak(b: RestContractBreak): string {
  return [
    `[GATE-ERROR] ${b.rule} [${b.route}] ${b.path}`,
    `  Detail: ${b.message}`,
    '  Rule: Core 5-domain REST contracts are additive-only (expand new optional fields/routes; never remove or narrow existing wire shapes).',
  ].join('\n')
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function loadBaseSnapshotFromGit(
  root: string,
  base: string,
  snapshotRel: string,
): RestContractSnapshot | null {
  // Validate base ref (fail-closed if ref does not exist)
  runGit(root, ['rev-parse', '--verify', `${base}^{commit}`])
  const probe = spawnSync('git', ['-C', root, 'cat-file', '-e', `${base}:${snapshotRel}`], {
    stdio: 'ignore',
  })
  if (probe.status !== 0) {
    return null
  }
  const raw = runGit(root, ['show', `${base}:${snapshotRel}`])
  return JSON.parse(raw) as RestContractSnapshot
}

export function checkRestContractCompat(opts: {
  root: string
  base?: string
  snapshotRel?: string
  liveSnapshot?: RestContractSnapshot
}): {
  snapshotSynced: boolean
  baseSnapshotPresent: boolean
  breaks: RestContractBreak[]
  routeCount: number
} {
  const snapshotRel = opts.snapshotRel ?? DEFAULT_SNAPSHOT_PATH
  const snapshotAbs = path.resolve(opts.root, snapshotRel)
  const live = opts.liveSnapshot ?? loadLiveRestContractSnapshot(opts.root)
  const expectedJson = formatSnapshotJson(live)
  const breaks: RestContractBreak[] = []

  // Step 1: Verify snapshot file matches live httpContracts.ts export
  if (!existsSync(snapshotAbs)) {
    breaks.push({
      rule: 'REST-CONTRACT-SNAPSHOT-DRIFT',
      route: '<snapshot>',
      path: snapshotRel,
      message: `snapshot file missing (${snapshotRel}); run: npx tsx scripts/check-rest-contract-compat.ts --write-snapshot`,
    })
    return {
      snapshotSynced: false,
      baseSnapshotPresent: false,
      breaks,
      routeCount: Object.keys(live.routes).length,
    }
  }

  const diskRaw = readFileSync(snapshotAbs, 'utf8')
  const snapshotSynced = diskRaw === expectedJson
  if (!snapshotSynced) {
    breaks.push({
      rule: 'REST-CONTRACT-SNAPSHOT-DRIFT',
      route: '<snapshot>',
      path: snapshotRel,
      message: `${snapshotRel} is out of sync with packages/protocol/src/httpContracts.ts; run: npx tsx scripts/check-rest-contract-compat.ts --write-snapshot`,
    })
  }

  // Step 2: Recursive backward-compat diff against base ref if base snapshot exists
  let baseSnapshotPresent = false
  if (opts.base) {
    const baseSnap = loadBaseSnapshotFromGit(opts.root, opts.base, snapshotRel)
    if (baseSnap) {
      baseSnapshotPresent = true
      breaks.push(...diffRestContractSnapshots(baseSnap, live))
    }
  }

  return {
    snapshotSynced,
    baseSnapshotPresent,
    breaks,
    routeCount: Object.keys(live.routes).length,
  }
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let base: string | undefined
  let snapshotRel = DEFAULT_SNAPSHOT_PATH
  let writeSnapshot = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--write-snapshot') {
      writeSnapshot = true
    } else if (arg === '--root') {
      const v = argv[++i]
      if (!v) {
        console.error('[rest-contract-compat] --root requires a path')
        return 2
      }
      root = path.resolve(v)
    } else if (arg === '--base') {
      const v = argv[++i]
      if (!v) {
        console.error('[rest-contract-compat] --base requires a git ref')
        return 2
      }
      base = v
    } else if (arg === '--snapshot') {
      const v = argv[++i]
      if (!v) {
        console.error('[rest-contract-compat] --snapshot requires a relative path')
        return 2
      }
      snapshotRel = v
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: npx tsx scripts/check-rest-contract-compat.ts [--write-snapshot] [--base <ref>] [--root <repo>] [--snapshot <rel>]',
      )
      return 0
    } else {
      console.error(`[rest-contract-compat] unknown arg: ${arg}`)
      return 2
    }
  }

  try {
    if (writeSnapshot) {
      const snap = loadLiveRestContractSnapshot(root)
      const outPath = path.resolve(root, snapshotRel)
      writeFileSync(outPath, formatSnapshotJson(snap), 'utf8')
      console.log(
        `[rest-contract-compat] wrote ${snapshotRel} (${Object.keys(snap.routes).length} routes across ${snap.domains.length} domains)`,
      )
      return 0
    }

    const res = checkRestContractCompat({ root, base, snapshotRel })
    if (res.breaks.length > 0) {
      for (const b of res.breaks) {
        console.error(formatContractBreak(b))
      }
      console.error(
        `[rest-contract-compat] FAILED: ${res.breaks.length} compatibility/snapshot error(s)`,
      )
      return 1
    }

    const baseNote = base
      ? res.baseSnapshotPresent
        ? `backward-compat verified vs ${base}`
        : `base ${base} has no prior snapshot (initial landing, snapshot sync verified)`
      : 'snapshot sync verified'
    console.log(`[rest-contract-compat] ok: ${res.routeCount} routes (${baseNote})`)
    return 0
  } catch (err) {
    console.error(
      `[rest-contract-compat] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`,
    )
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
