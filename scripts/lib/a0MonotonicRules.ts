/**
 * Semantic JSON AST comparison evaluators for `scripts/check-a0-monotonic.ts` (OCV5-904).
 */
import { isPlainObject } from './a0ApprovalReceipt.js'
import { validateRuntimeImagePin } from './runtimeImagePin.js'

export {
  type A0ApprovalReceipt,
  type ApprovalVerification,
  buildA0CanonicalPayload,
  canonicalizeA0AllowedPaths,
  computeA0ReceiptDigest,
  computeA0ReceiptHmac,
  globToRegExp,
  isPlainObject,
  matchesAnyGlob,
  readValidatedHmacKeyFile,
  verifyA0ApprovalFile,
  verifyA0ApprovalReceipt,
  verifyA0ApprovalUnified,
} from './a0ApprovalReceipt.js'

export interface A0Finding {
  path: string
  tier: 'A0' | 'A1'
  rule: string
  detail: string
  category?: string
}

const LAYER_RANK: Record<string, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
  L6: 6,
  F0: 0,
  F1: 1,
  F2: 2,
  F3: 3,
  F4: 4,
  F5: 5,
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseIsoDateMs(s: unknown): number {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return Number.NaN
  const ms = Date.parse(`${s}T00:00:00Z`)
  if (!Number.isFinite(ms)) return Number.NaN
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : Number.NaN
}

/** Semantic check for `deploy/v5/runtime-image-pin.json` (A1 auto-pass when valid). */
export function evaluateRuntimeImagePinChange(
  filePath: string,
  headText: string | null,
): A0Finding[] {
  if (headText === null) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-PIN-DELETED', detail: `${filePath} deleted` }]
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(headText)
  } catch (err) {
    return [
      {
        path: filePath,
        tier: 'A0',
        rule: 'A0-PIN-INVALID-JSON',
        detail: `${filePath} invalid JSON: ${(err as Error).message}`,
      },
    ]
  }
  const res = validateRuntimeImagePin(parsed)
  if (!res.ok) {
    return [
      {
        path: filePath,
        tier: 'A0',
        rule: 'A0-PIN-SCHEMA-INVALID',
        detail: `${filePath} failed schema/supply-chain validation: ${res.errors.join('; ')}`,
      },
    ]
  }
  return [
    {
      path: filePath,
      tier: 'A1',
      rule: 'A1-RUNTIME-PIN-UPDATE',
      detail: `validated declarative runtime image pin (${res.pin.runtimeImage})`,
    },
  ]
}

interface ModuleSpec {
  layer?: string
  scope?: string[]
  match?: string[]
  allow?: string[]
  authorities?: string[]
}

/**
 * Semantic check for `arch/modules.json`:
 *   - A1: splitting modules, narrowing scope, removing allow/authorities, adding subdomains.
 *   - A0: adding ANY new `allow` edge, adding `authorities`, widening `scope`, raising `layer`.
 */
export function evaluateModulesJsonChange(
  filePath: string,
  baseText: string | null,
  headText: string | null,
): A0Finding[] {
  if (headText === null) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-MODULES-DELETED', detail: `${filePath} deleted` }]
  }
  let headRaw: unknown
  try {
    headRaw = JSON.parse(headText)
  } catch (err) {
    return [
      {
        path: filePath,
        tier: 'A0',
        rule: 'A0-MODULES-INVALID-JSON',
        detail: `${filePath} invalid JSON: ${(err as Error).message}`,
      },
    ]
  }
  if (!isPlainObject(headRaw) || !isPlainObject(headRaw.modules)) {
    return [
      { path: filePath, tier: 'A0', rule: 'A0-MODULES-SCHEMA', detail: `${filePath} missing modules` },
    ]
  }
  if (baseText === null) {
    return [{ path: filePath, tier: 'A1', rule: 'A1-MODULES-INTRODUCED', detail: `introduced ${filePath}` }]
  }

  let baseRaw: unknown
  try {
    baseRaw = JSON.parse(baseText)
  } catch {
    return [{ path: filePath, tier: 'A0', rule: 'A0-MODULES-BASE-INVALID', detail: `base ${filePath} invalid` }]
  }
  const baseMods = (
    isPlainObject(baseRaw) && isPlainObject(baseRaw.modules) ? baseRaw.modules : {}
  ) as Record<string, ModuleSpec>
  const headMods = headRaw.modules as Record<string, ModuleSpec>
  const violations: A0Finding[] = []

  for (const [modName, hMod] of Object.entries(headMods)) {
    if (!isPlainObject(hMod)) {
      violations.push({
        path: filePath,
        tier: 'A0',
        rule: 'A0-MODULES-SCHEMA',
        detail: `module "${modName}" must be an object`,
      })
      continue
    }
    const bMod = baseMods[modName]
    const headAllow = Array.isArray(hMod.allow) ? hMod.allow : []
    const baseAllow = new Set(Array.isArray(bMod?.allow) ? bMod.allow : [])
    for (const target of headAllow) {
      if (!baseAllow.has(target)) {
        violations.push({
          path: filePath,
          tier: 'A0',
          rule: 'A0-MODULES-ALLOW-ADDED',
          detail: `module "${modName}" added new allow edge -> "${target}"`,
        })
      }
    }

    const headAuth = Array.isArray(hMod.authorities) ? hMod.authorities : []
    const baseAuth = new Set(Array.isArray(bMod?.authorities) ? bMod.authorities : [])
    for (const auth of headAuth) {
      if (!baseAuth.has(auth)) {
        violations.push({
          path: filePath,
          tier: 'A0',
          rule: 'A0-MODULES-AUTHORITY-ADDED',
          detail: `module "${modName}" added new authority "${auth}"`,
        })
      }
    }

    if (bMod) {
      if (typeof bMod.layer === 'string' && typeof hMod.layer === 'string') {
        const bRank = LAYER_RANK[bMod.layer]
        const hRank = LAYER_RANK[hMod.layer]
        if (bMod.layer[0] !== hMod.layer[0] || (bRank !== undefined && hRank !== undefined && hRank > bRank)) {
          violations.push({
            path: filePath,
            tier: 'A0',
            rule: 'A0-MODULES-LAYER-RAISED',
            detail: `module "${modName}" layer relaxed from ${bMod.layer} to ${hMod.layer}`,
          })
        }
      }
      if (Array.isArray(bMod.scope) && Array.isArray(hMod.scope)) {
        const baseScope = new Set(bMod.scope)
        for (const s of hMod.scope) {
          if (!baseScope.has(s)) {
            violations.push({
              path: filePath,
              tier: 'A0',
              rule: 'A0-MODULES-SCOPE-WIDENED',
              detail: `module "${modName}" widened scope with "${s}"`,
            })
          }
        }
      }
    }
  }

  return violations.length > 0
    ? violations
    : [
        {
          path: filePath,
          tier: 'A1',
          rule: 'A1-MODULES-SPLIT-OR-TIGHTENED',
          detail: 'module split / tightening with zero new allow edges, authorities, or layer relaxations',
        },
      ]
}

/** Semantic check for `.github/file-size-baseline.json` (zero slack + shrink-only). */
export function evaluateFileSizeBaselineChange(
  filePath: string,
  baseText: string | null,
  headText: string | null,
): A0Finding[] {
  if (headText === null) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-BASELINE-DELETED', detail: `${filePath} deleted` }]
  }
  let head: Record<string, unknown>
  try {
    const parsed = JSON.parse(headText)
    if (!isPlainObject(parsed)) throw new Error('must be object')
    head = parsed
  } catch (err) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-BASELINE-INVALID', detail: `${filePath}: ${(err as Error).message}` }]
  }

  const violations: A0Finding[] = []
  for (const slackKey of ['slack', 'yellowZoneSlack', 'orangeZoneSlack'] as const) {
    const v = head[slackKey]
    if ((slackKey === 'slack' && v !== 0) || (v !== undefined && v !== 0)) {
      violations.push({
        path: filePath,
        tier: 'A0',
        rule: 'A0-FILESIZE-SLACK-NONZERO',
        detail: `${slackKey} must be 0 (got ${String(v)})`,
      })
    }
  }

  if (baseText !== null) {
    let base: Record<string, unknown>
    try {
      const parsed = JSON.parse(baseText)
      if (!isPlainObject(parsed)) throw new Error('base not object')
      base = parsed
    } catch {
      return [{ path: filePath, tier: 'A0', rule: 'A0-BASELINE-BASE-INVALID', detail: `base ${filePath} invalid` }]
    }

    for (const k of ['limit', 'slack', 'yellowZoneLimit', 'yellowZoneSlack', 'orangeZoneLimit', 'orangeZoneSlack']) {
      const bv = base[k]
      const hv = head[k]
      if (typeof bv === 'number') {
        if (typeof hv !== 'number') {
          violations.push({ path: filePath, tier: 'A0', rule: 'A0-FILESIZE-THRESHOLD-REMOVED', detail: `${k} (${bv}) removed` })
        } else if (hv > bv) {
          violations.push({ path: filePath, tier: 'A0', rule: 'A0-FILESIZE-THRESHOLD-RAISED', detail: `${k} raised from ${bv} to ${hv}` })
        }
      }
    }

    const bRed = isPlainObject(base.files) ? (base.files as Record<string, number>) : {}
    const bCss = isPlainObject(base.cssFiles) ? (base.cssFiles as Record<string, number>) : {}
    const bYel = isPlainObject(base.yellowZoneFiles) ? (base.yellowZoneFiles as Record<string, number>) : {}
    const bOrg = isPlainObject(base.orangeZoneFiles) ? (base.orangeZoneFiles as Record<string, number>) : {}

    const checkZone = (
      zoneKey: 'files' | 'cssFiles' | 'yellowZoneFiles' | 'orangeZoneFiles',
      prevFn: (p: string) => number | undefined,
    ) => {
      if (base[zoneKey] !== undefined && !isPlainObject(head[zoneKey])) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-FILESIZE-ZONE-REMOVED', detail: `${zoneKey} removed` })
        return
      }
      if (!isPlainObject(head[zoneKey])) return
      if (zoneKey === 'orangeZoneFiles' && base.orangeZoneFiles === undefined) return
      for (const [p, n] of Object.entries(head[zoneKey] as Record<string, unknown>)) {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
          violations.push({ path: filePath, tier: 'A0', rule: 'A0-BASELINE-INVALID', detail: `${zoneKey}["${p}"] invalid` })
          continue
        }
        const prev = prevFn(p)
        if (prev === undefined || n > prev) {
          violations.push({
            path: filePath,
            tier: 'A0',
            rule: 'A0-FILESIZE-BASELINE-RAISED',
            detail: `${zoneKey}["${p}"] raised from ${prev ?? 'absent'} to ${n}`,
          })
        }
      }
    }

    checkZone('files', (p) => bRed[p])
    checkZone('cssFiles', (p) => bCss[p])
    checkZone('yellowZoneFiles', (p) => bYel[p] ?? bRed[p] ?? bCss[p])
    checkZone('orangeZoneFiles', (p) => bOrg[p] ?? bYel[p] ?? bRed[p])
  }

  return violations.length > 0
    ? violations
    : [{ path: filePath, tier: 'A1', rule: 'A1-FILESIZE-BASELINE-TIGHTENED', detail: 'file-size baseline tightened with slack=0' }]
}

/** Semantic check for `.github/file-size-ratchet-exceptions.json` (no additions or renewals). */
export function evaluateFileSizeExceptionsChange(
  filePath: string,
  baseText: string | null,
  headText: string | null,
): A0Finding[] {
  if (headText === null) {
    return [{ path: filePath, tier: 'A1', rule: 'A1-EXCEPTIONS-REMOVED', detail: `${filePath} removed` }]
  }
  let headRaw: unknown
  try {
    headRaw = JSON.parse(headText)
  } catch (err) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-EXCEPTIONS-INVALID', detail: `${filePath}: ${(err as Error).message}` }]
  }
  if (!Array.isArray(headRaw)) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-EXCEPTIONS-INVALID', detail: `${filePath} must be JSON array` }]
  }

  const baseMap = new Map<string, { maxLines: number; expires: string; expiresMs: number }>()
  if (baseText !== null) {
    try {
      const baseRaw = JSON.parse(baseText)
      if (Array.isArray(baseRaw)) {
        for (const item of baseRaw) {
          if (isPlainObject(item) && typeof item.path === 'string') {
            baseMap.set(item.path, {
              maxLines: typeof item.maxLines === 'number' ? item.maxLines : 0,
              expires: typeof item.expires === 'string' ? item.expires : '',
              expiresMs: parseIsoDateMs(item.expires),
            })
          }
        }
      }
    } catch {
      // ignore unparseable base
    }
  }

  const violations: A0Finding[] = []
  const seen = new Set<string>()
  for (const [idx, item] of headRaw.entries()) {
    if (!isPlainObject(item) || typeof item.path !== 'string') {
      violations.push({ path: filePath, tier: 'A0', rule: 'A0-EXCEPTIONS-INVALID', detail: `exceptions[${idx}] missing path` })
      continue
    }
    if (seen.has(item.path)) {
      violations.push({ path: filePath, tier: 'A0', rule: 'A0-EXCEPTIONS-DUPLICATE', detail: `duplicate entry for ${item.path}` })
      continue
    }
    seen.add(item.path)

    const prev = baseMap.get(item.path)
    if (!prev) {
      violations.push({
        path: filePath,
        tier: 'A0',
        rule: 'A0-EXCEPTION-ADDED',
        detail: `added new file-size exception for ${item.path} (maxLines=${String(item.maxLines)}, expires=${String(item.expires)})`,
      })
      continue
    }
    const headMax = typeof item.maxLines === 'number' ? item.maxLines : Number.POSITIVE_INFINITY
    if (headMax > prev.maxLines) {
      violations.push({
        path: filePath,
        tier: 'A0',
        rule: 'A0-EXCEPTION-RAISED',
        detail: `exception maxLines for ${item.path} raised from ${prev.maxLines} to ${headMax}`,
      })
    }
    const headExpMs = parseIsoDateMs(item.expires)
    if (!Number.isFinite(headExpMs)) {
      violations.push({ path: filePath, tier: 'A0', rule: 'A0-EXCEPTIONS-INVALID', detail: `invalid expires for ${item.path}` })
    } else if (Number.isFinite(prev.expiresMs) && headExpMs > prev.expiresMs) {
      violations.push({
        path: filePath,
        tier: 'A0',
        rule: 'A0-EXCEPTION-RENEWED',
        detail: `exception for ${item.path} renewed from ${prev.expires} to ${String(item.expires)}`,
      })
    }
  }

  return violations.length > 0
    ? violations
    : [{ path: filePath, tier: 'A1', rule: 'A1-EXCEPTIONS-SHRUNK', detail: 'file-size exceptions strictly reduced' }]
}

/** Semantic check for budgets, count ratchets, exempt lists, context-eval, and feature flags. */
export function evaluateShrinkOnlyJsonChange(
  filePath: string,
  baseText: string | null,
  headText: string | null,
  opts?: { allowDelete?: boolean; mode?: 'budgets' | 'counts' | 'exemptList' | 'contextEval' | 'featureFlags' },
): A0Finding[] {
  if (headText === null) {
    return opts?.allowDelete
      ? [{ path: filePath, tier: 'A1', rule: 'A1-EXEMPT-REMOVED', detail: `${filePath} deleted` }]
      : [{ path: filePath, tier: 'A0', rule: 'A0-BASELINE-DELETED', detail: `protected baseline ${filePath} deleted` }]
  }
  let headRaw: unknown
  try {
    headRaw = JSON.parse(headText)
  } catch (err) {
    return [{ path: filePath, tier: 'A0', rule: 'A0-BASELINE-INVALID', detail: `${filePath}: ${(err as Error).message}` }]
  }
  if (baseText === null) {
    return [{ path: filePath, tier: 'A1', rule: 'A1-BASELINE-INTRODUCED', detail: `introduced baseline ${filePath}` }]
  }
  let baseRaw: unknown
  try {
    baseRaw = JSON.parse(baseText)
  } catch {
    return [{ path: filePath, tier: 'A0', rule: 'A0-BASELINE-BASE-INVALID', detail: `base ${filePath} invalid` }]
  }

  const violations: A0Finding[] = []
  const mode = opts?.mode ?? 'counts'

  if (mode === 'budgets') {
    if (!isPlainObject(headRaw) || !isPlainObject(baseRaw)) {
      return [{ path: filePath, tier: 'A0', rule: 'A0-BUDGET-INVALID', detail: `${filePath} must be JSON object` }]
    }
    for (const [k, bv] of Object.entries(baseRaw)) {
      if (k === 'note' || k === 'schema' || typeof bv !== 'number') continue
      const hv = headRaw[k]
      if (typeof hv !== 'number') {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-BUDGET-REMOVED', detail: `budget "${k}" (${bv}) removed` })
      } else if (hv > bv) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-BUDGET-RAISED', detail: `budget "${k}" raised ${bv} -> ${hv}` })
      }
    }
  } else if (mode === 'exemptList') {
    const collect = (v: unknown, pfx = ''): Set<string> => {
      const s = new Set<string>()
      if (Array.isArray(v)) {
        for (const item of v) s.add(`${pfx}:${JSON.stringify(item)}`)
      } else if (isPlainObject(v)) {
        for (const [k, val] of Object.entries(v)) {
          if (k === 'note' || k === 'schema') continue
          for (const sub of collect(val, pfx ? `${pfx}.${k}` : k)) s.add(sub)
        }
      } else if (v !== undefined) s.add(`${pfx}:${JSON.stringify(v)}`)
      return s
    }
    const baseSet = collect(baseRaw)
    for (const tok of collect(headRaw)) {
      if (!baseSet.has(tok)) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-EXEMPTION-ADDED', detail: `added exemption: ${tok.slice(0, 120)}` })
      }
    }
  } else if (mode === 'contextEval') {
    if (!isPlainObject(headRaw) || !isPlainObject(baseRaw)) {
      return [{ path: filePath, tier: 'A0', rule: 'A0-CONTEXT-EVAL-INVALID', detail: `${filePath} must be JSON object` }]
    }
    const walk = (bObj: Record<string, unknown>, hObj: Record<string, unknown>, pfx: string) => {
      for (const [k, bv] of Object.entries(bObj)) {
        if (k === 'generatedAt' || k === 'schemaVersion' || k === 'note') continue
        const full = pfx ? `${pfx}.${k}` : k
        const hv = hObj[k]
        if (typeof bv === 'number') {
          if (typeof hv !== 'number') {
            violations.push({ path: filePath, tier: 'A0', rule: 'A0-THRESHOLD-REMOVED', detail: `${full} removed` })
          } else if (/^min[A-Z]/.test(k) ? hv < bv : hv > bv) {
            violations.push({ path: filePath, tier: 'A0', rule: 'A0-THRESHOLD-LOOSENED', detail: `${full} loosened ${bv} -> ${hv}` })
          }
        } else if (isPlainObject(bv)) {
          if (!isPlainObject(hv)) {
            violations.push({ path: filePath, tier: 'A0', rule: 'A0-THRESHOLD-REMOVED', detail: `section ${full} removed` })
          } else walk(bv, hv, full)
        }
      }
    }
    walk(baseRaw, headRaw, '')
    const baseWaivers = new Set(Array.isArray(baseRaw.waivers) ? baseRaw.waivers.map((w) => JSON.stringify(w)) : [])
    for (const hw of Array.isArray(headRaw.waivers) ? headRaw.waivers.map((w) => JSON.stringify(w)) : []) {
      if (!baseWaivers.has(hw)) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-WAIVER-ADDED', detail: `added waiver: ${hw.slice(0, 120)}` })
      }
    }
  } else if (mode === 'featureFlags') {
    if (!isPlainObject(headRaw) || !Array.isArray(headRaw.flags)) {
      return [{ path: filePath, tier: 'A0', rule: 'A0-FLAGS-INVALID', detail: `${filePath} must have flags[]` }]
    }
    const baseFlags = new Map<string, { permanent: boolean; expireAt: string | null }>()
    if (isPlainObject(baseRaw) && Array.isArray(baseRaw.flags)) {
      for (const f of baseRaw.flags) {
        if (isPlainObject(f) && typeof f.name === 'string') {
          baseFlags.set(f.name, { permanent: Boolean(f.permanent), expireAt: typeof f.expireAt === 'string' ? f.expireAt : null })
        }
      }
    }
    for (const f of headRaw.flags) {
      if (!isPlainObject(f) || typeof f.name !== 'string') continue
      const prev = baseFlags.get(f.name)
      if (!prev) continue
      if (!prev.permanent && f.permanent === true) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-FLAG-MADE-PERMANENT', detail: `flag "${f.name}" flipped to permanent=true` })
      } else if (!prev.permanent && f.permanent === false) {
        const bMs = parseIsoDateMs(prev.expireAt)
        const hMs = parseIsoDateMs(f.expireAt)
        if (Number.isFinite(bMs) && Number.isFinite(hMs) && hMs > bMs) {
          violations.push({ path: filePath, tier: 'A0', rule: 'A0-FLAG-TTL-EXTENDED', detail: `flag "${f.name}" expireAt extended ${prev.expireAt} -> ${String(f.expireAt)}` })
        }
      }
    }
  } else {
    const META = new Set(['schema', 'schemaVersion', 'generatedAt', 'note', 'tier', 'keyFormat', 'categories', 'scenes', 'viewports', 'themes', 'thresholds'])
    const flatNum = (obj: unknown, pfx = ''): Map<string, number> => {
      const m = new Map<string, number>()
      if (!isPlainObject(obj)) return m
      for (const [k, v] of Object.entries(obj)) {
        if (!pfx && META.has(k)) continue
        const key = pfx ? `${pfx}.${k}` : k
        if (typeof v === 'number') m.set(key, v)
        else if (isPlainObject(v)) for (const [sk, sv] of flatNum(v, key)) m.set(sk, sv)
      }
      return m
    }
    const flatArr = (obj: unknown, pfx = ''): Map<string, Set<string>> => {
      const m = new Map<string, Set<string>>()
      if (!isPlainObject(obj)) return m
      for (const [k, v] of Object.entries(obj)) {
        if (!pfx && META.has(k)) continue
        const key = pfx ? `${pfx}.${k}` : k
        if (Array.isArray(v)) m.set(key, new Set(v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))))
      }
      return m
    }
    const baseNums = flatNum(baseRaw)
    for (const [k, hv] of flatNum(headRaw)) {
      const bv = baseNums.get(k)
      if (bv === undefined && hv > 0) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-BASELINE-ENTRY-ADDED', detail: `added "${k}"=${hv}` })
      } else if (bv !== undefined && hv > bv) {
        violations.push({ path: filePath, tier: 'A0', rule: 'A0-BASELINE-RAISED', detail: `"${k}" raised ${bv} -> ${hv}` })
      }
    }
    const baseArrs = flatArr(baseRaw)
    for (const [k, hSet] of flatArr(headRaw)) {
      const bSet = baseArrs.get(k) ?? new Set<string>()
      for (const item of hSet) {
        if (!bSet.has(item)) {
          violations.push({ path: filePath, tier: 'A0', rule: 'A0-BASELINE-ENTRY-ADDED', detail: `added item in "${k}": ${item.slice(0, 120)}` })
        }
      }
    }
  }

  return violations.length > 0
    ? violations
    : [{ path: filePath, tier: 'A1', rule: 'A1-BASELINE-SHRUNK', detail: `${filePath} monotonically tightened` }]
}

export const POLICY_PATH = 'arch/a0-protected-paths.json'

export interface A0Category {
  id: string
  description: string
  paths?: string[]
  gateGlobs?: string[]
}

export interface A0Policy {
  schemaVersion: 1
  approvalDefaults?: {
    hostApprovalDir?: string
    envApprovalDir?: string
    receiptSchemaVersion?: number
  }
  a0Categories: A0Category[]
  a1MonotonicSurfaces: {
    declarativePins: string[]
    newGateGlobs: string[]
    moduleMap: string
    fileSizeBaseline: string
    fileSizeExceptions: string
    designTokensExempt: string
    aiSmellsBaseline: string
    violationsBaseline: string
    budgets: string
    contextEvalBaseline: string
    featureFlagsRegistry: string
    countRatchetBaselines: string[]
    shrinkOnlyBaselines: string[]
  }
}

export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

export interface DiffEntry {
  status: DiffStatus
  path: string
  oldPath?: string
}

const REQUIRED_BOOTSTRAP_CATEGORIES = [
  'a0-meta-referee',
  'monotonic-baseline-checkers',
  'ci-workflows-and-gate-manifests',
  'host-control-plane-and-deploy',
  'billing-accounting-core',
  'permission-and-contract-core',
] as const

const DISALLOWED_BOOTSTRAP_RULES = new Set([
  'A0-PROTECTED-DELETED',
  'A0-PROTECTED-RENAMED',
  'A0-GATE-DELETED',
  'A0-GATE-RENAMED',
  'A0-FILESIZE-SLACK-NONZERO',
  'A0-PIN-DELETED',
  'A0-PIN-INVALID-JSON',
  'A0-PIN-SCHEMA-INVALID',
  'A0-MODULES-DELETED',
  'A0-BASELINE-DELETED',
  'A0-BUDGET-RAISED',
  'A0-BUDGET-REMOVED',
  'A0-FLAG-TTL-EXTENDED',
  'A0-FLAG-MADE-PERMANENT',
  'A0-EXCEPTION-ADDED',
  'A0-EXCEPTION-RENEWED',
  'A0-EXCEPTION-RAISED',
])

export function validateBootstrapNonWeakening(
  policy: A0Policy,
  a0Blocks: readonly A0Finding[],
): string[] {
  const errors: string[] = []
  const byId = new Map(policy.a0Categories.map((c) => [c.id, c]))
  for (const catId of REQUIRED_BOOTSTRAP_CATEGORIES) {
    const cat = byId.get(catId)
    if (!cat || (!cat.paths?.length && !cat.gateGlobs?.length)) {
      errors.push(`bootstrap policy missing required A0 category "${catId}"`)
    }
  }
  const metaPaths = new Set(byId.get('a0-meta-referee')?.paths ?? [])
  for (const reqPath of [POLICY_PATH, 'scripts/check-a0-monotonic.ts', '.github/CODEOWNERS']) {
    if (!metaPaths.has(reqPath)) {
      errors.push(`bootstrap policy a0-meta-referee must protect "${reqPath}"`)
    }
  }
  for (const blk of a0Blocks) {
    if (DISALLOWED_BOOTSTRAP_RULES.has(blk.rule)) {
      errors.push(`bootstrap disallowed weakening rule ${blk.rule} at ${blk.path}: ${blk.detail}`)
    }
  }
  return errors
}

export function parsePolicy(raw: unknown): A0Policy {
  if (
    !isPlainObject(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.a0Categories) ||
    !isPlainObject(raw.a1MonotonicSurfaces)
  ) {
    throw new Error(`${POLICY_PATH} must have schemaVersion=1, a0Categories[], and a1MonotonicSurfaces`)
  }
  return raw as unknown as A0Policy
}

export function parseNameStatusZ(raw: string): DiffEntry[] {
  const parts = raw.split('\0')
  const out: DiffEntry[] = []
  let i = 0
  while (i < parts.length) {
    const code = parts[i++]
    if (!code) break
    const status = code[0] as DiffStatus
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++]
      const newPath = parts[i++]
      if (oldPath && newPath) {
        out.push({ status, oldPath, path: newPath })
      }
    } else {
      const filePath = parts[i++]
      if (filePath) out.push({ status, path: filePath })
    }
  }
  return out
}
