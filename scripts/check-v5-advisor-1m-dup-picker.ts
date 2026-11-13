#!/usr/bin/env tsx
/**
 * Deploy-gate for INC-20260915-ADVISOR-1M-DUP-PICKER.
 * Locks: the advisor picker never lists Codex 1M twins next to their standard
 * twin (identical display name, indistinguishable catalog id), and a 1M id that
 * still arrives from an older client is canonicalized onto the standard id
 * instead of being rejected.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const advisor = readFileSync(join(root, 'packages/gateway/src/advisorMode.ts'), 'utf8')

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[advisor-1m-dup-picker] ${msg}`)
}

must(
  advisor.includes('export function advisorCanonicalModelId'),
  'advisorCanonicalModelId must exist to fold 1M twins onto the standard id',
)
must(
  /advisorCanonicalModelId[\s\S]{0,400}isCodexLongContextModel\(requested\)[\s\S]{0,200}contextFamilyByModelId\(requested\)\?\.standardId/.test(
    advisor,
  ),
  'advisorCanonicalModelId must resolve 1M ids through contextFamilyByModelId().standardId',
)
must(
  /assertAdvisorModelAllowed[\s\S]{0,600}const requested = advisorCanonicalModelId\(input\.requested\)/.test(advisor),
  'assertAdvisorModelAllowed must canonicalize before the allow-list check',
)
must(
  /listProvenAdvisorModels[\s\S]{0,1200}if \(isCodexLongContextModel\(row\.modelId\)\) continue/.test(advisor),
  'listProvenAdvisorModels must skip Codex 1M twins so the picker has no duplicate labels',
)

// assertion: listProvenAdvisorModels skips Codex 1M twins and assertAdvisorModelAllowed canonicalizes via advisorCanonicalModelId
console.log(
  '[advisor-1m-dup-picker] PASS — INC-20260915-ADVISOR-1M-DUP-PICKER: advisor picker hides Codex 1M twins and canonicalizes 1M requests onto the standard id',
)
