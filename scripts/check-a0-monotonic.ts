/**
 * A0 / A1 Monotonic Separation Referee (OCV5-904).
 *
 * Mechanically classifies repository diffs into:
 *   - A1 (auto-pass): adding new gate scripts, tightening thresholds/limits/slack,
 *     splitting `arch/modules.json` modules without adding `allow` edges or authorities,
 *     monotonically reducing baselines, or updating declarative `deploy/v5/runtime-image-pin.json`.
 *   - A0 (hard-block, exit 1): deleting or modifying existing gate scripts, loosening any
 *     threshold/limit/slack/budget, adding or renewing `file-size-ratchet-exceptions.json`,
 *     adding `allow` edges or authorities in `arch/modules.json`, raising any baseline,
 *     or modifying A0 meta-layer paths (including this referee & `arch/a0-protected-paths.json`),
 *     UNLESS a valid host root-signed A0 approval receipt is present at
 *     `/opt/openclaude/harness-gate/control/a0-approvals/<head_sha>.json`
 *     (or `$OC_A0_APPROVAL_DIR/<head_sha>.json` in isolated test environments).
 *
 * Usage:
 *   npx tsx scripts/check-a0-monotonic.ts [--root <repo>] [--base <git-ref>] [--head <git-ref>]
 *                                         [--staged] [--json] [--approval-dir <dir>]
 *                                         [--require-root-owner]
 *
 * Exit: 0 pass (no A0 block or valid A0 receipt), 1 A0 hard-blocked, 2 usage/git/policy error.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type A0Finding,
  type ApprovalVerification,
  evaluateFileSizeBaselineChange,
  evaluateFileSizeExceptionsChange,
  evaluateModulesJsonChange,
  evaluateRuntimeImagePinChange,
  evaluateShrinkOnlyJsonChange,
  isPlainObject,
  matchesAnyGlob,
  verifyA0ApprovalReceipt,
} from './lib/a0MonotonicRules.js'

export const POLICY_PATH = 'arch/a0-protected-paths.json'
export const DEFAULT_HOST_APPROVAL_DIR = '/opt/openclaude/harness-gate/control/a0-approvals'

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

export interface CheckA0Result {
  ok: boolean
  mode: 'base' | 'staged'
  targetSha: string
  changedFiles: number
  a1Passes: A0Finding[]
  a0Blocks: A0Finding[]
  approval?: ApprovalVerification
}

export function parsePolicy(raw: unknown): A0Policy {
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.a0Categories) || !isPlainObject(raw.a1MonotonicSurfaces)) {
    throw new Error(`${POLICY_PATH} must have schemaVersion=1, a0Categories[], and a1MonotonicSurfaces`)
  }
  return raw as unknown as A0Policy
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
}

function gitFileAt(root: string, ref: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  return r.stdout
}

function gitStagedFile(root: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  return r.stdout
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

function findA0PathCategory(filePath: string, policy: A0Policy): A0Category | null {
  for (const cat of policy.a0Categories) {
    if (cat.paths && matchesAnyGlob(filePath, cat.paths)) return cat
  }
  return null
}

function findGateGlobs(policy: A0Policy): string[] {
  const globs = new Set<string>(policy.a1MonotonicSurfaces.newGateGlobs)
  for (const cat of policy.a0Categories) {
    for (const g of cat.gateGlobs ?? []) globs.add(g)
  }
  return [...globs]
}

export function classifyDiffEntry(
  entry: DiffEntry,
  policy: A0Policy,
  readBase: (p: string) => string | null,
  readHead: (p: string) => string | null,
): A0Finding[] {
  const s = policy.a1MonotonicSurfaces
  const p = entry.path
  const gateGlobs = findGateGlobs(policy)

  // Check if a rename moved an A0-protected path or gate script away from its protected location
  if (entry.status === 'R' && entry.oldPath) {
    const oldA0 = findA0PathCategory(entry.oldPath, policy)
    if (oldA0) {
      return [
        {
          path: entry.oldPath,
          tier: 'A0',
          category: oldA0.id,
          rule: 'A0-PROTECTED-RENAMED',
          detail: `A0 protected path "${entry.oldPath}" renamed to "${p}" (${oldA0.id})`,
        },
      ]
    }
    if (matchesAnyGlob(entry.oldPath, gateGlobs)) {
      return [
        {
          path: entry.oldPath,
          tier: 'A0',
          category: 'existing-gate-deletion-or-modification',
          rule: 'A0-GATE-RENAMED',
          detail: `existing gate "${entry.oldPath}" renamed to "${p}"`,
        },
      ]
    }
  }

  // 1. Direct A0 protected categories (always A0 regardless of add/modify/delete)
  const a0Cat = findA0PathCategory(p, policy)
  if (a0Cat) {
    return [
      {
        path: p,
        tier: 'A0',
        category: a0Cat.id,
        rule: entry.status === 'D' ? 'A0-PROTECTED-DELETED' : 'A0-PROTECTED-MODIFIED',
        detail: `${a0Cat.id}: ${entry.status === 'D' ? 'deleted' : 'modified'} protected A0 path "${p}"`,
      },
    ]
  }

  // 2. Gate scripts (`scripts/check-*.ts`, `scripts/check-*.sh`, `lint-*.ts`):
  //    Brand-new gate (status A) -> A1 auto-pass; modifying/deleting existing gate -> A0 hard-block!
  if (matchesAnyGlob(p, gateGlobs)) {
    if (entry.status === 'A') {
      return [
        {
          path: p,
          tier: 'A1',
          rule: 'A1-NEW-GATE-ADDED',
          detail: `added new gate script "${p}"`,
        },
      ]
    }
    return [
      {
        path: p,
        tier: 'A0',
        category: 'existing-gate-deletion-or-modification',
        rule: entry.status === 'D' ? 'A0-GATE-DELETED' : 'A0-GATE-MODIFIED',
        detail: `${entry.status === 'D' ? 'deleted' : 'modified'} existing gate script "${p}"`,
      },
    ]
  }

  // 3. Declarative runtime image pin -> schema + supply-chain validated A1 auto-pass
  if (s.declarativePins.includes(p)) {
    return evaluateRuntimeImagePinChange(p, entry.status === 'D' ? null : readHead(p))
  }

  // 4. Architecture module map (`arch/modules.json`) -> semantic split/allow/authority check
  if (p === s.moduleMap) {
    return evaluateModulesJsonChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
    )
  }

  // 5. File-size baseline & exceptions
  if (p === s.fileSizeBaseline) {
    return evaluateFileSizeBaselineChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
    )
  }
  if (p === s.fileSizeExceptions) {
    return evaluateFileSizeExceptionsChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
    )
  }

  // 6. Exemptions & budgets & monotonic baselines
  if (p === s.designTokensExempt) {
    return evaluateShrinkOnlyJsonChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
      { allowDelete: true, mode: 'exemptList' },
    )
  }
  if (p === s.budgets) {
    return evaluateShrinkOnlyJsonChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
      { mode: 'budgets' },
    )
  }
  if (p === s.contextEvalBaseline) {
    return evaluateShrinkOnlyJsonChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
      { mode: 'contextEval' },
    )
  }
  if (p === s.featureFlagsRegistry) {
    return evaluateShrinkOnlyJsonChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
      { mode: 'featureFlags' },
    )
  }
  if (
    p === s.aiSmellsBaseline ||
    p === s.violationsBaseline ||
    s.countRatchetBaselines.includes(p) ||
    s.shrinkOnlyBaselines.includes(p)
  ) {
    return evaluateShrinkOnlyJsonChange(
      p,
      entry.status === 'A' ? null : readBase(p),
      entry.status === 'D' ? null : readHead(p),
      { mode: 'counts' },
    )
  }

  // Non-governance application code: passes neutrally
  return []
}

export function runCheckA0Monotonic(opts: {
  root: string
  base?: string
  head?: string
  staged?: boolean
  approvalDir?: string
  requireRootOwner?: boolean
  nowMs?: number
}): CheckA0Result {
  const mode: 'base' | 'staged' = opts.staged ? 'staged' : 'base'
  const headRef = opts.head || 'HEAD'

  // Always prefer base's policy when present so a candidate cannot weaken arch/a0-protected-paths.json
  // to hide its own A0 changes! Fall back to working tree only on initial introduction.
  const baseRefForPolicy = opts.staged ? 'HEAD' : opts.base
  const basePolicyText = baseRefForPolicy ? gitFileAt(opts.root, baseRefForPolicy, POLICY_PATH) : null
  const localPolicyAbs = path.join(opts.root, POLICY_PATH)
  const policyText =
    basePolicyText ??
    (opts.staged ? gitStagedFile(opts.root, POLICY_PATH) : gitFileAt(opts.root, headRef, POLICY_PATH)) ??
    (existsSync(localPolicyAbs) ? readFileSync(localPolicyAbs, 'utf8') : null)
  if (!policyText) {
    throw new Error(`missing ${POLICY_PATH}`)
  }
  const policy = parsePolicy(JSON.parse(policyText))

  let diffEntries: DiffEntry[]
  let targetSha: string
  let readBase: (p: string) => string | null
  let readHead: (p: string) => string | null

  if (mode === 'staged') {
    const raw = git(opts.root, ['diff', '--cached', '--name-status', '-z', '-M'])
    diffEntries = parseNameStatusZ(raw)
    // Use staged tree SHA (never HEAD SHA) so a staged tamper cannot reuse HEAD's A0 receipt
    targetSha = git(opts.root, ['write-tree']).trim()
    readBase = (p) => gitFileAt(opts.root, 'HEAD', p)
    readHead = (p) => gitStagedFile(opts.root, p)
  } else {
    const baseRef = opts.base
    if (!baseRef) {
      throw new Error('base ref required when --staged is not set')
    }
    git(opts.root, ['rev-parse', '--verify', `${baseRef}^{commit}`])
    targetSha = git(opts.root, ['rev-parse', '--verify', `${headRef}^{commit}`]).trim()
    const raw = git(opts.root, ['diff', '--name-status', '-z', '-M', `${baseRef}...${headRef}`])
    diffEntries = parseNameStatusZ(raw)
    readBase = (p) => gitFileAt(opts.root, baseRef, p)
    readHead = (p) => gitFileAt(opts.root, headRef, p)
  }

  const a1Passes: A0Finding[] = []
  const a0Blocks: A0Finding[] = []
  for (const entry of diffEntries) {
    const findings = classifyDiffEntry(entry, policy, readBase, readHead)
    for (const f of findings) {
      if (f.tier === 'A0') a0Blocks.push(f)
      else a1Passes.push(f)
    }
  }

  if (a0Blocks.length === 0) {
    return {
      ok: true,
      mode,
      targetSha,
      changedFiles: diffEntries.length,
      a1Passes,
      a0Blocks,
    }
  }

  const envDir = process.env[policy.approvalDefaults?.envApprovalDir ?? 'OC_A0_APPROVAL_DIR']
  const hostDir = policy.approvalDefaults?.hostApprovalDir ?? DEFAULT_HOST_APPROVAL_DIR
  const approvalDir = opts.approvalDir ?? (envDir?.trim() ? envDir.trim() : hostDir)
  const requireRootOwner =
    opts.requireRootOwner ?? (approvalDir === hostDir && !envDir?.trim())

  const approval = verifyA0ApprovalReceipt({
    approvalDir,
    targetSha,
    a0Paths: [...new Set(a0Blocks.map((b) => b.path))],
    requireRootOwner,
    nowMs: opts.nowMs,
  })

  return {
    ok: approval.valid,
    mode,
    targetSha,
    changedFiles: diffEntries.length,
    a1Passes,
    a0Blocks,
    approval,
  }
}

function main(argv: string[]): number {
  let root = ''
  let base = ''
  let head = 'HEAD'
  let staged = false
  let asJson = false
  let approvalDir: string | undefined
  let requireRootOwner: boolean | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') root = argv[++i] ?? ''
    else if (arg === '--base') base = argv[++i] ?? ''
    else if (arg === '--head') head = argv[++i] ?? ''
    else if (arg === '--staged') staged = true
    else if (arg === '--json') asJson = true
    else if (arg === '--approval-dir') approvalDir = argv[++i] ?? ''
    else if (arg === '--require-root-owner') requireRootOwner = true
    else {
      console.error(`unknown arg: ${arg}`)
      return 2
    }
  }

  let repoRoot: string
  try {
    repoRoot = root
      ? path.resolve(root)
      : git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  } catch (err) {
    console.error(`[check-a0-monotonic] git root error: ${(err as Error).message}`)
    return 2
  }

  if (!staged && !base) {
    // Default to HEAD~1 if available, otherwise HEAD (zero diff)
    const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'origin/feat/v5-selfhost^{commit}'], {
      encoding: 'utf8',
    })
    if (r.status === 0) base = 'origin/feat/v5-selfhost'
    else base = 'HEAD'
  }

  let result: CheckA0Result
  try {
    result = runCheckA0Monotonic({
      root: repoRoot,
      base: staged ? undefined : base,
      head,
      staged,
      approvalDir,
      requireRootOwner,
    })
  } catch (err) {
    console.error(`[check-a0-monotonic] error: ${(err as Error).message}`)
    return 2
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }

  for (const pass of result.a1Passes) {
    console.log(`[A1-PASS] ${pass.rule} ${pass.path}: ${pass.detail}`)
  }

  if (result.a0Blocks.length > 0 && result.ok && result.approval?.valid) {
    console.log(
      `[A0-APPROVED] ${result.a0Blocks.length} A0 change(s) authorized by ${result.approval.receiptPath} (sha=${result.approval.receipt.sha.slice(0, 12)}, expiresAt=${result.approval.receipt.expiresAt})`,
    )
    return 0
  }

  for (const blk of result.a0Blocks) {
    console.log(`::error file=${blk.path}::[A0-BLOCK] ${blk.rule}: ${blk.detail}`)
    console.error(
      [
        `[GATE-ERROR] A0-MONOTONIC (${blk.rule}) at ${blk.path}`,
        `  Violation : ${blk.detail}`,
        '  Why       : A0 meta-layer guardrails and baseline ceilings cannot be loosened or tampered with autonomously.',
        `  How to Fix: Keep changes strictly A1 (monotonic tighten-only), or obtain a host root-signed A0 approval receipt via \`oc-governor approve-a0 --sha ${result.targetSha} --reason "..."\`.`,
        `  Receipt   : ${result.approval ? `${result.approval.receiptPath} (${result.approval.reason})` : 'none'}`,
      ].join('\n'),
    )
  }

  console.log(
    `a0-monotonic (${result.mode}, sha=${result.targetSha.slice(0, 12)}): ${result.changedFiles} changed, ${result.a1Passes.length} A1 auto-pass, ${result.a0Blocks.length} A0 blocked -> ${result.ok ? 'PASS' : 'BLOCK'}`,
  )
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
