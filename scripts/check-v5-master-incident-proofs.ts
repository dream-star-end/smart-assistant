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
import assert from 'node:assert/strict'
import { scopeBoxExecToProfile } from '../packages/commercial/src/http/proxy/boxProfileExec.js'
import { BoxProfileHealth } from '../packages/commercial/src/http/proxy/boxProfileHealth.js'
import { isBoxLaunchRequest } from '../packages/commercial/src/http/proxy/boxClaudeProfile.js'

type Proof = { incident: string; slug: string; file: string; db: boolean; cases: readonly string[] }

export const MASTER_INCIDENT_PROOFS: readonly Proof[] = [
  {
    incident: 'INC-20261031-TURN-LABEL-UNDERCOUNT', slug: 'inc-20261031-turn-label-realpg', db: true,
    file: 'packages/commercial/src/__tests__/openTurnAttribution.integ.test.ts',
    cases: [
      'real PG attribution one: debit 132 once, refresh label 132',
      'real PG attribution none: debit 132 once, refresh label 97',
      'real PG attribution many: debit 132 once, refresh label 97',
      'real PG attribution unkeyed: debit 132 once, refresh label 97',
    ],
  },
  {
    incident: 'INC-20261026-REFRESH-GRACE', slug: 'inc-20261026-refresh-grace-realpg', db: true,
    file: 'packages/commercial/src/__tests__/login.integ.test.ts',
    cases: [
      'reuse rotated refresh at 11s / 40s (default grace=45) → REFRESH_RACE',
      'reuse rotated refresh at 50s (default grace=45) → still theft',
    ],
  },
  {
    incident: 'INC-20261109-MUSE-ORIGIN-SCHEMA', slug: 'inc-20261109-muse-origin-schema', db: false,
    file: 'packages/commercial/src/__tests__/museDurable.test.ts',
    cases: ["INC-20261109-MUSE-ORIGIN-SCHEMA: explicit metadata stays strict and out of the bridge spec", "INC-20261109-MUSE-ORIGIN-SCHEMA: HTTP reaches real origin ownership gate before insertion", "INC-20261109-MUSE-ORIGIN-SCHEMA: real oc-muse video submits origin and acknowledges one conversation result"],
  },
  {
    incident: 'INC-20261029-BOX-STOPPED-CREDIT-HOLD', slug: 'inc-20261029-box-stopped-credit-hold', db: true,
    file: 'packages/commercial/src/billing/boxBillingRecovery.integ.test.ts',
    cases: ['late proven Box stops release retained credit reservations without charging'],
  },
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
  {
    incident: 'INC-20261027-STUDIO-COMPOSE-CHANNEL-LAYOUT', slug: 'inc-20261027-studio-compose-channel-layout', db: false,
    file: 'packages/commercial/src/__tests__/studioCompose.test.ts',
    cases: ['the film audio reaches the encoder as fltp 48 kHz stereo, never negotiated (INC-20261027-STUDIO-COMPOSE-CHANNEL-LAYOUT)'],
  },
  {
    incident: 'INC-20261027-STUDIO-RETRY-PROVIDER-EXCLUDED', slug: 'inc-20261027-studio-retry-provider-excluded', db: true,
    file: 'packages/commercial/src/__tests__/studioOrchestrator.integ.test.ts',
    cases: ["after a failed video the user's frame pick retries the same provider (INC-20261027-STUDIO-RETRY-PROVIDER-EXCLUDED)"],
  },
  {
    incident: 'INC-20261027-STUDIO-REGENERATE-REDOES-FRAME', slug: 'inc-20261027-studio-regenerate-redoes-frame', db: true,
    file: 'packages/commercial/src/__tests__/studioAnnotations.integ.test.ts',
    cases: ['keeping the first frame redoes only the video, from the frame on screen (INC-20261027-STUDIO-REGENERATE-REDOES-FRAME)'],
  },
  {
    incident: 'INC-20261027-STUDIO-ADOPT-WRONG-TAKE', slug: 'inc-20261027-studio-adopt-wrong-take', db: false,
    file: 'packages/commercial/src/__tests__/studioInterpret.test.ts',
    cases: ['the version the note is on and the one in use are marked (INC-20261027-STUDIO-ADOPT-WRONG-TAKE)'],
  },
  {
    incident: 'INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY', slug: 'inc-20261027-studio-compose-failed-no-retry', db: true,
    file: 'packages/commercial/src/__tests__/studioComposeFlow.integ.test.ts',
    cases: ['after a failed compose the user can ask the director to compose again, free (INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY)'],
  },
  {
    incident: 'INC-20261029-BOX-LOGIN-EXPIRED-STOP-REASON', slug: 'inc-20261029-box-login-expired-stop-reason', db: false,
    file: 'packages/commercial/src/http/proxy/boxInteractivePrintParity.test.ts',
    cases: ['an API error stand-in is the named upstream refusal on both decoders and a login signal, as on -p'],
  },
  {
    incident: 'INC-20261029-SESSION-WS-BOUNDARY', slug: 'inc-20261029-session-ws-boundary', db: false,
    file: 'packages/gateway/src/__tests__/promptToolRecovery.test.ts',
    cases: ['keeps file search/deletion inside the current conversation unless the user names another one'],
  },
  {
    incident: 'INC-20261114-LOCAL-CATALOG-OWNER', slug: 'inc-20261114-local-catalog-owner', db: false,
    file: 'packages/commercial/src/__tests__/internalModelCatalog.test.ts',
    cases: ['remote_pool CCB rows do not emit local-catalog context_owner while exact Box rows still do (INC-20261114-LOCAL-CATALOG-OWNER)'],
  },
  {
    incident: 'INC-20261114-CATALOG-EPOCH-409', slug: 'inc-20261114-catalog-epoch-409', db: false,
    file: 'packages/commercial/src/__tests__/internalModelCatalog.test.ts',
    cases: ['OCV5-745 catalog response carries projection_algo_version matching epoch endpoint (INC-20261114-CATALOG-EPOCH-409)'],
  },
  {
    incident: 'INC-20261114-CC5-NULL-RECEIPT-DRAIN', slug: 'inc-20261114-cc5-null-receipt-drain', db: false,
    file: 'packages/commercial/src/__tests__/remoteNativeTurnBilling.test.ts',
    cases: ['cc5-native-v1 null-receipt recovery aborts dead crash, rotates still-live turns, and guards completed outcome (INC-20261114-CC5-NULL-RECEIPT-DRAIN)'],
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

/** Real wrapper fault injection: no test-module import and no model/Box launch. */
async function profileAttributionProof(): Promise<string> {
  const nonce = 'a'.repeat(24)
  const cwd = `/tmp/ocv5-289-run-${nonce}`
  const rejected = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n'
  const bytes = Buffer.from(rejected)
  const envelope = JSON.stringify({ offset: bytes.length, data: bytes.toString('base64') })
  let launches = 0
  let reads = 0
  for (const kind of ['unknown', 'missing_nonce', 'raw_stdout', 'known_owner'] as const) {
    const health = new BoxProfileHealth(() => 1_000)
    if (kind === 'known_owner') health.noteRun(nonce, '7:a')
    const request = { command: '/p', args: ['--read', ...(kind === 'missing_nonce' ? [] : [cwd]), '0', '65536'],
      cwd: '/tmp', environment: {} }
    const response = { stdout: kind === 'raw_stdout' ? rejected : envelope,
      stderrBytes: 0, exitCode: 0 as const }
    const seen: unknown[] = []
    const chunks: string[] = []
    const inner: Parameters<typeof scopeBoxExecToProfile>[0] = { run: async (input, opts) => {
      if (isBoxLaunchRequest(input)) { launches++; throw new Error('proof must never launch a model') }
      reads++
      seen.push(input)
      opts?.onStdout?.(response.stdout)
      return response
    } }
    const exec = scopeBoxExecToProfile(inner, { key: '7:default', profile: 'default', health })
    assert.equal(await exec.run(request, { timeoutMs: 1000, maxResponseBytes: 65_536,
      onStdout: (chunk) => chunks.push(chunk) }), response)
    assert.equal(seen[0], request, 'read command and byte offsets must pass through unchanged')
    assert.deepEqual(chunks, [response.stdout], 'caller receives exact stdout')
    assert.equal(health.get('7:default'), undefined, `${kind}: observer health must not be polluted`)
    if (kind === 'known_owner') assert.equal(health.cooldownActive('7:a'), true)
    else assert.equal(health.get('7:a'), undefined)
  }
  assert.equal(reads, 4, 'all real scopedExec fault injections must be reached')
  assert.equal(launches, 0)
  return '[inc-20261102-box-profile-observer-attribution] PASS — unknown observers never poison login health; known owners remain exact; zero launches'
}

async function main(): Promise<void> {
  const dsn = assertTestDsn(process.env.TEST_DATABASE_URL)
  const lines: string[] = [await profileAttributionProof()]
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

if (import.meta.url === `file://${process.argv[1]}`) void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
