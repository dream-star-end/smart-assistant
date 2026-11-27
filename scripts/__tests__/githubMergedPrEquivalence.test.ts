/**
 * OCV5-912: Fail-closed Merged-PR Equivalence Proof, Squash/Rebase Carry-Over,
 * Multi-PR Coalesced Release-Train Decomposition & R1 Security Invariants (B1–B8).
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCheckA0Monotonic, runCheckA0MonotonicAsync } from '../check-a0-monotonic.js'
import { runStewardGateAsync } from '../check-cross-family-audit.js'
import {
  computeA0ReceiptDigest,
  verifyA0ApprovalFile,
  verifyA0ApprovalUnified,
} from '../lib/a0ApprovalReceipt.js'
import {
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  type ArchStewardReceipt,
  signArchStewardReceipt,
} from '../lib/archStewardContract.js'
import {
  type FetchLike,
  type GithubDiffFileEntry,
  resolveMergedPrEquivalence,
  verifyCommitIsMergedPr,
  verifyFileDiffListsByteEquivalent,
} from '../lib/githubMergedPrEquivalence.js'
import { verifyGithubA0Approval, verifyGithubStewardStatus } from '../lib/githubTrustedApproval.js'
import { globToRegExp } from '../lib/globMatch.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GOV_LIB_PATH = path.join(REPO_ROOT, 'scripts/lib/v5-selfhost-governance-gates.sh')
const TEST_REPO = 'dream-star-end/smart-assistant'
const BASE_BRANCH = 'feat/v5-selfhost'

const SHA_S = '5fff362001423baf013cd5ec7c7940054bc78ff0'
const SHA_H = '36c87bd22e573ddbf6c2d9dc6240e1dd94ba53b5'
const SHA_H2 = '9999999999999999999999999999999999999999'
const SHA_P1 = '2d98452a912970d955295140c99c3d6ff9945ab5'
const TREE_EQ = 'eb25f40a1434b34cc9e33994195dbc36ff8c1d00'
const TREE_OTHER = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee'
const TREE_PRE = '1212121212121212121212121212121212121212'
const TREE_DIR_PRE = '1313131313131313131313131313131313131313'
const TREE_DIR_POST = '1414141414141414141414141414141414141414'
const BLOB_PRE = '1010101010101010101010101010101010101010'
const BLOB_A = '1111111111111111111111111111111111111111'
const BLOB_B = '2222222222222222222222222222222222222222'

type MockRouteSpec = { status?: number; body: unknown; link?: string } | unknown

function makeMockFetch(routes: Record<string, MockRouteSpec>): FetchLike {
  return async (url) => {
    const u = new URL(url)
    const keyWithQuery = `${u.pathname}${u.search}`
    const spec = routes[keyWithQuery] ?? routes[u.pathname]
    if (spec === undefined) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => ({ message: 'not found' }),
      }
    }
    if (spec && typeof spec === 'object' && 'body' in spec && !Array.isArray(spec)) {
      const s = spec as { status?: number; body: unknown; link?: string }
      const status = s.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => (name.toLowerCase() === 'link' ? (s.link ?? null) : null) },
        json: async () => s.body,
      }
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => spec }
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

function writeA0HostReceipt(
  dir: string,
  sha: string,
  allowedPaths: string[] = ['packages/commercial/src/billing/ledger.ts'],
  reason = 'Approved A0 ledger update for OCV5-912 test',
): string {
  const issuedAt = new Date(Date.now() - 60_000).toISOString()
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  const receiptPath = path.join(dir, `${sha}.json`)
  writeFileSync(
    receiptPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        sha,
        reason,
        approvedBy: 'root',
        issuedAt,
        expiresAt,
        allowedPaths,
        sha256: computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason, allowedPaths }),
      },
      null,
      2,
    ),
  )
  return receiptPath
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

  git(['init', '-q', '-b', BASE_BRANCH])
  write(
    'arch/a0-protected-paths.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        a0Categories: [
          {
            id: 'billing-accounting-core',
            description: 'Billing core',
            paths: [
              'packages/commercial/src/billing/ledger.ts',
              'packages/commercial/src/billing/wallet.ts',
            ],
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
  write('packages/commercial/src/billing/wallet.ts', 'export const walletV = 1\n')
  write('packages/web-react/src/components/Btn.tsx', 'export const Btn = () => "ok"\n')
  write('packages/web-react/src/hooks/useX.ts', 'export const useX = () => 1\n')
  const baseSha = commit('chore(v5): seed base')
  return { dir, env, git, write, commit, baseSha }
}

function buildRefereeManifest(refereeDir: string): void {
  const files: Record<string, string> = {}
  const walk = (cur: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, ent.name)
      const rel = path.relative(refereeDir, abs).split(path.sep).join('/')
      if (rel === 'MANIFEST.json' || rel === 'node_modules') continue
      if (ent.isDirectory()) walk(abs)
      else if (ent.isFile()) {
        files[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex')
      }
    }
  }
  walk(refereeDir)
  writeFileSync(
    path.join(refereeDir, 'MANIFEST.json'),
    JSON.stringify({ schemaVersion: 1, mode: 'live-sync', files }, null, 2),
    'utf8',
  )
}

describe('B1: A0 & CODEOWNERS self-protection for all trust-core carry-over libraries', () => {
  const newTrustLibs = [
    'scripts/lib/globMatch.ts',
    'scripts/lib/githubApprovalParsers.ts',
    'scripts/lib/githubMergedPrEquivalence.ts',
    'scripts/lib/commitRangeCarryOver.ts',
    'scripts/lib/a0RangeCarryOver.ts',
  ]

  test('every new trust-core library is listed in both arch/a0-protected-paths.json and .github/CODEOWNERS, and triggers A0 block on solo edit', (t) => {
    const policyRaw = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'arch/a0-protected-paths.json'), 'utf8'),
    ) as { a0Categories: Array<{ id: string; paths?: string[] }> }
    const metaCat = policyRaw.a0Categories.find((c) => c.id === 'a0-meta-referee')
    assert.ok(metaCat?.paths, 'a0-meta-referee category must exist')
    const codeowners = readFileSync(path.join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8')

    for (const rel of newTrustLibs) {
      assert.ok(metaCat.paths.includes(rel), `arch/a0-protected-paths.json missing ${rel}`)
      assert.match(
        codeowners,
        new RegExp(`^${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+@`, 'm'),
      )
    }

    // Verify editing ANY SINGLE new trust-core lib triggers A0 hard-block under real repo policy
    const repo = initTempRepo(t)
    cpSync(
      path.join(REPO_ROOT, 'arch/a0-protected-paths.json'),
      path.join(repo.dir, 'arch/a0-protected-paths.json'),
    )
    for (const rel of newTrustLibs) repo.write(rel, 'export const v = 1\n')
    const seededBase = repo.commit('chore(v5): seed real policy and trust libs')

    for (const rel of newTrustLibs) {
      repo.write(rel, 'export const v = 2\n')
      const head = repo.commit(`chore(v5): solo edit ${rel}`)
      const res = runCheckA0Monotonic({
        root: repo.dir,
        base: seededBase,
        head,
        approvalDir: path.join(repo.dir, 'no-approvals'),
        requireRootOwner: false,
      })
      assert.equal(res.ok, false, `solo edit to ${rel} MUST hard-block A0`)
      assert.ok(
        res.a0Blocks.some((b) => b.path === rel && b.category === 'a0-meta-referee'),
        `expected a0-meta-referee block for ${rel}`,
      )
      // Reset back to seededBase for next isolated check
      repo.git(['reset', '--hard', seededBase])
    }
  })
})

describe('B5 & B6: Merged-PR Equivalence Proof (Proof A, Proof B Git tree-entry & branch/repo binding)', () => {
  const sampleFile: GithubDiffFileEntry = {
    filename: 'dir/router.ts',
    status: 'modified',
    sha: BLOB_A,
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: '@@ -1,2 +1,4 @@\n-export const a = 1\n+export const a = 2\n+export const b = 3',
  }

  function proofBRoutes(
    overrides: Record<string, MockRouteSpec> = {},
  ): Record<string, MockRouteSpec> {
    return {
      [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
        {
          number: 1421,
          merged_at: '2026-11-27T01:00:00Z',
          merge_commit_sha: SHA_S,
          base: { ref: BASE_BRANCH, sha: SHA_P1, repo: { full_name: TEST_REPO } },
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
      [`/repos/${TEST_REPO}/commits/${SHA_P1}`]: {
        sha: SHA_P1,
        commit: { tree: { sha: TREE_PRE } },
      },
      [`/repos/${TEST_REPO}/compare/${SHA_P1}...${SHA_H}`]: {
        merge_base_commit: { sha: SHA_P1, commit: { tree: { sha: TREE_PRE } } },
      },
      [`/repos/${TEST_REPO}/pulls/1421/files`]: [sampleFile],
      [`/repos/${TEST_REPO}/git/trees/${TREE_PRE}`]: {
        sha: TREE_PRE,
        truncated: false,
        tree: [{ path: 'dir', mode: '040000', type: 'tree', sha: TREE_DIR_PRE }],
      },
      [`/repos/${TEST_REPO}/git/trees/${TREE_DIR_PRE}`]: {
        sha: TREE_DIR_PRE,
        truncated: false,
        tree: [{ path: 'router.ts', mode: '100644', type: 'blob', sha: BLOB_PRE }],
      },
      [`/repos/${TEST_REPO}/git/trees/${TREE_OTHER}`]: {
        sha: TREE_OTHER,
        truncated: false,
        tree: [{ path: 'dir', mode: '040000', type: 'tree', sha: TREE_DIR_POST }],
      },
      [`/repos/${TEST_REPO}/git/trees/${TREE_EQ}`]: {
        sha: TREE_EQ,
        truncated: false,
        tree: [{ path: 'dir', mode: '040000', type: 'tree', sha: TREE_DIR_POST }],
      },
      [`/repos/${TEST_REPO}/git/trees/${TREE_DIR_POST}`]: {
        sha: TREE_DIR_POST,
        truncated: false,
        tree: [{ path: 'router.ts', mode: '100644', type: 'blob', sha: BLOB_A }],
      },
      ...overrides,
    }
  }

  test('Proof A & Proof B pass on exact match; reject 0-line binary without patch, mode flip, commit pagination, truncated tree, missing/wrong baseRef, and PR head-only match', async () => {
    assert.equal(
      verifyFileDiffListsByteEquivalent([sampleFile], [{ ...sampleFile }]).equivalent,
      true,
    )
    // RED: 1-byte drift, blob drift, missing patch (including 0-line binary/mode-only edit!), >=300 files
    assert.equal(
      verifyFileDiffListsByteEquivalent(
        [sampleFile],
        [{ ...sampleFile, patch: `${sampleFile.patch} ` }],
      ).equivalent,
      false,
    )
    assert.equal(
      verifyFileDiffListsByteEquivalent([sampleFile], [{ ...sampleFile, sha: BLOB_B }]).equivalent,
      false,
    )
    const zeroLineBinary: GithubDiffFileEntry = {
      filename: 'assets/logo.png',
      status: 'modified',
      sha: BLOB_A,
      additions: 0,
      deletions: 0,
      changes: 0,
    }
    assert.equal(
      verifyFileDiffListsByteEquivalent([zeroLineBinary], [{ ...zeroLineBinary }]).equivalent,
      false,
      '0-line modified binary/mode-only file lacking patch MUST fail closed (B6)',
    )
    const big = Array.from({ length: 300 }, (_, i) => ({ ...sampleFile, filename: `f${i}.ts` }))
    assert.equal(verifyFileDiffListsByteEquivalent(big, big).equivalent, false)

    // Proof A GREEN
    const resA = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
          {
            number: 1419,
            merged_at: '2026-11-27T00:29:09Z',
            merge_commit_sha: SHA_S,
            base: { ref: BASE_BRANCH, sha: SHA_P1, repo: { full_name: TEST_REPO } },
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
    assert.equal(resA.candidates.length, 1)
    assert.equal(resA.candidates[0]!.equivalenceProof, 'exact-tree')

    // Proof B GREEN (with matching pre & post git tree entries!)
    const resB = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch(proofBRoutes()),
    })
    assert.equal(resB.candidates.length, 1, resB.notes.join('; '))
    assert.equal(resB.candidates[0]!.equivalenceProof, 'exact-squash-diff')

    // B6 RED: executable-bit mode flip (100644 vs 100755) with identical blob SHA & patch MUST FAIL!
    const TREE_DIR_EXEC = '1515151515151515151515151515151515151515'
    const resModeFlip = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch(
        proofBRoutes({
          [`/repos/${TEST_REPO}/git/trees/${TREE_OTHER}`]: {
            sha: TREE_OTHER,
            truncated: false,
            tree: [{ path: 'dir', mode: '040000', type: 'tree', sha: TREE_DIR_EXEC }],
          },
          [`/repos/${TEST_REPO}/git/trees/${TREE_DIR_EXEC}`]: {
            sha: TREE_DIR_EXEC,
            truncated: false,
            tree: [{ path: 'router.ts', mode: '100755', type: 'blob', sha: BLOB_A }],
          },
        }),
      ),
    })
    assert.equal(resModeFlip.candidates.length, 0, 'executable-bit mode flip MUST fail Proof B')

    // B6 RED: commit detail response has Link: rel="next" (paginated files) MUST FAIL!
    const resCommitPaginated = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch(
        proofBRoutes({
          [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
            body: {
              sha: SHA_S,
              commit: { tree: { sha: TREE_OTHER } },
              parents: [{ sha: SHA_P1 }],
              files: [sampleFile],
            },
            link: '<https://api.github.com/next>; rel="next"',
          },
        }),
      ),
    })
    assert.equal(
      resCommitPaginated.candidates.length,
      0,
      'paginated commit files MUST fail Proof B',
    )

    // B6 RED: truncated Git tree response MUST FAIL with incomplete=true!
    const resTruncTree = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch(
        proofBRoutes({
          [`/repos/${TEST_REPO}/git/trees/${TREE_DIR_POST}`]: {
            sha: TREE_DIR_POST,
            truncated: true,
            tree: [{ path: 'router.ts', mode: '100644', type: 'blob', sha: BLOB_A }],
          },
        }),
      ),
    })
    assert.equal(resTruncTree.candidates.length, 0)
    assert.equal(resTruncTree.incomplete, true)

    // B5 RED: missing expectedBaseRef fails closed
    const resNoBase = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      fetchImpl: makeMockFetch(proofBRoutes()),
    })
    assert.equal(resNoBase.candidates.length, 0)

    // B5 RED: wrong base.repo.full_name fails closed
    const resWrongRepo = await resolveMergedPrEquivalence({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch(
        proofBRoutes({
          [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [
            {
              number: 1421,
              merged_at: '2026-11-27T01:00:00Z',
              merge_commit_sha: SHA_S,
              base: { ref: BASE_BRANCH, sha: SHA_P1, repo: { full_name: 'evil/fork-repo' } },
              head: { sha: SHA_H },
            },
          ],
        }),
      ),
    })
    assert.equal(resWrongRepo.candidates.length, 0)

    // B5 RED: verifyCommitIsMergedPr rejects PR where only head.sha === targetSha (merge_commit_sha differs)
    const resHeadOnly = await verifyCommitIsMergedPr({
      repo: TEST_REPO,
      token: 'ghs_tok',
      targetSha: SHA_H,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_H}/pulls`]: [
          {
            number: 1419,
            merged_at: '2026-11-27T00:29:09Z',
            merge_commit_sha: SHA_S,
            base: { ref: BASE_BRANCH, sha: SHA_P1, repo: { full_name: TEST_REPO } },
            head: { sha: SHA_H },
          },
        ],
      }),
    })
    assert.equal(
      resHeadOnly.merged,
      false,
      'PR head SHA alone MUST NOT prove landing on base branch',
    )
  })
})

describe('B3 & B4: Cross-channel VETO/Revocation supremacy, order-independence & truncated pagination fail-closed', () => {
  test('Steward & A0 carry-over, order-independent multi-candidate VETO/revocation, and truncated pagination / HTTP 500 fail closed', async (t) => {
    const futureExp = new Date(Date.now() + 3_600_000).toISOString()
    const pr1 = {
      number: 1419,
      merged_at: '2026-11-27T00:29:09Z',
      merge_commit_sha: SHA_S,
      base: { ref: BASE_BRANCH, sha: SHA_P1, repo: { full_name: TEST_REPO } },
      head: { sha: SHA_H },
    }
    const pr2 = {
      number: 1420,
      merged_at: '2026-11-27T00:29:10Z',
      merge_commit_sha: SHA_S,
      base: { ref: BASE_BRANCH, sha: SHA_P1, repo: { full_name: TEST_REPO } },
      head: { sha: SHA_H2 },
    }

    const stewardApproveOnH = {
      id: 1,
      context: 'oc-v5/arch-steward',
      state: 'success',
      description: `verdict=approve sha=${SHA_H.slice(0, 12)} author=google-gemini steward=openai-gpt digest=hmac-sha256:8d5cc05d5b075f80`,
      creator: { login: 'dream-star-end' },
      created_at: '2026-11-27T00:19:00Z',
    }
    const stewardVetoOnH2 = {
      id: 2,
      context: 'oc-v5/arch-steward',
      state: 'failure',
      description: `verdict=veto sha=${SHA_H2.slice(0, 12)} author=google-gemini steward=openai-gpt`,
      creator: { login: 'dream-star-end' },
      created_at: '2026-11-27T00:20:00Z',
    }

    // B3: Order-independent Steward multi-candidate VETO ([approve, veto] AND [veto, approve])
    for (const prs of [
      [pr1, pr2],
      [pr2, pr1],
    ]) {
      const res = await verifyGithubStewardStatus({
        repo: TEST_REPO,
        token: 'ghs_tok',
        headSha: SHA_S,
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch({
          [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [],
          [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: prs,
          [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
            sha: SHA_S,
            commit: { tree: { sha: TREE_EQ } },
            parents: [{ sha: SHA_P1 }],
          },
          [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
            sha: SHA_H,
            commit: { tree: { sha: TREE_EQ } },
          },
          [`/repos/${TEST_REPO}/commits/${SHA_H2}`]: {
            sha: SHA_H2,
            commit: { tree: { sha: TREE_EQ } },
          },
          [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [stewardApproveOnH],
          [`/repos/${TEST_REPO}/commits/${SHA_H2}/statuses`]: [stewardVetoOnH2],
        }),
      })
      assert.equal(res.valid, false)
      assert.equal(res.verdict, 'veto')
    }

    // B3: Order-independent A0 multi-candidate revocation ([approve, revoked] AND [revoked, approve])
    const a0ApproveOnH = {
      id: 10,
      context: 'oc-v5/a0-approval',
      state: 'success',
      description: `sha=${SHA_H.slice(0, 12)} exp=${futureExp} paths=packages/commercial/src/billing/ledger.ts | Approved A0`,
      creator: { login: 'dream-star-end' },
      created_at: '2026-11-27T00:35:00Z',
    }
    const a0RevokedOnH2 = {
      id: 11,
      context: 'oc-v5/a0-approval',
      state: 'failure',
      description: `revoked sha=${SHA_H2.slice(0, 12)} paths=* | Revoked A0`,
      creator: { login: 'dream-star-end' },
      created_at: '2026-11-27T00:36:00Z',
    }
    for (const prs of [
      [pr1, pr2],
      [pr2, pr1],
    ]) {
      const res = await verifyGithubA0Approval({
        repo: TEST_REPO,
        token: 'ghs_tok',
        headSha: SHA_S,
        a0Paths: ['packages/commercial/src/billing/ledger.ts'],
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch({
          [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [],
          [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: prs,
          [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
            sha: SHA_S,
            commit: { tree: { sha: TREE_EQ } },
            parents: [{ sha: SHA_P1 }],
          },
          [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
            sha: SHA_H,
            commit: { tree: { sha: TREE_EQ } },
          },
          [`/repos/${TEST_REPO}/commits/${SHA_H2}`]: {
            sha: SHA_H2,
            commit: { tree: { sha: TREE_EQ } },
          },
          [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [a0ApproveOnH],
          [`/repos/${TEST_REPO}/commits/${SHA_H2}/statuses`]: [a0RevokedOnH2],
          [`/repos/${TEST_REPO}/pulls/1419/reviews`]: [],
          [`/repos/${TEST_REPO}/pulls/1420/reviews`]: [],
        }),
      })
      assert.equal(res.valid, false)
      assert.equal(res.revoked, true)
    }

    // B3: Direct A0 status approved on S + CHANGES_REQUESTED on open PR -> REJECT!
    const a0StatusApproveOnS = {
      id: 12,
      context: 'oc-v5/a0-approval',
      state: 'success',
      description: `sha=${SHA_S.slice(0, 12)} exp=${futureExp} paths=packages/commercial/src/billing/ledger.ts | Approved A0`,
      creator: { login: 'dream-star-end' },
      created_at: '2026-11-27T00:35:00Z',
    }
    const rChangesReq = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      prNumber: 1450,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [a0StatusApproveOnS],
        [`/repos/${TEST_REPO}/pulls/1450/reviews`]: [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            commit_id: SHA_S,
            user: { login: 'dream-star-end' },
          },
        ],
      }),
    })
    assert.equal(rChangesReq.valid, false)
    assert.equal(rChangesReq.denied, true)

    // B3: Cross-channel A0 — valid local host receipt + online GitHub revocation MUST REJECT!
    const approvalDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-b3-a0-'))
    t.after(() => rmSync(approvalDir, { recursive: true, force: true }))
    writeA0HostReceipt(approvalDir, SHA_S)
    const rCrossRevoked = await verifyA0ApprovalUnified({
      approvalDir,
      targetSha: SHA_S,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      requireRootOwner: false,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch({
          [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [
            {
              id: 21,
              context: 'oc-v5/a0-approval',
              state: 'failure',
              description: `revoked sha=${SHA_S.slice(0, 12)} paths=* | Revoked online`,
              creator: { login: 'dream-star-end' },
            },
          ],
        }),
      },
    })
    assert.equal(
      rCrossRevoked.valid,
      false,
      'online revocation MUST override valid host A0 receipt',
    )
    assert.equal(rCrossRevoked.revoked, true)

    // B4: Truncated statuses pagination (>5 pages) overrides both approve on page 1 AND local host receipt!
    const selfLoopingStatuses: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'link' ? `<${url}>; rel="next"` : null) },
      json: async () => [a0StatusApproveOnS],
    })
    const rTruncA0 = await verifyA0ApprovalUnified({
      approvalDir,
      targetSha: SHA_S,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      requireRootOwner: false,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: selfLoopingStatuses,
      },
    })
    assert.equal(rTruncA0.valid, false)
    assert.equal(rTruncA0.incomplete, true)

    // B4: HTTP 500 on H statuses fails closed with incomplete=true (never returns equivalenceCandidates for host fallback!)
    const rHttp500OnH = await verifyGithubStewardStatus({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [],
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [pr1],
        [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
          sha: SHA_S,
          commit: { tree: { sha: TREE_EQ } },
          parents: [{ sha: SHA_P1 }],
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
          sha: SHA_H,
          commit: { tree: { sha: TREE_EQ } },
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: {
          status: 500,
          body: { message: 'boom' },
        },
      }),
    })
    assert.equal(rHttp500OnH.valid, false)
    assert.equal(rHttp500OnH.incomplete, true)
    assert.equal(rHttp500OnH.equivalenceCandidates, undefined)

    // B4: Invalid direct A0 status on S (missing paths=) blocks carry-over from H!
    const rInvalidDirect = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      expectedBaseRef: BASE_BRANCH,
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [
          {
            id: 30,
            context: 'oc-v5/a0-approval',
            state: 'success',
            description: `sha=${SHA_S.slice(0, 12)} | Missing paths scope token`,
            creator: { login: 'dream-star-end' },
          },
        ],
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [pr1],
        [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
          sha: SHA_S,
          commit: { tree: { sha: TREE_EQ } },
          parents: [{ sha: SHA_P1 }],
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
          sha: SHA_H,
          commit: { tree: { sha: TREE_EQ } },
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [a0ApproveOnH],
        [`/repos/${TEST_REPO}/pulls/1419/reviews`]: [],
      }),
    })
    assert.equal(rInvalidDirect.valid, false)
    assert.equal(rInvalidDirect.invalid, true)

    // B5: Explicit prNumber HARD-disables carry-over even if allowMergedPrCarryOver: true
    const rPrHardDisable = await verifyGithubA0Approval({
      repo: TEST_REPO,
      token: 'ghs_tok',
      headSha: SHA_S,
      prNumber: 1419,
      allowMergedPrCarryOver: true,
      expectedBaseRef: BASE_BRANCH,
      a0Paths: ['packages/commercial/src/billing/ledger.ts'],
      fetchImpl: makeMockFetch({
        [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [],
        [`/repos/${TEST_REPO}/pulls/1419/reviews`]: [],
        [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [pr1],
        [`/repos/${TEST_REPO}/commits/${SHA_S}`]: {
          sha: SHA_S,
          commit: { tree: { sha: TREE_EQ } },
          parents: [{ sha: SHA_P1 }],
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}`]: {
          sha: SHA_H,
          commit: { tree: { sha: TREE_EQ } },
        },
        [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [a0ApproveOnH],
      }),
    })
    assert.equal(rPrHardDisable.valid, false, 'prNumber MUST hard-disable merged-PR carry-over')
  })
})

describe('B2 & B3: Reversed-order multi-commit trains, mixed-channel Steward VETO & offline prNumber isolation', () => {
  test('Steward: coalesced 2-PR train passes; REVERSED ORDER (unapproved S1 + approved merged PR S2) MUST FAIL; GitHub approve on H + local host HARD VETO on H MUST FAIL', async (t) => {
    const repo = initTempRepo(t)
    const receiptDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-steward-'))
    t.after(() => rmSync(receiptDir, { recursive: true, force: true }))
    const hmacKey = 'ocv5-912-test-hmac-secret-0123456789'

    // S1: high-risk gateway edit (PR #1419, head = SHA_H)
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

    // S2: low-risk web-views edit (PR #1426)
    repo.write('packages/web-react/src/components/Btn.tsx', 'export const Btn = () => "v2"\n')
    const s2 = repo.commit('ui(v5): tiny button tweak (PR #1426)')

    const routes: Record<string, MockRouteSpec> = {
      [`/repos/${TEST_REPO}/commits/${s1}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s1}/pulls`]: [
        {
          number: 1419,
          merged_at: '2026-11-27T00:29:09Z',
          merge_commit_sha: s1,
          base: { ref: BASE_BRANCH, sha: repo.baseSha, repo: { full_name: TEST_REPO } },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${s1}`]: {
        sha: s1,
        commit: { tree: { sha: s1Tree } },
        parents: [{ sha: repo.baseSha }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: { sha: SHA_H, commit: { tree: { sha: s1Tree } } },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/pulls`]: [
        {
          number: 1426,
          merged_at: '2026-11-27T00:30:10Z',
          merge_commit_sha: s2,
          base: { ref: BASE_BRANCH, sha: s1, repo: { full_name: TEST_REPO } },
          head: { sha: s2 },
        },
      ],
    }

    // GREEN: single commit S1 host carry-over + coalesced 2-PR train
    const rS1 = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: repo.baseSha,
      headRef: s1,
      receiptDirs: [receiptDir],
      requireRootOwner: false,
      hmacKey,
      requireHmac: true,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch(routes),
      },
    })
    assert.equal(rS1.ok, true, JSON.stringify(rS1.receiptLookup))

    const rTrain = await runStewardGateAsync({
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
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch(routes),
      },
    })
    assert.equal(rTrain.ok, true, JSON.stringify(rTrain.receiptLookup))
    assert.match(rTrain.receiptLookup?.source ?? '', /multi-commit-range\(2\)/)

    // B3 RED: GitHub approves H, but local host receipt for H carries HARD VETO -> MUST REJECT!
    const vetoDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-steward-veto-'))
    t.after(() => rmSync(vetoDir, { recursive: true, force: true }))
    const hostVetoH = signArchStewardReceipt(
      makeStewardReceipt({
        headSha: SHA_H,
        baseSha: repo.baseSha,
        verdict: 'veto',
        blockers: [
          {
            dimension: 'boundaryIntegrity',
            severity: 'P1',
            location: 'packages/gateway/src/execEnv.ts',
            reason: 'Architectural boundary breach',
          },
        ],
        dimensions: {
          godClassAppend: { status: 'pass', notes: 'ok' },
          wheelReinvention: { status: 'pass', notes: 'ok' },
          boundaryIntegrity: { status: 'veto', notes: 'breach' },
          complexityDrift: { status: 'pass', notes: 'ok' },
        },
      }),
      hmacKey,
    )
    writeFileSync(path.join(vetoDir, `${SHA_H}.json`), JSON.stringify(hostVetoH, null, 2))
    const rCrossVeto = await runStewardGateAsync({
      root: repo.dir,
      mode: 'enforce-commit',
      baseRef: repo.baseSha,
      headRef: s1,
      receiptDirs: [vetoDir],
      requireRootOwner: false,
      hmacKey,
      requireHmac: true,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch({
          ...routes,
          [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [
            {
              id: 77,
              context: 'oc-v5/arch-steward',
              state: 'success',
              description: `verdict=approve sha=${SHA_H.slice(0, 12)} author=google-gemini steward=openai-gpt digest=hmac-sha256:8d5cc05d5b075f80`,
              creator: { login: 'dream-star-end' },
            },
          ],
        }),
      },
    })
    assert.equal(
      rCrossVeto.ok,
      false,
      'local host HARD VETO on H MUST override GitHub approve on H',
    )

    // B2 RED (REVERSED ORDER): S_early is unapproved high-risk gateway edit; S_tip is approved merged PR!
    const repoRev = initTempRepo(t)
    repoRev.write('packages/gateway/src/earlyUnapproved.ts', 'export const sneaky = 1\n')
    const sEarly = repoRev.commit('feat(v5): unapproved high-risk early commit')
    repoRev.write('packages/gateway/src/laterApproved.ts', 'export const approved = 2\n')
    const sTip = repoRev.commit('feat(v5): approved tip PR (#1500)')
    const sTipTree = repoRev.git(['rev-parse', `${sTip}^{tree}`])

    const revRoutes: Record<string, MockRouteSpec> = {
      [`/repos/${TEST_REPO}/commits/${sEarly}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${sEarly}/pulls`]: [],
      [`/repos/${TEST_REPO}/commits/${sTip}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${sTip}/pulls`]: [
        {
          number: 1500,
          merged_at: '2026-11-27T02:00:00Z',
          merge_commit_sha: sTip,
          base: { ref: BASE_BRANCH, sha: sEarly, repo: { full_name: TEST_REPO } },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${sTip}`]: {
        sha: sTip,
        commit: { tree: { sha: sTipTree } },
        parents: [{ sha: sEarly }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: { sha: SHA_H, commit: { tree: { sha: sTipTree } } },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [
        {
          id: 88,
          context: 'oc-v5/arch-steward',
          state: 'success',
          description: `verdict=approve sha=${SHA_H.slice(0, 12)} author=google-gemini steward=openai-gpt digest=hmac-sha256:8d5cc05d5b075f80`,
          creator: { login: 'dream-star-end' },
        },
      ],
    }
    const rReversedSteward = await runStewardGateAsync({
      root: repoRev.dir,
      mode: 'enforce-commit',
      baseRef: repoRev.baseSha,
      headRef: sTip,
      receiptDirs: [receiptDir],
      requireRootOwner: false,
      hmacKey,
      requireHmac: true,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch(revRoutes),
      },
    })
    assert.equal(
      rReversedSteward.ok,
      false,
      'B2: approved tip PR MUST NOT skip earlier unapproved high-risk commit',
    )
  })

  test('A0: REVERSED ORDER (unapproved S1 + approved merged PR S2) MUST FAIL for both SAME path and DIFFERENT paths; offline --pr-number disables range fallback', async (t) => {
    const repo = initTempRepo(t)
    const approvalDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-b2-a0-'))
    t.after(() => rmSync(approvalDir, { recursive: true, force: true }))
    const futureExp = new Date(Date.now() + 3_600_000).toISOString()

    // S1: UNAPPROVED edit to ledger.ts
    repo.write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 100\n')
    const s1 = repo.commit('feat(v5): unapproved early A0 ledger edit')
    // S2: APPROVED merged PR touching SAME file ledger.ts AND wallet.ts (paths=*)
    repo.write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 101\n')
    repo.write('packages/commercial/src/billing/wallet.ts', 'export const walletV = 2\n')
    const s2 = repo.commit('feat(v5): approved tip PR touching A0 (#202)')
    const s2Tree = repo.git(['rev-parse', `${s2}^{tree}`])

    const revA0Routes: Record<string, MockRouteSpec> = {
      [`/repos/${TEST_REPO}/commits/${s1}/statuses`]: [],
      [`/repos/${TEST_REPO}/commits/${s1}/pulls`]: [],
      [`/repos/${TEST_REPO}/commits/${s2}/statuses`]: [
        {
          id: 90,
          context: 'oc-v5/a0-approval',
          state: 'success',
          description: `sha=${s2.slice(0, 12)} exp=${futureExp} paths=* | Direct approve on merged PR tip`,
          creator: { login: 'dream-star-end' },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${s2}/pulls`]: [
        {
          number: 202,
          merged_at: '2026-11-27T02:10:00Z',
          merge_commit_sha: s2,
          base: { ref: BASE_BRANCH, sha: s1, repo: { full_name: TEST_REPO } },
          head: { sha: SHA_H },
        },
      ],
      [`/repos/${TEST_REPO}/commits/${s2}`]: {
        sha: s2,
        commit: { tree: { sha: s2Tree } },
        parents: [{ sha: s1 }],
      },
      [`/repos/${TEST_REPO}/commits/${SHA_H}`]: { sha: SHA_H, commit: { tree: { sha: s2Tree } } },
      [`/repos/${TEST_REPO}/commits/${SHA_H}/statuses`]: [
        {
          id: 91,
          context: 'oc-v5/a0-approval',
          state: 'success',
          description: `sha=${SHA_H.slice(0, 12)} exp=${futureExp} paths=* | Approved tip PR head`,
          creator: { login: 'dream-star-end' },
        },
      ],
      [`/repos/${TEST_REPO}/pulls/202/reviews`]: [],
    }

    // B2 RED: Even with paths=* on BOTH s2 AND H2, S1 was unapproved -> MUST FAIL!
    const rRevA0 = await runCheckA0MonotonicAsync({
      root: repo.dir,
      base: repo.baseSha,
      head: s2,
      approvalDir,
      requireRootOwner: false,
      github: {
        repo: TEST_REPO,
        token: 'ghs_tok',
        expectedBaseRef: BASE_BRANCH,
        fetchImpl: makeMockFetch(revA0Routes),
      },
    })
    assert.equal(
      rRevA0.ok,
      false,
      'B2: approved merged PR tip MUST NOT skip unapproved earlier A0 commit',
    )

    // B5 RED: Offline open PR (prNumber set, NO github token) MUST NOT use multi-commit range fallback!
    const repoOffline = initTempRepo(t)
    repoOffline.write('packages/commercial/src/billing/ledger.ts', 'export const ledgerV = 2\n')
    const p1 = repoOffline.commit('feat(v5): approved A0 commit 1')
    writeA0HostReceipt(approvalDir, p1)
    repoOffline.write(
      'packages/web-react/src/components/Btn.tsx',
      'export const Btn = () => "v2"\n',
    )
    const p2 = repoOffline.commit('ui(v5): non-A0 follow-up')

    const rOfflineRange = await runCheckA0MonotonicAsync({
      root: repoOffline.dir,
      base: repoOffline.baseSha,
      head: p2,
      approvalDir,
      requireRootOwner: false,
    })
    assert.equal(rOfflineRange.ok, true, 'non-PR multi-commit range with approved p1 passes')

    const rOfflineOpenPr = await runCheckA0MonotonicAsync({
      root: repoOffline.dir,
      base: repoOffline.baseSha,
      head: p2,
      prNumber: 777,
      approvalDir,
      requireRootOwner: false,
    })
    assert.equal(
      rOfflineOpenPr.ok,
      false,
      'B5: open PR with --pr-number and NO github token MUST disable multi-commit range fallback',
    )
  })
})

describe('B8: Glob equivalence between host A0 receipt and GitHub A0 status', () => {
  test('docs/** matches nested and single-level paths identically across globToRegExp, host file, and GitHub status', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-b8-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const futureExp = new Date(Date.now() + 3_600_000).toISOString()

    const cases: Array<{ glob: string; path: string; expectMatch: boolean }> = [
      { glob: 'docs/**', path: 'docs/guide.md', expectMatch: true },
      { glob: 'docs/**', path: 'docs/user/guide.md', expectMatch: true },
      { glob: 'docs/**', path: 'docs/a/b/c.md', expectMatch: true },
      { glob: 'docs/**', path: 'docs2/guide.md', expectMatch: false },
      { glob: 'scripts/check-*.ts', path: 'scripts/check-a0-monotonic.ts', expectMatch: true },
      { glob: 'scripts/check-*.ts', path: 'scripts/sub/check-a0-monotonic.ts', expectMatch: false },
      {
        glob: 'packages/**/billing/*.ts',
        path: 'packages/commercial/src/billing/ledger.ts',
        expectMatch: true,
      },
    ]

    for (const c of cases) {
      assert.equal(
        globToRegExp(c.glob).test(c.path),
        c.expectMatch,
        `globToRegExp(${c.glob}) vs ${c.path}`,
      )
      const hostPath = writeA0HostReceipt(dir, SHA_S, [c.glob])
      const hostRes = verifyA0ApprovalFile({
        receiptPath: hostPath,
        targetSha: SHA_S,
        a0Paths: [c.path],
        requireRootOwner: false,
      })
      const ghRes = await verifyGithubA0Approval({
        repo: TEST_REPO,
        token: 'ghs_tok',
        headSha: SHA_S,
        a0Paths: [c.path],
        allowMergedPrCarryOver: false,
        fetchImpl: makeMockFetch({
          [`/repos/${TEST_REPO}/commits/${SHA_S}/statuses`]: [
            {
              id: 1,
              context: 'oc-v5/a0-approval',
              state: 'success',
              description: `sha=${SHA_S.slice(0, 12)} exp=${futureExp} paths=${c.glob} | Glob parity test`,
              creator: { login: 'dream-star-end' },
            },
          ],
          [`/repos/${TEST_REPO}/commits/${SHA_S}/pulls`]: [],
        }),
      })
      assert.equal(hostRes.valid, c.expectMatch, `host ${c.glob} vs ${c.path}`)
      assert.equal(ghRes.valid, c.expectMatch, `github ${c.glob} vs ${c.path}`)
    }
  })
})

describe('B7: Host release train (v5-selfhost-governance-gates.sh) trusted referee, xtrace redaction & bootstrap token stripping', () => {
  test('trusted external referee passes squash A0+Steward under bash -x without leaking token; bootstrap & disable flag strip tokens; origin parser rejects spoofed host', async (t) => {
    const repo = initTempRepo(t)
    const refereeDir = mkdtempSync(path.join(tmpdir(), 'ocv5-912-referee-'))
    const staging = mkdtempSync(path.join(tmpdir(), 'ocv5-912-staging-'))
    const gateTmp = mkdtempSync(path.join(tmpdir(), 'ocv5-912-gtmp-'))
    t.after(() => {
      rmSync(refereeDir, { recursive: true, force: true })
      rmSync(staging, { recursive: true, force: true })
      rmSync(gateTmp, { recursive: true, force: true })
    })

    const stubGates = [
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
    ]
    const writeBoth = (rel: string, content: string) => {
      repo.write(rel, content)
      const refDst = path.join(refereeDir, rel)
      mkdirSync(path.dirname(refDst), { recursive: true })
      writeFileSync(refDst, content, 'utf8')
    }
    for (const rel of stubGates) writeBoth(rel, 'process.exit(0)\n')
    // Non-A0/Steward gate probe: verify GITHUB_TOKEN/GH_TOKEN are stripped for all other gates!
    writeBoth(
      'scripts/check-docs-links.ts',
      'if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) { console.error("TOKEN_LEAKED_TO_DOCS_GATE"); process.exit(99); }\nprocess.exit(0)\n',
    )
    writeBoth('scripts/check-biome-changed.sh', '#!/usr/bin/env bash\nexit 0\n')
    writeBoth(
      'scripts/check-no-silent-model-downgrade.ts',
      'export const WEAK_MODEL_SLUG_RE = /(?:flash-lite|mini|haiku|nano)/i\n',
    )
    writeBoth(
      'scripts/check-gate-couplings.ts',
      'export const isGate = () => false\nexport const rawNames = () => []\n',
    )
    writeBoth(
      'packages/protocol/src/boxApiModels.ts',
      'export const BOX_API_MODELS = [] as const\n',
    )
    writeBoth(
      'packages/protocol/src/engineModels.ts',
      'export const ANTIGRAVITY_ENGINE_MODELS = [] as const\nexport const CODEX_ENGINE_MODELS = [] as const\nexport const CURSOR_ENGINE_MODELS = [] as const\nexport const GROK_ENGINE_MODELS = [] as const\nexport const ZCODE_ENGINE_MODELS = [] as const\n',
    )
    repo.write('changelog.json', '[]\n')

    const realFiles = [
      'scripts/check-a0-monotonic.ts',
      'scripts/check-cross-family-audit.ts',
      'scripts/lib/a0MonotonicRules.ts',
      'scripts/lib/a0ApprovalReceipt.ts',
      'scripts/lib/a0RangeCarryOver.ts',
      'scripts/lib/archStewardContract.ts',
      'scripts/lib/archStewardGitDiff.ts',
      'scripts/lib/archStewardReceipt.ts',
      'scripts/lib/archStewardTypes.ts',
      'scripts/lib/commitRangeCarryOver.ts',
      'scripts/lib/githubApprovalParsers.ts',
      'scripts/lib/githubMergedPrEquivalence.ts',
      'scripts/lib/githubTrustedApproval.ts',
      'scripts/lib/globMatch.ts',
      'scripts/lib/modelFamilyClassifier.ts',
      'scripts/lib/runtimeImagePin.ts',
    ]
    for (const rel of realFiles) {
      for (const base of [repo.dir, refereeDir]) {
        const dst = path.join(base, rel)
        mkdirSync(path.dirname(dst), { recursive: true })
        cpSync(path.join(REPO_ROOT, rel), dst)
      }
    }
    buildRefereeManifest(refereeDir)
    const baseSha = repo.commit('chore(v5): seed real A0 + Steward gates')

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
    const realNodeModules = realpathSync(path.join(REPO_ROOT, 'node_modules'))
    symlinkSync(realNodeModules, path.join(staging, 'node_modules'))

    const futureExp = new Date(Date.now() + 3_600_000).toISOString()
    const DUMMY_SECRET_TOKEN = 'ghs_dummy_xtrace_sentinel_ocv5_912'
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
                    base: { ref: BASE_BRANCH, sha: baseSha, repo: { full_name: TEST_REPO } },
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
      const runTrain = (opts: {
        refRoot: string
        xtrace?: boolean
        extraEnv?: Record<string, string>
      }) =>
        new Promise<{ status: number | null; out: string }>((resolve) => {
          const flags = opts.xtrace
            ? ['-Eeu', '-x', '-o', 'pipefail', '-c']
            : ['-Eeu', '-o', 'pipefail', '-c']
          const child = spawn(
            'bash',
            [
              ...flags,
              [
                'mlog() { echo "$*" >&2; }',
                'tsum_note() { :; }',
                `source '${GOV_LIB_PATH}'`,
                `REPO_ROOT='${repo.dir}'; MASTER_LIVE_LINK='${path.join(repo.dir, 'no-live')}'; OC_V5_REFEREE_ROOT='${opts.refRoot}'; OC_V5_REFEREE_NODE_MODULES='${realNodeModules}'; MASTER_GATE_TMPDIR='${gateTmp}'; OC_V5_GOVERNANCE_BASE_REF='${baseSha}'; BRANCH='${BASE_BRANCH}'; master_run_governance_fast_gates '${staging}' '${squashSha}'`,
              ].join('\n'),
            ],
            {
              env: {
                ...repo.env,
                GITHUB_REPOSITORY: TEST_REPO,
                GITHUB_TOKEN: DUMMY_SECRET_TOKEN,
                GITHUB_API_URL: `http://127.0.0.1:${port}`,
                OC_GOVERNOR_ROOT: path.join(gateTmp, 'empty-gov'),
                ...(opts.extraEnv ?? {}),
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

      // 1. GREEN + xtrace redaction: trusted external referee passes squash A0+Steward AND never prints token!
      const rPass = await runTrain({ refRoot: refereeDir, xtrace: true })
      assert.equal(rPass.status, 0, `expected trusted referee PASS:\n${rPass.out}`)
      assert.equal(
        rPass.out.includes(DUMMY_SECRET_TOKEN),
        false,
        'B7: GITHUB_TOKEN MUST NEVER appear in bash -x trace output',
      )

      // 2. RED: bootstrap mode (no external referee) strips GITHUB_TOKEN so candidate scripts NEVER receive it!
      const rBootstrap = await runTrain({ refRoot: path.join(repo.dir, 'no-referee') })
      assert.notEqual(
        rBootstrap.status,
        0,
        'B7: bootstrap mode MUST NOT pass GitHub token to candidate scripts',
      )

      // 3. RED: OC_V5_DISABLE_GH_APPROVAL_LOOKUP=1 blocks online lookup even in trusted referee mode
      const rDisabled = await runTrain({
        refRoot: refereeDir,
        extraEnv: { OC_V5_DISABLE_GH_APPROVAL_LOOKUP: '1' },
      })
      assert.notEqual(
        rDisabled.status,
        0,
        'B7: OC_V5_DISABLE_GH_APPROVAL_LOOKUP=1 MUST disable online lookup',
      )

      // 4. RED: without carry-over PR, trusted referee fails closed
      allowCarry = false
      const rNoCarry = await runTrain({ refRoot: refereeDir })
      assert.notEqual(
        rNoCarry.status,
        0,
        'expected trusted referee to fail closed without carry-over',
      )

      // 5. B7: Strict origin URL parser accepts only anchored github.com URLs
      const parseOrigin = (url: string) =>
        execFileSync(
          'bash',
          [
            '-c',
            `source '${GOV_LIB_PATH}'; _master_governance_parse_github_origin_repo "$1"`,
            '_',
            url,
          ],
          { encoding: 'utf8' },
        ).trim()
      assert.equal(parseOrigin('https://github.com/dream-star-end/smart-assistant.git'), TEST_REPO)
      assert.equal(parseOrigin('git@github.com:dream-star-end/smart-assistant.git'), TEST_REPO)
      assert.equal(parseOrigin('ssh://git@github.com/dream-star-end/smart-assistant'), TEST_REPO)
      assert.equal(
        parseOrigin('https://evil.example/github.com/dream-star-end/smart-assistant.git'),
        '',
      )
      assert.equal(
        parseOrigin('https://github.com.evil.example/dream-star-end/smart-assistant.git'),
        '',
      )
    } finally {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
