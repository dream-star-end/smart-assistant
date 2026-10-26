#!/usr/bin/env tsx
/**
 * Deploy-gate proofs for master-side incidents that came with the OCV5-380 selfhost merge
 * (alert inbox fallback, cron inbox delivery key, project output assets, PROJECT.md seed).
 *
 * Each proof runs the incident's own regression file on the pinned tree and requires the named
 * cases to pass: not missing, not skipped (a skip because the test PostgreSQL is down is a
 * failure here), no other case failing in that file. The alert proof runs against a real
 * PostgreSQL: TEST_DATABASE_URL must name a loopback *_test database; nothing else is read.
 *
 *   TEST_DATABASE_URL=postgres://…@127.0.0.1:…/…_test npx --no-install tsx scripts/check-v5-master-incident-proofs.ts
 */
import { spawnSync } from 'node:child_process'

type Proof = { incident: string; slug: string; file: string; db: boolean; cases: readonly string[] }

export const MASTER_INCIDENT_PROOFS: readonly Proof[] = [
  {
    incident: 'INC-20261009-ALERT-INBOX-FALLBACK', slug: 'inc-20261009-alert-inbox-fallback', db: true,
    file: 'packages/commercial/src/__tests__/alertOutboxInboxFallback.integ.test.ts',
    cases: [
      '同 dedupe_key 重复兜底 → 只写 1 条,第二次 inbox_fallback=false',
      'uid=1 不是 admin(个人版)→ 发给最小的非系统种子 active admin',
      'uid=1 是 active admin(商业版)→ 仍发给 uid=1',
    ],
  },
  {
    incident: 'INC-20261009-INBOX-DELIVERY-KEY-500', slug: 'inc-20261009-inbox-delivery-key-500', db: false,
    file: 'packages/commercial/src/__tests__/internalInboxPost.test.ts',
    cases: ['delivery key already delivered with other content → 200 duplicate, not 500 (OCV5-365)'],
  },
  {
    incident: 'INC-20261008-PROJECT-OUTPUTS-INVISIBLE', slug: 'inc-20261008-project-outputs-invisible', db: false,
    file: 'packages/commercial/src/__tests__/internalProjectAssets.test.ts',
    cases: [
      'registers into the tenant from the container identity, never from the body',
      "the project frozen at turn start wins over the session's current project",
      'a deleted, missing or foreign session registers nothing',
    ],
  },
  {
    incident: 'INC-20261008-PROJECT-OUTPUTS-INVISIBLE', slug: 'inc-20261008-project-outputs-invisible-container', db: false,
    file: 'packages/gateway/src/__tests__/projectAssetOutputsMaster.test.ts',
    cases: [
      'registers on the master with the project frozen at turn start',
      'a master outage spools the registration and the next collection sends it once',
    ],
  },
  {
    incident: 'INC-20261008-PROJECT-MD-SEED-OVERWRITE', slug: 'inc-20261008-project-md-seed-overwrite', db: false,
    file: 'packages/storage/src/__tests__/projectContext.test.ts',
    cases: [
      'a hand-edited PROJECT.md with a stale hash is preserved, not replaced by the seed',
      'a deliberate clear is never refilled by a stale PG mirror',
      'a seed racing a human write cannot overwrite it (checked under the lock)',
    ],
  },
  {
    incident: 'INC-20261026-MUSE-SOURCE-CHUNK-256K', slug: 'inc-20261026-muse-source-chunk-256k', db: false,
    file: 'packages/commercial/src/__tests__/museBridge.test.ts',
    cases: ['hello source_chunk_bytes is never below the bridge default and within its hard limit'],
  },
  {
    incident: 'INC-20261026-STUDIO-MUSE-RETRY-REPLAY', slug: 'inc-20261026-studio-muse-retry-replay', db: false,
    file: 'packages/commercial/src/__tests__/studioProviders.test.ts',
    cases: ['muse: a retry after a failed job submits the next job of the chain, never replays the failure (INC-20261026-STUDIO-MUSE-RETRY-REPLAY)'],
  },
]

function fail(message: string): never {
  throw new Error(`[master-incident-proofs] ${message}`)
}

/** A loopback *_test database, as the other proof gates require. */
export function assertTestDsn(raw: string | undefined): string {
  if (!raw) fail('TEST_DATABASE_URL is required (a loopback *_test database)')
  let url: URL
  try { url = new URL(raw) } catch { fail('TEST_DATABASE_URL is not a URL') }
  if (!/^postgres(ql)?:$/.test(url.protocol)) fail('TEST_DATABASE_URL is not postgres')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('TEST_DATABASE_URL is not loopback')
  if (!/_test$/.test(url.pathname.slice(1))) fail('TEST_DATABASE_URL does not name a *_test database')
  if (url.search) fail('TEST_DATABASE_URL must not carry query overrides')
  return raw
}

type Leaf = { name: string; ok: boolean; skip: boolean }

/** Every reported test point of node --test's TAP output, nested ones included. */
export function tapLeaves(tap: string): Leaf[] {
  const leaves: Leaf[] = []
  for (const line of tap.split('\n')) {
    const m = /^\s*(not )?ok \d+ - (.*?)(\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line)
    if (m) leaves.push({ name: m[2]!, ok: !m[1], skip: Boolean(m[3]) })
  }
  return leaves
}

export function judge(proof: Proof, tap: string, status: number | null): string[] {
  const leaves = tapLeaves(tap)
  const out: string[] = []
  for (const name of proof.cases) {
    const leaf = leaves.find((item) => item.name === name)
    if (!leaf) fail(`${proof.incident}: case missing — ${name}`)
    if (leaf.skip) fail(`${proof.incident}: case skipped — ${name}`)
    if (!leaf.ok) fail(`${proof.incident}: case failed — ${name}`)
    out.push(`[${proof.slug}] PASS — ${name}`)
  }
  const failed = leaves.filter((item) => !item.ok).map((item) => item.name)
  if (failed.length || status !== 0) fail(`${proof.incident}: ${proof.file} not green (${failed.join('; ') || `exit ${status}`})`)
  return out
}

function main(): void {
  const dsn = assertTestDsn(process.env.TEST_DATABASE_URL)
  const lines: string[] = []
  for (const proof of MASTER_INCIDENT_PROOFS) {
    const { DATABASE_URL: _db, NODE_OPTIONS: _opts, TEST_DATABASE_URL: _test, ...base } = process.env
    const env: NodeJS.ProcessEnv = proof.db ? { ...base, TEST_DATABASE_URL: dsn } : base
    const run = spawnSync('npx', ['--no-install', 'tsx', '--test', '--test-reporter=tap',
      '--test-concurrency=1', proof.file], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024 })
    if (run.error) fail(`${proof.incident}: ${run.error.message}`)
    lines.push(...judge(proof, run.stdout ?? '', run.status))
  }
  for (const line of lines) console.log(line)
  console.log(`[master-incident-proofs] PASS ${lines.length} cases`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
