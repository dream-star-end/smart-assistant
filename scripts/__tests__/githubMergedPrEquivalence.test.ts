/**
 * OCV5-912: Fail-closed Merged-PR Equivalence Proof, Squash/Rebase Carry-Over,
 * Multi-PR Coalesced Release-Train Decomposition & Host Train GitHub Context Tests.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCheckA0MonotonicAsync } from '../check-a0-monotonic.js'
import { runStewardGateAsync } from '../check-cross-family-audit.js'
import { computeA0ReceiptDigest } from '../lib/a0ApprovalReceipt.js'
import {
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  type ArchStewardReceipt,
  signArchStewardReceipt,
} from '../lib/archStewardContract.js'
import {
  type FetchLike,
  type GithubDiffFileEntry,
  resolveMergedPrEquivalence,
  verifyFileDiffListsByteEquivalent,
} from '../lib/githubMergedPrEquivalence.js'
import { verifyGithubA0Approval, verifyGithubStewardStatus } from '../lib/githubTrustedApproval.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GOV_LIB_PATH = path.join(REPO_ROOT, 'scripts/lib/v5-selfhost-governance-gates.sh')
const TEST_REPO = 'dream-star-end/smart-assistant'

const SHA_S = '5fff362001423baf013cd5ec7c7940054bc78ff0'
const SHA_H = '36c87bd22e573ddbf6c2d9dc6240e1dd94ba53b5'
const SHA_P1 = '2d98452a912970d955295140c99c3d6ff9945ab5'
const TREE_EQ = 'eb25f40a1434b34cc9e33994195dbc36ff8c1d00'
const TREE_OTHER = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee'
const BLOB_A = '1111111111111111111111111111111111111111'
const BLOB_B = '2222222222222222222222222222222222222222'

function makeMockFetch(routes: Record<string, unknown>): FetchLike {
  return async (url) => {
    const pathname = new URL(url).pathname
    const data = routes[pathname]
    if (data === undefined) {
      return { ok: false, status: 404, json: async () => ({ message: 'not found' }) }
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data }
  }
}

function makeStewardReceipt(
  overrides: Partial<Omit<ArchStewardReceipt, 'receiptDigest'>> = {},
): Omit<ArchStewardReceipt, 'receiptDigest'> {
  return {
    schemaVersion: ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
    headSha: SHA_H,
    baseSha: SHA_P1,
    authorModel: 'antigravity-gemini-4-neon',
    authorFamily: 'google-gemini',
    stewardModel: 'gpt-6.2-astra',
    stewardFamily: 'openai-gpt',
    verdict: 'approve',
    triggers: ['CLONE_OR_T2_CORE_PATH'],
    dimensions: {
      godClassAppend: { status: 'pass', notes: 'Clean extraction.' },
      wheelReinvention: { status: 'pass', notes: 'No clones.' },
      boundaryIntegrity: { status: 'pass', notes: 'Clean layers.' },
      complexityDrift: { status: 'pass', notes: 'Within limits.' },
    },
    blockers: [],
    usageEvidence: {
      jobId: 'steward-real-912',
      sessionKey: 'arch-steward:openai-gpt:36c87bd22e57',
      timestamp: '2026-11-27T00:19:00Z',
      provider: 'codex',
    },
    ...overrides,
  }
}

function initTempRepo(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-repo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim()
  const write = (rel: string, content: string) => {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  const commit = (msg: string) => {
    git(['add', '-A'])
    git(['commit', '-qm', msg])
    return git(['rev-parse', 'HEAD'])
  }

  git(['init', '-q', '-b', 'feat/v5-selfhost'])
  write(
    'arch/a0-protected-paths.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        a0Categories: [
          {
            id: 'billing-accounting-core',
            description: 'Billing core',
            paths: ['packages/commercial/src/billing/ledger.ts'],
          },
        ],
        a1MonotonicSurfaces: {
          declarativePins: ['deploy/v5/runtime-image-pin.json'],
          newGateGlobs: ['scripts/check-*.ts'],
          moduleMap: 'arch/modules.json',
          fileSizeBaseline: '.github/file-size-baseline.json',
          fileSizeExceptions: '.github/file-size-ratchet-exceptions.json',
          designTokensExempt: 'packages/web-react/design-tokens-exempt.json',
          aiSmellsBaseline: 'arch/ai-smells-baseline.json',
          violationsBaseline: 'arch/violations-baseline.json',
          budgets: 'packages/web-react/budgets.json',
          contextEvalBaseline: '.github/context-eval-baseline.json',
          featureFlagsRegistry: 'deploy/v5/feature-flags-registry.json',
          countRatchetBaselines: [],
          shrinkOnlyBaselines: [],
        },
      },
      null,
      2,
    ),
  )
  write(
    'arch/modules.json',
    JSON.stringify(
      {
        schema: 1,
        modules: {
          'web-views': { layer: 'F4', match: ['packages/web-react/src/components/**'] },
          'web-hooks': { layer: 'F3', match: ['packages/web-react/src/hooks/**'] },
          'gateway-core': { layer: 'L4', match: ['packages/gateway/src/**'] },
        },
      },
      null,
      2,
    ),
  )
  write('arch/append-magnets.json', JSON.stringify({ schemaVersion: 1, magnets: [] }))
  write('arch/gate-couplings.json', JSON.stringify({ schema: 1, byGate: {} }))
  write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 1\n')
  write('packages/web-react/src/components/Btn.tsx', 'export const Btn = () => "ok"\n')
  write('packages/web-react/src/hooks/useX.ts', 'export const useX = () => 1\n')
  const baseSha = commit('chore(v5): seed base')
  return { dir, env, git, write, commit, baseSha }
}

describe('verifyFileDiffListsByteEquivalent & resolveMergedPrEquivalence (OCV5-912)', () => {
  const sampleFile: GithubDiffFileEntry = {
    filename: 'packages/gateway/src/router.ts',
    status: 'modified',
    sha: BLOB_A,
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: '@@ -1,2 +1,4 @@\n-export const a = 1\n+export const a = 2\n+export const b = 3',
  }

  test('Proof A (exact-tree) and Proof B (exact-squash-diff) pass; 1-byte drift, truncation, unmerged PR, and wrong base fail closed', async () => {
    assert.equal(
      verifyFileDiffListsByteEquivalent([sampleFile], [{ ...sampleFile }]).equivalent,
      true,
    )

    // RED: 1-byte patch drift
    const driftPatch = verifyFileDiffListsByteEquivalent(
      [sampleFile],
      [{ ...sampleFile, patch: `${sampleFile.patch} ` }],
    )
    assert.equal(driftPatch.equivalent, false)

    // RED: 3-way merge blob SHA drift
    const driftBlob = verifyFileDiffListsByteEquivalent(
      [sampleFile],
      [{ ...sampleFile, sha: BLOB_B }],
    )
    assert.equal(driftBlob.equivalent, false)

    // RED: missing patch on modified file (GitHub huge-file omission)
    const noPatch = verifyFileDiffListsByteEquivalent(
      [{ ...sampleFile, patch: undefined }],
      [{ ...sampleFile, patch: undefined }],
    )
    assert.equal(noPatch.equivalent, false)

    // RED: >= 300 file truncation ceiling
    const big = Array.from({ length: 300 }, (_, i) => ({
      ...sampleFile,
      filename: `packages/gateway/src/f${i}.ts`,
    }))
    assert.equal(verifyFileDiffListsByteEquivalent(big, big).equivalent, false)

    // Proof A via resolveMergedPrEquivalence (exact PR #1419 shape)
    const resTree = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: 'feat/v5-selfhost',
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
          {
            number: 1419,
            merged_at: '2026-11-27T00:29:09Z',
            merge_commit_sha: SHA_S,
            base: { ref: 'feat/v5-selfhost', sha: SHA_P1 },
            head: { sha: SHA_H },
          },
        ],
        [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
          sha: SHA_S,
          commit: { tree: { sha: TREE_EQ } },
          parents: [{ sha: SHA_P1 }],
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
          sha: SHA_H,
          commit: { tree: { sha: TREE_EQ } },
        },
      }),
    })
    assert.equal(resTree.candidates.length, 1)
    assert.equal(resTree.candidates[0]!.equivalenceProof, 'exact-tree')
    assert.equal(resTree.candidates[0]!.prNumber, 1419)

    // Proof B: base branch moved (tree differs), single-parent squash with exact file/blob/patch match
    const resDiff = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
          {
            number: 1421,
            merged_at: '2026-11-27T01:00:00Z',
            merge_commit_sha: SHA_S,
            base: { ref: 'feat/v5-selfhost', sha: SHA_P1 },
            head: { sha: SHA_H },
          },
        ],
        [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
          sha: SHA_S,
          commit: { tree: { sha: TREE_OTHER } },
          parents: [{ sha: SHA_P1 }],
          files: [sampleFile],
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
          sha: SHA_H,
          commit: { tree: { sha: TREE_EQ } },
        },
        [`/repos/${TEST_REPO}/pulls/1421/files`]: [sampleFile],
      }),
    })
    assert.equal(resDiff.candidates.length, 1)
    assert.equal(resDiff.candidates[0]!.equivalenceProof, 'exact-squash-diff')

    // RED: unmerged PR or wrong expectedBaseRef
    const resUnmerged = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: 'feat/v5-selfhost',
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
          {
            number: 1422,
            merged_at: null,
            merge_commit_sha: SHA_S,
            base: { ref: 'feat/v5-selfhost' },
            head: { sha: SHA_H },
          },
          {
            number: 1423,
            merged_at: '2026-11-27T01:00:00Z',
            merge_commit_sha: SHA_S,
            base: { ref: 'other-branch' },
            head: { sha: SHA_H },
          },
        ],
      }),
    })
    assert.equal(resUnmerged.candidates.length, 0)
  })
})

describe('GitHub Steward & A0 squash carry-over with Veto/Revocation supremacy (OCV5-912)', () => {
  test('Steward carries over exact-tree approve from PR head to squash SHA, while VETO on S or H blocks', async () => {
    const baseRoutes: Record<string, unknown> = {
      [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
        {
          number: 1419,
          merged_at: '2026-11-27T00:29:09Z',
          merge_commit_sha: SHA_S,
          base: { ref: 'feat/v5-selfhost', sha: SHA_P1 },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
        sha: SHA_S,
        commit: { tree: { sha: TREE_EQ } },
        parents: [{ sha: SHA_P1 }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
        sha: SHA_H,
        commit: { tree: { sha: TREE_EQ } },
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [
        {
          id: 1,
          context: 'oc-v5/arch-steward',
          state: 'success',
          description: `verdict=approve sha=${SHA_H.slice(0, 12)} author=google-gemini steward=openai-gpt digest=hmac-sha256:8d5cc05d5b075f80`,
          creator: { login: 'dream-star-end' },
          created_at: '2026-11-27T00:19:00Z',
        },
      ],
    }

    // GREEN: push/commit mode carries over
    const ok = await verifyGithubStewardStatus({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      fetchImpl: makeMockFetch(baseRoutes),
    })
    assert.equal(ok.valid, true, ok.reason)
    assert.equal(ok.carriedOverFromPr, 1419)
    assert.equal(ok.carriedOverFromSha, SHA_H)
    assert.equal(ok.equivalenceProof, 'exact-tree')

    // RED: allowMergedPrCarryOver=false (PR mode) rejects
    const prMode = await verifyGithubStewardStatus({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      allowMergedPrCarryOver: false,
      fetchImpl: makeMockFetch(baseRoutes),
    })
    assert.equal(prMode.valid, false)

    // RED: VETO on S itself overrides approve on H
    const vetoOnS = await verifyGithubStewardStatus({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      fetchImpl: makeMockFetch({
        ...baseRoutes,
        [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [
          {
            id: 2,
            context: 'oc-v5/arch-steward',
            state: 'failure',
            description: `verdict=veto sha=${SHA_S.slice(0, 12)} author=google-gemini steward=openai-gpt`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-27T00:35:00Z',
          },
        ],
      }),
    })
    assert.equal(vetoOnS.valid, false)
    assert.equal(vetoOnS.verdict, 'veto')

    // RED: VETO on H blocks carry-over
    const vetoOnH = await verifyGithubStewardStatus({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      fetchImpl: makeMockFetch({
        ...baseRoutes,
        [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [
          {
            id: 3,
            context: 'oc-v5/arch-steward',
            state: 'failure',
            description: `verdict=veto sha=${SHA_H.slice(0, 12)} author=google-gemini steward=openai-gpt`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-27T00:25:00Z',
          },
        ],
      }),
    })
    assert.equal(vetoOnH.valid, false)
    assert.equal(vetoOnH.verdict, 'veto')
  })

  test('A0 carries over both oc-v5/a0-approval status and CODEOWNER PR review from H to S; revocation on S or H blocks', async () => {
    const futureExp = new Date(Date.now() + 3_600_000).toISOString()
    const baseRoutes: Record<string, unknown> = {
      [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
        {
          number: 1425,
          merged_at: '2026-11-27T00:40:00Z',
          merge_commit_sha: SHA_S,
          base: { ref: 'feat/v5-selfhost', sha: SHA_P1 },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
        sha: SHA_S,
        commit: { tree: { sha: TREE_EQ } },
        parents: [{ sha: SHA_P1 }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
        sha: SHA_H,
        commit: { tree: { sha: TREE_EQ } },
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [
        {
          id: 10,
          context: 'oc-v5/a0-approval',
          state: 'success',
          description: `sha=${SHA_H.slice(0, 12)} exp=${futureExp} paths=packages/commercial/src/billing/ledger.ts | Approved A0 ledger update`,
          creator: { login: 'dream-star-end' },
          created_at: '2026-11-27T00:35:00Z',
        },
      ],
      [`/repos/${TEST_REPO}/pulls/1425/reviews`]: [],
    }

    // GREEN: status carry-over
    const stOk = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      fetchImpl: makeMockFetch(baseRoutes),
    })
    assert.equal(stOk.valid, true, stOk.reason)
    assert.equal(stOk.carriedOverFromPr, 1425)

    // GREEN: CODEOWNER PR review carry-over when status absent on H
    const revOk = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      fetchImpl: makeMockFetch({
        ...baseRoutes,
        [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [],
        [`/repos/${TEST_REPO}/pulls/1425/reviews`]: [
          {
            id: 99,
            state: 'APPROVED',
            commit_id: SHA_H,
            submitted_at: '2026-11-27T00:36:00Z',
            user: { login: 'dream-star-end' },
          },
        ],
      }),
    })
    assert.equal(revOk.valid, true, revOk.reason)
    assert.equal(revOk.channel, 'github-pr-review')
    assert.equal(revOk.carriedOverFromPr, 1425)

    // RED: narrow paths= on H does not cover A0 path
    const narrow = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      a0Paths: ['scripts/check-a0-monotonic.ts'],
      fetchImpl: makeMockFetch(baseRoutes),
    })
    assert.equal(narrow.valid, false)

    // RED: revocation on S blocks carry-over
    const revOnS = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      fetchImpl: makeMockFetch({
        ...baseRoutes,
        [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [
          {
            id: 11,
            context: 'oc-v5/a0-approval',
            state: 'failure',
            description: `revoked sha=${SHA_S.slice(0, 12)} paths=* | Revoked`,
            creator: { login: 'dream-star-end' },
            created_at: '2026-11-27T00:45:00Z',
          },
        ],
      }),
    })
    assert.equal(revOnS.valid, false)
    assert.equal(revOnS.revoked, true)
  })
})

describe('Multi-PR coalesced release train & local host receipt carry-over (OCV5-912)', () => {
  test('Steward: local host HMAC receipt carries over via merged-PR equivalence, and coalesced 2-PR train passes while split unmerged commit fails closed', async (t) => {
    const repo = initTempRepo(t)
    const receiptDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-steward-'))
    t.after(() => rmSync(receiptDir, { recursive: true, force: true }))
    const hmacKey = 'ocv5-912-test-hmac-secret-0123456789'

    // Commit S1: high-risk T2 gateway edit (PR #1419 head = SHA_H, approved via host HMAC receipt for SHA_H)
    repo.write('packages/gateway/src/execEnv.ts', 'export const execEnv = 1\n')
    const s1 = repo.commit('feat(v5): high-risk gateway change (PR #1419)')
    const s1Tree = repo.git(['rev-parse', `${s1}^{tree}`])

    const hostReceiptForH = signArchStewardReceipt(
      makeStewardReceipt({
        headSha: SHA_H,
        baseSha: repo.baseSha,
        triggers: ['CLONE_OR_T2_CORE_PATH'],
      }),
      hmacKey,
    )
    writeFileSync(path.join(receiptDir, `${SHA_H}.json`), JSON.stringify(hostReceiptForH, null, 2))

    // Commit S2: low-risk web-views edit (PR #1426, different module -> aggregate base..S2 spans 2 modules!)
    repo.write('packages/web-react/src/components/Btn.tsx', 'export const Btn = () => "v2"\n')
    const s2 = repo.commit('ui(v5): tiny button tweak (PR #1426)')

    const routes: Record<string, unknown> = {
      [`/repos/${TEST_REPO}/commits/${s1}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s1}/pulls`]: [
        {
          number: 1419,
          merged_at: '2026-11-27T00:29:09Z',
          merge_commit_sha: s1,
          base: { ref: 'feat/v5-selfhost', sha: repo.baseSha },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${s1}`]: {
        sha: s1,
        commit: { tree: { sha: s1Tree } },
        parents: [{ sha: repo.baseSha }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
        sha: SHA_H,
        commit: { tree: { sha: s1Tree } },
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/pulls`]: [
        {
          number: 1426,
          merged_at: '2026-11-27T00:30:10Z',
          merge_commit_sha: s2,
          base: { ref: 'feat/v5-selfhost', sha: s1 },
          head: { sha: s2 },
        },
      ],
    }

    // 1. Single commit S1 passes via carried-over local host HMAC receipt!
    const rS1 = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: repo.baseSha,
      headRef: s1,
      receiptDirs: [receiptDir],
      requireRootOwner: false,
      hmacKey,
      requireHmac: true,
      github: { repo: TEST_REPO, token: 'ghs_tok', fetchImpl: makeMockFetch(routes) },
    })
    assert.equal(
      rS1.ok,
      true,
      `expected S1 host receipt carry-over pass: ${JSON.stringify(rS1.receiptLookup)}`,
    )

    // 2. Coalesced 2-PR train (base..S2): S1 approved via carry-over + S2 low-risk merged PR -> PASS!
    const rTrain = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: repo.baseSha,
      headRef: s2,
      receiptDirs: [receiptDir],
      requireRootOwner: false,
      hmacKey,
      requireHmac: true,
      github: { repo: TEST_REPO, token: 'ghs_tok', fetchImpl: makeMockFetch(routes) },
    })
    assert.equal(
      rTrain.ok,
      true,
      `expected 2-PR coalesced train pass: ${JSON.stringify(rTrain.receiptLookup)}`,
    )
    assert.match(rTrain.receiptLookup?.source ?? '', /multi-commit-range\(2\)/)

    // 3. RED (anti-split-bypass): if S2 is NOT a merged PR, multi-commit fallback MUST fail closed!
    const rUnmergedS2 = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: repo.baseSha,
      headRef: s2,
      receiptDirs: [receiptDir],
      requireRootOwner: false,
      hmacKey,
      requireHmac: true,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        fetchImpl: makeMockFetch({
          ...routes,
          [`/repos/${TEST_REPO}/commits/${s2}/pulls`]: [],
        }),
      },
    })
    assert.equal(rUnmergedS2.ok, false, 'unmerged commit in multi-commit range must fail closed')
  })

  test('A0: coalesced 2-PR train passes when S1 A0 is approved and S2 is non-A0, but BLOCKS if S2 also touches A0 unapproved', async (t) => {
    const repo = initTempRepo(t)
    const approvalDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-a0-'))
    t.after(() => rmSync(approvalDir, { recursive: true, force: true }))

    // S1 touches A0 billing/ledger.ts and has host receipt on PR head SHA_H
    repo.write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 2\n')
    const s1 = repo.commit('feat(v5): approved A0 ledger edit (PR #201)')
    const s1Tree = repo.git(['rev-parse', `${s1}^{tree}`])

    const issuedAt = new Date(Date.now() - 60_000).toISOString()
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    const reason = 'Approved A0 ledger update for OCV5-912 test'
    writeFileSync(
      path.join(approvalDir, `${SHA_H}.json`),
      JSON.stringify(
        {
          schemaVersion: 1,
          sha: SHA_H,
          reason,
          approvedBy: 'root',
          issuedAt,
          expiresAt,
          allowedPaths: ['packages/commercial/src/billing/ledger.ts'],
          sha256: computeA0ReceiptDigest({
            sha: SHA_H,
            issuedAt,
            expiresAt,
            reason,
            allowedPaths: ['packages/commercial/src/billing/ledger.ts'],
          }),
        },
        null,
        2,
      ),
    )

    // S2 touches non-A0 UI component
    repo.write('packages/web-react/src/components/Btn.tsx', 'export const Btn = () => "v3"\n')
    const s2 = repo.commit('ui(v5): non-A0 follow-up commit')

    const routes: Record<string, unknown> = {
      [`/repos/${TEST_REPO}/commits/${s1}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s1}/pulls`]: [
        {
          number: 201,
          merged_at: '2026-11-27T00:50:00Z',
          merge_commit_sha: s1,
          base: { ref: 'feat/v5-selfhost', sha: repo.baseSha },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${s1}`]: {
        sha: s1,
        commit: { tree: { sha: s1Tree } },
        parents: [{ sha: repo.baseSha }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
        sha: SHA_H,
        commit: { tree: { sha: s1Tree } },
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [],
      [`/repos/${TEST_REPO}/pulls/201/reviews`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/pulls`]: [],
    }

    // GREEN: base..s2 passes (S1 approved via host carry-over, S2 has 0 A0 blocks)
    const rOk = await runCheckA0MonotonicAsync({
      root: repo.dir,
      base: repo.baseSha,
      head: s2,
      approvalDir,
      requireRootOwner: false,
      github: { repo: TEST_REPO, token: 'ghs_tok', fetchImpl: makeMockFetch(routes) },
    })
    assert.equal(rOk.ok, true, `expected A0 2-PR coalesced pass: ${JSON.stringify(rOk.approval)}`)

    // RED: S3 sneaks an UNAPPROVED edit into the SAME A0 file ledger.ts!
    repo.write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 999\n')
    const s3 = repo.commit('feat(v5): sneaky unapproved A0 edit')
    const rSneak = await runCheckA0MonotonicAsync({
      root: repo.dir,
      base: repo.baseSha,
      head: s3,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        fetchImpl: makeMockFetch({
          ...routes,
          [`/repos/${TEST_REPO}/commits/${s3}/statuses`]: [],
          [`/repos/${TEST_REPO}/commits/${s3}/pulls`]: [],
        }),
      },
    })
    assert.equal(
      rSneak.ok,
      false,
      'unapproved follow-up commit touching same A0 file MUST fail closed',
    )
  })

  test('Host release train (v5-selfhost-governance-gates.sh) passes squash-merged A0+Steward commit via wired GITHUB_REPOSITORY/GITHUB_TOKEN', async (t) => {
    const repo = initTempRepo(t)
    const staging = mkdtempSync(path.join(tmpdir(), 'ocv5-912-staging-'))
    const gateTmp = mkdtempSync(path.join(tmpdir(), 'ocv5-912-gtmp-'))
    t.after(() => {
      rmSync(staging, { recursive: true, force: true })
      rmSync(gateTmp, { recursive: true, force: true })
    })

    // Seed minimal stubs for non-Steward/A0 fast gates + real copies of A0 & Steward gates
    for (const rel of [
      'scripts/check-docs-links.ts',
      'scripts/check-ui-hard-gates.ts',
      'scripts/check-v5-route-sync.ts',
      'scripts/check-monotonic-baselines.ts',
      'scripts/check-feature-flags-ttl.ts',
      'scripts/check-schedulers.ts',
      'packages/commercial/scripts/lint-agent-containers-sql.ts',
      'scripts/check-v5-test-retries.ts',
      'scripts/check-integ-tiers.ts',
      'scripts/check-v5-e2e-selectors.ts',
      'scripts/check-context-static.ts',
      'scripts/check-file-size-ratchet.ts',
      'scripts/check-rest-contract-compat.ts',
      'scripts/check-pg-migration-safety.ts',
      'scripts/check-changelog-guard.ts',
      'scripts/check-ai-smells-ratchet.ts',
      'scripts/check-complexity-ratchet.ts',
      'scripts/check-clones-ratchet.ts',
      'scripts/check-security-sast.ts',
      'scripts/check-debt-ttl.ts',
    ]) {
      repo.write(rel, 'process.exit(0)\n')
    }
    repo.write('scripts/check-biome-changed.sh', '#!/usr/bin/env bash\nexit 0\n')
    repo.write(
      'scripts/check-no-silent-model-downgrade.ts',
      'export const WEAK_MODEL_SLUG_RE = /(?:flash-lite|mini|haiku|nano)/i\n',
    )
    repo.write(
      'scripts/check-gate-couplings.ts',
      'export const isGate = () => false\nexport const rawNames = () => []\n',
    )
    repo.write(
      'packages/protocol/src/boxApiModels.ts',
      'export const BOX_API_MODELS = [] as const\n',
    )
    repo.write(
      'packages/protocol/src/engineModels.ts',
      'export const ANTIGRAVITY_ENGINE_MODELS = [] as const\nexport const CODEX_ENGINE_MODELS = [] as const\nexport const CURSOR_ENGINE_MODELS = [] as const\nexport const GROK_ENGINE_MODELS = [] as const\nexport const ZCODE_ENGINE_MODELS = [] as const\n',
    )
    repo.write('changelog.json', '[]\n')
    for (const rel of [
      'scripts/check-a0-monotonic.ts',
      'scripts/check-cross-family-audit.ts',
      'scripts/lib/a0MonotonicRules.ts',
      'scripts/lib/a0ApprovalReceipt.ts',
      'scripts/lib/archStewardContract.ts',
      'scripts/lib/archStewardGitDiff.ts',
      'scripts/lib/archStewardReceipt.ts',
      'scripts/lib/archStewardTypes.ts',
      'scripts/lib/commitRangeCarryOver.ts',
      'scripts/lib/githubMergedPrEquivalence.ts',
      'scripts/lib/githubTrustedApproval.ts',
      'scripts/lib/modelFamilyClassifier.ts',
      'scripts/lib/runtimeImagePin.ts',
    ]) {
      const dst = path.join(repo.dir, rel)
      mkdirSync(path.dirname(dst), { recursive: true })
      cpSync(path.join(REPO_ROOT, rel), dst)
    }
    const baseSha = repo.commit('chore(v5): seed real A0 + Steward gates')

    // Squash commit modifying T2 + A0 billing/ledger.ts
    repo.write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 42\n')
    const squashSha = repo.commit('feat(v5): squash-merged T2+A0 change (#1499)')
    const squashTree = repo.git(['rev-parse', `${squashSha}^{tree}`])

    execFileSync(
      'bash',
      [
        '-euo',
        'pipefail',
        '-c',
        `git -C '${repo.dir}' archive --format=tar '${squashSha}' | tar -x -C '${staging}'`,
      ],
      { env: repo.env },
    )
    assert.equal(existsSync(path.join(staging, '.git')), false)
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(staging, 'node_modules'))

    const futureExp = new Date(Date.now() + 3_600_000).toISOString()
    let allowCarry = true
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Connection', 'close')
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      if (pathname === `/repos/${TEST_REPO}/commits/${squashSha}/pulls`) {
        res.end(
          JSON.stringify(
            allowCarry
              ? [
                  {
                    number: 1499,
                    merged_at: '2026-11-27T01:00:00Z',
                    merge_commit_sha: squashSha,
                    base: { ref: 'feat/v5-selfhost', sha: baseSha },
                    head: { sha: SHA_H },
                  },
                ]
              : [],
          ),
        )
        return
      }
      if (pathname === `/repos/${TEST_REPO}/commits/${squashSha}`) {
        res.end(
          JSON.stringify({
            sha: squashSha,
            commit: { tree: { sha: squashTree } },
            parents: [{ sha: baseSha }],
          }),
        )
        return
      }
      if (pathname === `/repos/${TEST_REPO}/commits/${SHA_H}`) {
        res.end(JSON.stringify({ sha: SHA_H, commit: { tree: { sha: squashTree } } }))
        return
      }
      if (pathname === `/repos/${TEST_REPO}/commits/${SHA_H}/statuses`) {
        res.end(
          JSON.stringify([
            {
              id: 1,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${SHA_H.slice(0, 12)} exp=${futureExp} paths=packages/commercial/src/billing/ledger.ts | Approved squash A0`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-27T00:55:00Z',
            },
            {
              id: 2,
              context: 'oc-v5/arch-steward',
              state: 'success',
              description: `verdict=approve sha=${SHA_H.slice(0, 12)} author=google-gemini steward=openai-gpt digest=hmac-sha256:0123456789abcdef`,
              creator: { login: 'dream-star-end' },
              created_at: '2026-11-27T00:56:00Z',
            },
          ]),
        )
        return
      }
      res.end('[]')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const runTrain = () =>
        new Promise<{ status: number | null; out: string }>((resolve) => {
          const child = spawn(
            'bash',
            [
              '-Eeu',
              '-o',
              'pipefail',
              '-c',
              [
                'mlog() { echo "$*" >&2; }',
                'tsum_note() { :; }',
                `source '${GOV_LIB_PATH}'`,
                `REPO_ROOT='${repo.dir}'; MASTER_LIVE_LINK='${path.join(repo.dir, 'no-live')}'; OC_V5_REFEREE_ROOT='${path.join(repo.dir, 'no-referee')}'; MASTER_GATE_TMPDIR='${gateTmp}'; OC_V5_GOVERNANCE_BASE_REF='${baseSha}'; master_run_governance_fast_gates '${staging}' '${squashSha}'`,
              ].join('\n'),
            ],
            {
              env: {
                ...repo.env,
                GITHUB_REPOSITORY: TEST_REPO,
                GITHUB_TOKEN: 'ghs_mock_train_token',
                GITHUB_API_URL: `http://127.0.0.1:${port}`,
                OC_GOVERNOR_ROOT: path.join(gateTmp, 'empty-gov'),
              },
            },
          )
          let out = ''
          child.stdout.on('data', (d) => {
            out += String(d)
          })
          child.stderr.on('data', (d) => {
            out += String(d)
          })
          child.on('close', (status) => resolve({ status, out }))
        })

      // GREEN: host release train passes both A0 and Steward via GitHub squash carry-over!
      const rPass = await runTrain()
      assert.equal(rPass.status, 0, `expected host train squash carry-over PASS:\n${rPass.out}`)

      // RED: without merged-PR carry-over, host release train fails closed!
      allowCarry = false
      const rFail = await runTrain()
      assert.notEqual(
        rFail.status,
        0,
        'expected host train to fail closed without squash carry-over',
      )
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
