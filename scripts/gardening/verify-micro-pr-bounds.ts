#!/usr/bin/env node
/**
 * Bounded Micro-PR Verifier for Autonomous Gardening Loop (OCV5-905).
 *
 * Enforces the 4 hard redlines on every L3 gardening micro-PR:
 * 1. `netLoc <= 300`, `abs(added - deleted) <= 300`, and controlled total churn (`<= 600` lines);
 * 2. `touchedFiles <= 5` (or `<= 8` strictly for mechanical `wheel-consolidation` import swaps);
 * 3. Forbidden from weakening any gate/A0 path or mutating existing test assertion semantics;
 * 4. Monotonic baseline reduction: zero baselines may increase AND at least one baseline metric
 *    must strictly decrease (`minBaselineDelta < 0`).
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { asRecord, errMsg, isRecord } from '../../packages/kernel/src/index.js'
import type { DebtCategory } from './arch-health-snapshot.js'

const execFileAsync = promisify(execFile)

export const MAX_NET_LOC = 300
export const MAX_ABS_NET_LOC = 300
export const MAX_TOTAL_CHURN = 600
export const MAX_STANDARD_FILES = 5
export const MAX_WHEEL_CONSOLIDATION_FILES = 8

export const BASELINE_FILES = [
  'arch/violations-baseline.json',
  '.github/file-size-baseline.json',
  'arch/ai-smells-baseline.json',
  'arch/complexity-baseline.json',
  'arch/clones-baseline.json',
  'arch/file-cycles-baseline.json',
  'arch/subdomain-violations-baseline.json',
] as const

const PROTECTED_GATE_PATTERNS: readonly RegExp[] = [
  /^scripts\/check-[^/]+\.(?:ts|sh|mjs|py)$/,
  /^\.github\/workflows\//,
  /^arch\/modules\.json$/,
  /^arch\/a0-protected-paths\.json$/,
  /^\.github\/file-size-ratchet-exceptions\.json$/,
  /^scripts\/deploy-v5-selfhost\.sh$/,
  /^scripts\/harness-gate\//,
]

export interface FileDiffStat {
  file: string
  status: 'A' | 'M' | 'D' | 'R'
  added: number
  deleted: number
  patchLines?: string[]
}

export interface BaselineDeltaRecord {
  file: string
  baseTotal: number
  headTotal: number
  delta: number
  raisedKeys: string[]
}

export interface MicroPrVerifyInput {
  category?: DebtCategory
  files: FileDiffStat[]
  baselineDeltas: BaselineDeltaRecord[]
  maxTotalChurn?: number
}

export interface MicroPrViolation {
  code:
    | 'EMPTY_DIFF'
    | 'NET_LOC_EXCEEDED'
    | 'ABS_DELTA_EXCEEDED'
    | 'TOTAL_CHURN_EXCEEDED'
    | 'TOUCHED_FILES_EXCEEDED'
    | 'NON_MECHANICAL_WHEEL_EDIT'
    | 'PROTECTED_GATE_TOUCHED'
    | 'TEST_ASSERTION_MODIFIED'
    | 'BASELINE_RAISED'
    | 'NO_BASELINE_REDUCTION'
  message: string
  file?: string
}

export interface MicroPrVerifyResult {
  ok: boolean
  summary: {
    touchedFiles: number
    nonBaselineFiles: number
    added: number
    deleted: number
    netLoc: number
    absNetLoc: number
    totalChurn: number
    prefersNetReduction: boolean
    minBaselineDelta: number
    totalBaselineDelta: number
  }
  violations: MicroPrViolation[]
}

function isBaselineFile(relPath: string): boolean {
  return (BASELINE_FILES as readonly string[]).includes(relPath)
}

function isProtectedGateFile(relPath: string): boolean {
  return PROTECTED_GATE_PATTERNS.some((re) => re.test(relPath))
}

function isTestFile(relPath: string): boolean {
  return (
    /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(relPath) ||
    /(?:^|\/)(?:__tests__|__smoke__|browser-tests)\//.test(relPath)
  )
}

const ASSERTION_LINE_RE =
  /\b(?:assert\.[A-Za-z_]+|expect\s*\(|\.rejects\b|\.throws\b|test\.skip\b|it\.skip\b|describe\.skip\b|test\.only\b|it\.only\b|test\.todo\b)/

function modifiesExistingTestAssertions(stat: FileDiffStat): boolean {
  if (!isTestFile(stat.file)) return false
  if (stat.status === 'D') return true
  if (stat.status === 'A') {
    return (stat.patchLines ?? []).some(
      (line) =>
        line.startsWith('+') &&
        /\b(?:test|it|describe)\.(?:skip|only|todo)\b/.test(line.slice(1)),
    )
  }
  for (const line of stat.patchLines ?? []) {
    if (!line.startsWith('-') && !line.startsWith('+')) continue
    const content = line.slice(1).trim()
    if (!content || content.startsWith('//') || content.startsWith('*')) continue
    if (line.startsWith('-') && ASSERTION_LINE_RE.test(content)) return true
    if (line.startsWith('+') && /\b(?:test|it|describe)\.(?:skip|only|todo)\b/.test(content)) {
      return true
    }
  }
  return false
}

const MECHANICAL_IMPORT_LINE_RE =
  /^\s*(?:import\b[^=]*|\}\s*from\s+['"][^'"]+['"];?|[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?,?)\s*$/
const MECHANICAL_DELETE_LINE_RE =
  /^\s*(?:import\b.*|(?:export\s+)?(?:async\s+)?function\s+(?:sha256Hex|asRecord|isRecord|errMsg|sleep|atomicWriteJson|readBoundedJson|sendJson)\b.*|(?:export\s+)?const\s+(?:sha256Hex|asRecord|isRecord|errMsg|sleep)\s*=.*|return\b.*|if\s*\(.*|\}|\}\)|[A-Za-z_$][\w$]*,?)\s*$/

export function isMechanicalWheelCallsiteDiff(stat: FileDiffStat): boolean {
  if (isBaselineFile(stat.file) || isTestFile(stat.file)) return true
  if (stat.file.startsWith('packages/kernel/src/')) return true
  if (stat.added > 10 || stat.deleted > 40) return false
  if (!stat.patchLines || stat.patchLines.length === 0) return stat.added <= 4 && stat.deleted <= 25
  for (const line of stat.patchLines) {
    const body = line.slice(1).trim()
    if (!body || body.startsWith('//') || body.startsWith('*')) continue
    if (line.startsWith('+')) {
      if (!MECHANICAL_IMPORT_LINE_RE.test(body)) return false
    } else if (line.startsWith('-')) {
      if (!MECHANICAL_DELETE_LINE_RE.test(body)) return false
    }
  }
  return true
}

function checkCodeSizeAndFileBounds(
  input: MicroPrVerifyInput,
  codeFiles: FileDiffStat[],
  violations: MicroPrViolation[],
): { added: number; deleted: number; netLoc: number; absNetLoc: number; totalChurn: number } {
  const maxTotalChurn = input.maxTotalChurn ?? MAX_TOTAL_CHURN
  let added = 0
  let deleted = 0
  for (const f of codeFiles) {
    added += f.added
    deleted += f.deleted
  }
  const netLoc = added - deleted
  const absNetLoc = Math.abs(netLoc)
  const totalChurn = added + deleted

  if (netLoc > MAX_NET_LOC || added > MAX_NET_LOC) {
    violations.push({
      code: 'NET_LOC_EXCEEDED',
      message: `Gardening PR netLoc=${netLoc} (added=${added}, deleted=${deleted}) exceeds max ${MAX_NET_LOC} lines.`,
    })
  }
  if (absNetLoc > MAX_ABS_NET_LOC && netLoc > 0) {
    violations.push({
      code: 'ABS_DELTA_EXCEEDED',
      message: `abs(added - deleted)=${absNetLoc} exceeds ${MAX_ABS_NET_LOC}.`,
    })
  }
  if (totalChurn > maxTotalChurn) {
    violations.push({
      code: 'TOTAL_CHURN_EXCEEDED',
      message: `Total code churn (added + deleted = ${totalChurn}) exceeds ${maxTotalChurn}; split into smaller strangler PRs.`,
    })
  }

  const isWheel = input.category === 'wheel-consolidation'
  const fileCap = isWheel ? MAX_WHEEL_CONSOLIDATION_FILES : MAX_STANDARD_FILES
  if (codeFiles.length > fileCap) {
    violations.push({
      code: 'TOUCHED_FILES_EXCEEDED',
      message: `Touched ${codeFiles.length} non-baseline files, exceeding cap of ${fileCap} for category=${input.category ?? 'standard'}.`,
    })
  } else if (isWheel && codeFiles.length > MAX_STANDARD_FILES) {
    for (const f of codeFiles) {
      if (!isMechanicalWheelCallsiteDiff(f)) {
        violations.push({
          code: 'NON_MECHANICAL_WHEEL_EDIT',
          file: f.file,
          message: `File ${f.file} exceeds 5-file cap under wheel-consolidation with non-mechanical edits (+${f.added}/-${f.deleted}).`,
        })
      }
    }
  }
  return { added, deleted, netLoc, absNetLoc, totalChurn }
}

/** Pure deterministic verifier used by CLI and unit tests. */
export function verifyMicroPrBounds(input: MicroPrVerifyInput): MicroPrVerifyResult {
  const violations: MicroPrViolation[] = []
  if (input.files.length === 0) {
    violations.push({
      code: 'EMPTY_DIFF',
      message: 'Gardening micro-PR contains zero changed files.',
    })
  }

  const codeFiles = input.files.filter((f) => !isBaselineFile(f.file))
  const sizeStats = checkCodeSizeAndFileBounds(input, codeFiles, violations)

  for (const f of input.files) {
    if (isProtectedGateFile(f.file)) {
      violations.push({
        code: 'PROTECTED_GATE_TOUCHED',
        file: f.file,
        message: `Gardening micro-PR is forbidden from modifying gate/A0 file: ${f.file}`,
      })
    }
    if (modifiesExistingTestAssertions(f)) {
      violations.push({
        code: 'TEST_ASSERTION_MODIFIED',
        file: f.file,
        message: `Gardening micro-PR must not delete/weaken test assertions or add .skip/.only in ${f.file}`,
      })
    }
  }

  let minBaselineDelta = 0
  let totalBaselineDelta = 0
  for (const b of input.baselineDeltas) {
    totalBaselineDelta += b.delta
    if (b.delta < minBaselineDelta) minBaselineDelta = b.delta
    if (b.delta > 0 || b.raisedKeys.length > 0) {
      violations.push({
        code: 'BASELINE_RAISED',
        file: b.file,
        message: `Baseline ${b.file} increased (delta=${b.delta}, raisedKeys=${b.raisedKeys.slice(0, 5).join(', ') || 'total'})`,
      })
    }
  }
  if (minBaselineDelta >= 0) {
    violations.push({
      code: 'NO_BASELINE_REDUCTION',
      message: `At least one governance baseline must strictly decrease (baselineDelta < 0), got minDelta=${minBaselineDelta}.`,
    })
  }

  return {
    ok: violations.length === 0,
    summary: {
      touchedFiles: input.files.length,
      nonBaselineFiles: codeFiles.length,
      ...sizeStats,
      prefersNetReduction: sizeStats.netLoc <= 0,
      minBaselineDelta,
      totalBaselineDelta,
    },
    violations,
  }
}

function flattenBaselineNumbers(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const obj = asRecord(raw)
  if (!obj) return out

  const walkObj = (prefix: string, cur: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(cur)) {
      if (
        k === 'schema' ||
        k === 'schemaVersion' ||
        k === 'note' ||
        k === 'generatedAt' ||
        k === 'limit' ||
        k === 'yellowZoneLimit'
      ) {
        continue
      }
      const key = prefix ? `${prefix}.${k}` : k
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
      else if (Array.isArray(v)) out[`${key}#len`] = v.length
      else if (isRecord(v)) walkObj(key, v)
    }
  }
  walkObj('', obj)
  return out
}

export function diffBaselineJson(
  file: string,
  baseRaw: unknown,
  headRaw: unknown,
): BaselineDeltaRecord {
  const baseMap = flattenBaselineNumbers(baseRaw)
  const headMap = flattenBaselineNumbers(headRaw)
  const baseTotal = Object.values(baseMap).reduce((a, b) => a + b, 0)
  const headTotal = Object.values(headMap).reduce((a, b) => a + b, 0)
  const raisedKeys: string[] = []
  for (const [k, hv] of Object.entries(headMap)) {
    const bv = baseMap[k] ?? 0
    if (hv > bv) raisedKeys.push(`${k}(${bv}->${hv})`)
  }
  return { file, baseTotal, headTotal, delta: headTotal - baseTotal, raisedKeys }
}

async function gitShowJson(root: string, rev: string, relFile: string): Promise<unknown | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${rev}:${relFile}`], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    })
    return JSON.parse(stdout) as unknown
  } catch (err: unknown) {
    void err
    return null
  }
}

async function collectGitDiffInput(
  root: string,
  baseRef: string,
  headRef: string,
  category?: DebtCategory,
): Promise<MicroPrVerifyInput> {
  const range = `${baseRef}...${headRef}`
  const [{ stdout: nameStatusOut }, { stdout: numstatOut }, { stdout: patchOut }] =
    await Promise.all([
      execFileAsync('git', ['diff', '--name-status', '-M', range], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      }),
      execFileAsync('git', ['diff', '--numstat', '-M', range], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      }),
      execFileAsync('git', ['diff', '--unified=0', '-M', range], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      }),
    ])

  const statusByFile = new Map<string, 'A' | 'M' | 'D' | 'R'>()
  for (const line of nameStatusOut.split('\n')) {
    const parts = line.trim().split('\t')
    const code = parts[0]?.[0]
    const file = code === 'R' ? parts[2] : parts[1]
    if (!file) continue
    statusByFile.set(file, code === 'A' || code === 'D' || code === 'R' ? code : 'M')
  }

  const patchByFile = new Map<string, string[]>()
  let curPatchFile: string | null = null
  for (const line of patchOut.split('\n')) {
    if (line.startsWith('+++ b/')) {
      curPatchFile = line.slice('+++ b/'.length).trim()
      if (!patchByFile.has(curPatchFile)) patchByFile.set(curPatchFile, [])
    } else if (
      curPatchFile &&
      (line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++') &&
      !line.startsWith('---')
    ) {
      patchByFile.get(curPatchFile)!.push(line)
    }
  }

  const files: FileDiffStat[] = []
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue
    const [addStr, delStr, rawPath] = line.split('\t')
    if (!rawPath) continue
    const file = rawPath.includes('=>')
      ? rawPath.replace(/.*\{[^}]*=>\s*([^}]*)\}/, '$1').replace(/.*=>\s*/, '').trim()
      : rawPath.trim()
    files.push({
      file,
      status: statusByFile.get(file) ?? 'M',
      added: Number.parseInt(addStr ?? '0', 10) || 0,
      deleted: Number.parseInt(delStr ?? '0', 10) || 0,
      patchLines: patchByFile.get(file) ?? [],
    })
  }

  const baselineDeltas: BaselineDeltaRecord[] = []
  for (const bf of BASELINE_FILES) {
    if (!files.some((f) => f.file === bf)) continue
    const [baseJson, headJson] = await Promise.all([
      gitShowJson(root, baseRef, bf),
      gitShowJson(root, headRef, bf),
    ])
    if (baseJson !== null && headJson !== null) {
      baselineDeltas.push(diffBaselineJson(bf, baseJson, headJson))
    }
  }
  return { category, files, baselineDeltas }
}

function readFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  return idx >= 0 ? argv[idx + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const root = path.resolve(readFlag(argv, '--root') ?? defaultRoot)
  const baseRef = readFlag(argv, '--base') ?? 'origin/feat/v5-selfhost'
  const headRef = readFlag(argv, '--head') ?? 'HEAD'
  const category = readFlag(argv, '--category') as DebtCategory | undefined
  const jsonOut = argv.includes('--json')

  const input = await collectGitDiffInput(root, baseRef, headRef, category)
  const result = verifyMicroPrBounds(input)

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.ok) {
    console.log(
      `[micro-pr-bounds] PASS files=${result.summary.nonBaselineFiles} (+${result.summary.added}/-${result.summary.deleted}, net=${result.summary.netLoc}) minBaselineDelta=${result.summary.minBaselineDelta}`,
    )
  } else {
    console.error(
      `[micro-pr-bounds] FAIL (${result.violations.length} violation(s)) files=${result.summary.nonBaselineFiles} net=${result.summary.netLoc}`,
    )
    for (const v of result.violations) console.error(`  - [${v.code}] ${v.message}`)
  }
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[micro-pr-bounds] fatal: ${errMsg(err)}`)
    process.exit(2)
  })
}
