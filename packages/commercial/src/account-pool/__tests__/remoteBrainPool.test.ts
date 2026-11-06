import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  formatRemoteModelDisplayName,
  projectPublicModels,
  projectLockedModels,
} from '../../billing/modelPublicProjection.js'
import {
  assertRemoteCcInteractiveRunner,
  boxCcInteractiveLaunchExec,
  loadBoxBridgeMod,
} from '@openclaude/gateway'
import {
  applyRemoteNodeProbeResult,
  buildRemoteNodeInstallCommand,
  computeAggregatedRemoteCatalogState,
  preheatRemotePoolSession,
  rankRemotePoolCandidates,
  toRemotePoolModelId,
  verifyAndMaterializePinnedKnownHosts,
  type RemoteCandidateMember,
} from '../remoteBrainPool.js'

describe('OCV5-721 P1: Remote Brain Pool, CC Interactive Guard & Model Suffix Projection', () => {
  it('formatRemoteModelDisplayName appends " 远端" exactly once for remote_pool models', () => {
    assert.equal(formatRemoteModelDisplayName('Opus 4.7 (1M)', 'local', 'claude-opus-4-7'), 'Opus 4.7 (1M)')
    assert.equal(
      formatRemoteModelDisplayName('Opus 4.7 (1M)', 'remote_pool', 'claude-opus-4-7-remote'),
      'Opus 4.7 (1M) 远端',
    )
    assert.equal(
      formatRemoteModelDisplayName('Opus 4.7 (1M) 远端', 'remote_pool', 'claude-opus-4-7-remote'),
      'Opus 4.7 (1M) 远端',
    )
    assert.equal(
      formatRemoteModelDisplayName('Sonnet 4.6', undefined, 'claude-sonnet-4-6-remote'),
      'Sonnet 4.6 远端',
    )
  })

  it('projectPublicModels & projectLockedModels automatically decorate remote_pool models with " 远端"', () => {
    const row = {
      modelId: 'claude-opus-4-7-remote',
      displayName: 'Opus 4.7 (1M)',
      engine: 'ccb' as const,
      providerId: 'remote-pool:cc',
      upstreamModelId: 'claude-opus-4-7',
      contextWindow: 1_000_000,
      supportsVision: true,
      supportedEfforts: ['low', 'medium', 'high'] as const,
      defaultEffort: 'high' as const,
      sortOrder: 10,
      minPlanCode: 'pro',
      minPlanName: 'Pro',
      promoLabel: null,
      placement: 'remote_pool' as const,
    }
    const pricingMap = new Map([
      [
        'claude-opus-4-7-remote',
        {
          modelId: 'claude-opus-4-7-remote',
          displayName: 'Opus 4.7 (1M)',
          inputPerMtok: 1500n,
          outputPerMtok: 7500n,
          cacheReadPerMtok: 150n,
          cacheWritePerMtok: 1875n,
          multiplier: '1.000',
          enabled: true,
          visibility: 'public' as const,
          sortOrder: 10,
          defaultEffort: 'high' as const,
          minPlanCode: 'pro',
          promoLabel: null,
        },
      ],
    ])
    const snapshot = {
      epoch: 1,
      pricing: pricingMap,
      listForUser: () => [row],
      listLockedForUser: () => [row],
    } as any

    const publicModels = projectPublicModels(
      snapshot,
      { uid: '1', role: 'user', grantedModelIds: new Set(), orgPlanCode: 'pro' },
      new Set(),
    )
    assert.equal(publicModels.length, 1)
    assert.equal(publicModels[0]?.display_name, 'Opus 4.7 (1M) 远端')
    assert.equal(publicModels[0]?.placement, 'remote_pool')

    const lockedModels = projectLockedModels(snapshot, {
      uid: '1',
      role: 'user',
      grantedModelIds: new Set(),
      orgPlanCode: 'free',
    })
    assert.equal(lockedModels.length, 1)
    assert.equal(lockedModels[0]?.display_name, 'Opus 4.7 (1M) 远端')
    assert.equal(lockedModels[0]?.placement, 'remote_pool')
  })

  it('assertRemoteCcInteractiveRunner enforces three-layer anti-print guard for CC', () => {
    const mod = loadBoxBridgeMod()
    // Valid interactive launch should pass
    assert.doesNotThrow(() => {
      assertRemoteCcInteractiveRunner({
        env: { OC_BOX_CC_RUNNER: 'interactive' },
        argv: ['--model', 'claude-opus-4-7', '--dangerously-skip-permissions'],
        modSha256: mod.sha256,
        expectedModSha256: mod.sha256,
        sessionProof: { isInteractive: true },
      })
    })

    // boxCcInteractiveLaunchExec automatically passes the guard
    const spec = boxCcInteractiveLaunchExec(
      {
        fifo: '/tmp/oc-box-cc-sess001.1.fifo',
        cwd: '/workspace',
        remoteClaude: '/home/box/.local/bin/claude',
        execUrl: 'http://127.0.0.1:18799',
        execToken: 'fixture-exec-token',
        networkToken: 'fixture-net-token',
      },
      ['--model', 'claude-opus-4-7'],
      mod,
    )
    assert.equal(spec.command, 'sh')
    assert.equal(spec.environment.OC_BOX_MOD_SHA256, mod.sha256)

    // Forbidden -p / --print / --output-format flags must throw
    for (const flag of ['-p', '--print', '--output-format=stream-json', '--input-format', '--include-partial-messages']) {
      assert.throws(
        () =>
          assertRemoteCcInteractiveRunner({
            env: { OC_BOX_CC_RUNNER: 'interactive' },
            argv: ['--model', 'claude-opus-4-7', flag],
            modSha256: mod.sha256,
          }),
        /REMOTE_CC_PRINT_MODE_FORBIDDEN/,
      )
    }

    // Wrong runner mode env must throw
    assert.throws(
      () =>
        assertRemoteCcInteractiveRunner({
          env: { OC_BOX_CC_RUNNER: 'p' },
          argv: ['--model', 'claude-opus-4-7'],
          modSha256: mod.sha256,
        }),
      /REMOTE_CC_PRINT_MODE_FORBIDDEN/,
    )

    // Wrong mod_sha256 must throw
    assert.throws(
      () =>
        assertRemoteCcInteractiveRunner({
          env: { OC_BOX_CC_RUNNER: 'interactive' },
          argv: ['--model', 'claude-opus-4-7'],
          modSha256: '0'.repeat(64),
          expectedModSha256: mod.sha256,
        }),
      /REMOTE_CC_BRIDGE_MOD_DIGEST_MISMATCH/,
    )

    // Non-interactive runtime check must throw
    assert.throws(
      () =>
        assertRemoteCcInteractiveRunner({
          env: { OC_BOX_CC_RUNNER: 'interactive' },
          argv: ['--model', 'claude-opus-4-7'],
          modSha256: mod.sha256,
          sessionProof: { isInteractive: false },
        }),
      /REMOTE_CC_INTERACTIVE_PROOF_REQUIRED/,
    )
  })

  it('rankRemotePoolCandidates applies WRH affinity, slot watermarks, and RTT penalty', () => {
    const candidates: RemoteCandidateMember[] = [
      {
        profileId: 'prof-a',
        nodeId: 'node-a',
        engine: 'cc',
        profileName: 'default',
        weight: 100,
        healthScore: 100,
        hotSlots: 5,
        activeSlots: 2,
        maxHotSlots: 32,
        maxActiveSlots: 8,
        nodeRttMsP50: 40,
      },
      {
        profileId: 'prof-b-full',
        nodeId: 'node-b',
        engine: 'cc',
        profileName: 'default',
        weight: 100,
        healthScore: 100,
        hotSlots: 10,
        activeSlots: 8,
        maxHotSlots: 32,
        maxActiveSlots: 8,
        nodeRttMsP50: 20,
      },
      {
        profileId: 'prof-c-high-rtt',
        nodeId: 'node-c',
        engine: 'cc',
        profileName: 'default',
        weight: 100,
        healthScore: 100,
        hotSlots: 2,
        activeSlots: 1,
        maxHotSlots: 32,
        maxActiveSlots: 8,
        nodeRttMsP50: 950,
      },
    ]

    const ranked = rankRemotePoolCandidates(candidates, 'user-1:session-1:claude-opus-4-7-remote')
    // Full slot node-b is filtered out
    assert.equal(ranked.length, 2)
    assert.ok(!ranked.some((c) => c.nodeId === 'node-b'))
    // Deterministic ranking for same affinity key
    const rankedAgain = rankRemotePoolCandidates(candidates, 'user-1:session-1:claude-opus-4-7-remote')
    assert.deepEqual(
      ranked.map((r) => r.profileId),
      rankedAgain.map((r) => r.profileId),
    )
  })

  it('toRemotePoolModelId & buildRemoteNodeInstallCommand produce canonical identifiers', () => {
    assert.equal(toRemotePoolModelId('claude-opus-4-7'), 'claude-opus-4-7-remote')
    assert.equal(toRemotePoolModelId('claude-opus-4-7-remote'), 'claude-opus-4-7-remote')
    const cmd = buildRemoteNodeInstallCommand({
      sshUser: 'box',
      keyId: 'oc-remote-pool-key-1',
    })
    assert.ok(cmd.includes('/home/box/.openclaude/bin/oc-remote-hostd.py --serve-mux'))
    assert.ok(cmd.includes('no-pty,no-agent-forwarding,no-X11-forwarding,no-user-rc'))
  })

  it('oc-remote-hostd.py --probe and --self-check execute cleanly and enforce CC interactive mode', () => {
    const scriptPath = resolve(
      import.meta.dirname,
      '../../../../../scripts/agent-remote/oc-remote-hostd.py',
    )
    const probeRaw = execFileSync('python3', [scriptPath, '--probe'], { encoding: 'utf8' })
    const probe = JSON.parse(probeRaw) as {
      ok: boolean
      gate_g: { ok: boolean; cc_print_mode_blocked: boolean }
      profiles: Array<{ engine: string; runner_mode: string }>
    }
    assert.equal(probe.ok, true)
    assert.equal(probe.gate_g.ok, true)
    assert.equal(probe.gate_g.cc_print_mode_blocked, true)
    for (const p of probe.profiles) {
      assert.equal(p.runner_mode, 'interactive')
    }

    const selfCheckRaw = execFileSync('python3', [scriptPath, '--self-check'], { encoding: 'utf8' })
    const selfCheck = JSON.parse(selfCheckRaw) as {
      ok: boolean
      cc_print_mode_blocked: boolean
      credential_paths_isolated: boolean
    }
    assert.equal(selfCheck.ok, true)
    assert.equal(selfCheck.cc_print_mode_blocked, true)
    assert.equal(selfCheck.credential_paths_isolated, true)

    // Verify B6: empty {}, expired seconds/ms, or 0 expiry credential files must never report logged_in=true or models
    const fakeHome = mkdtempSync(join(tmpdir(), 'oc-rpool-hostd-home-'))
    try {
      const claudeDir = join(fakeHome, '.claude')
      const codexDir = join(fakeHome, '.codex')
      execFileSync('mkdir', ['-p', claudeDir, codexDir])
      const nowSec = Math.floor(Date.now() / 1000)

      for (const exp of [(nowSec - 3600) * 1000, nowSec - 3600, 0]) {
        writeFileSync(
          join(claudeDir, '.credentials.json'),
          JSON.stringify({
            claudeAiOauth: { accessToken: 'fixture-only-nonsecret-token', expiresAt: exp },
            available_models: [{ id: 'claude-opus-4-7' }],
          }),
          'utf8',
        )
        writeFileSync(
          join(codexDir, 'auth.json'),
          JSON.stringify({
            access_token: 'fixture-only-nonsecret-token',
            expires_at: exp,
            available_models: [{ id: 'gpt-5.4' }],
          }),
          'utf8',
        )
        const expiredProbe = JSON.parse(
          execFileSync('python3', [scriptPath, '--probe'], {
            encoding: 'utf8',
            env: { ...process.env, HOME: fakeHome },
          }),
        ) as {
          profiles: Array<{ engine: string; logged_in: boolean; discovered_models: unknown[] }>
        }
        for (const p of expiredProbe.profiles) {
          assert.equal(p.logged_in, false, `engine=${p.engine} exp=${exp} must be logged_in=false`)
          assert.deepEqual(p.discovered_models, [])
        }
      }

      // Future timestamp with valid token + available_models succeeds
      const futureMs = (nowSec + 3600) * 1000
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'fixture-only-nonsecret-token', expiresAt: futureMs },
          available_models: [{ id: 'claude-opus-4-7' }],
        }),
        'utf8',
      )
      const validProbe = JSON.parse(
        execFileSync('python3', [scriptPath, '--probe'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: fakeHome },
        }),
      ) as {
        profiles: Array<{ engine: string; logged_in: boolean; discovered_models: unknown[] }>
      }
      const ccProf = validProbe.profiles.find((p) => p.engine === 'cc')
      assert.equal(ccProf?.logged_in, true)
      assert.equal(ccProf?.discovered_models.length, 1)

      // Standard claude login .credentials.json without available_models discovers models directly from the claude CLI
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'fixture-only-nonsecret-token', expiresAt: futureMs },
        }),
        'utf8',
      )
      const defaultModelsProbe = JSON.parse(
        execFileSync('python3', [scriptPath, '--probe'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: fakeHome },
        }),
      ) as {
        profiles: Array<{
          engine: string
          logged_in: boolean
          discovered_models: Array<{ upstream_model_id: string; display_name: string }>
        }>
      }
      const ccDefaultProf = defaultModelsProbe.profiles.find((p) => p.engine === 'cc')
      assert.equal(ccDefaultProf?.logged_in, true)
      assert.ok((ccDefaultProf?.discovered_models.length ?? 0) >= 3)
      assert.ok(
        ccDefaultProf?.discovered_models.some((m) => m.upstream_model_id === 'claude-opus-4-7'),
      )
      assert.ok(
        ccDefaultProf?.discovered_models.some((m) => m.upstream_model_id === 'claude-sonnet-5'),
      )

      // Multi-directory multi-account: distinct accounts in .claude-account2 and .codex-account2 are discovered independently
      const claudeAcc2Dir = join(fakeHome, '.claude-account2')
      const codexAcc2Dir = join(fakeHome, '.codex-account2')
      execFileSync('mkdir', ['-p', claudeAcc2Dir, codexAcc2Dir])
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({
          oauthAccount: { emailAddress: 'alice@example.com' },
          claudeAiOauth: { accessToken: 'fixture-only-nonsecret-token-1', expiresAt: futureMs },
          available_models: [{ id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }],
        }),
        'utf8',
      )
      writeFileSync(
        join(claudeAcc2Dir, '.credentials.json'),
        JSON.stringify({
          oauthAccount: { emailAddress: 'bob@example.com' },
          claudeAiOauth: { accessToken: 'fixture-only-nonsecret-token-2', expiresAt: futureMs },
          available_models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }],
        }),
        'utf8',
      )
      writeFileSync(
        join(codexDir, 'auth.json'),
        JSON.stringify({
          email: 'codex1@example.com',
          access_token: 'fixture-only-nonsecret-token-c1',
          expires_at: futureMs,
          available_models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
        }),
        'utf8',
      )
      writeFileSync(
        join(codexAcc2Dir, 'auth.json'),
        JSON.stringify({
          email: 'codex2@example.com',
          access_token: 'fixture-only-nonsecret-token-c2',
          expires_at: futureMs,
          available_models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }],
        }),
        'utf8',
      )
      const multiProbe = JSON.parse(
        execFileSync('python3', [scriptPath, '--probe'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: fakeHome },
        }),
      ) as {
        profiles: Array<{
          engine: string
          profile_name: string
          logged_in: boolean
          account_fingerprint: string
        }>
      }
      const ccProfs = multiProbe.profiles.filter((p) => p.engine === 'cc' && p.logged_in)
      assert.equal(ccProfs.length, 2)
      assert.deepEqual(
        ccProfs.map((p) => p.profile_name).sort(),
        ['account2', 'default'],
      )
      assert.notEqual(ccProfs[0]?.account_fingerprint, ccProfs[1]?.account_fingerprint)

      const codexProfs = multiProbe.profiles.filter((p) => p.engine === 'codex' && p.logged_in)
      assert.equal(codexProfs.length, 2)
      assert.deepEqual(
        codexProfs.map((p) => p.profile_name).sort(),
        ['account2', 'default'],
      )
      assert.notEqual(codexProfs[0]?.account_fingerprint, codexProfs[1]?.account_fingerprint)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('verifyAndMaterializePinnedKnownHosts pins verified SHA256 host_key_fp and rejects mismatches (B8)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'oc-rpool-test-kh-'))
    try {
      const dummyKeyBytes = Buffer.from('ssh-ed25519-test-public-key-payload-for-ocv5-721')
      const b64Key = dummyKeyBytes.toString('base64')
      const expectedFp = `SHA256:${createHash('sha256').update(dummyKeyBytes).digest('base64').replace(/=+$/, '')}`
      const wrongFp = `SHA256:${'A'.repeat(43)}`
      const candidateKh = join(tmpDir, 'candidate_known_hosts')
      writeFileSync(candidateKh, `198.51.100.42 ssh-ed25519 ${b64Key}\n`, { mode: 0o600 })

      const pinned = await verifyAndMaterializePinnedKnownHosts({
        sshHost: '198.51.100.42',
        sshPort: 22,
        expectedHostKeyFp: expectedFp,
        candidateKnownHostsFiles: [candidateKh],
      })
      try {
        const content = readFileSync(pinned.knownHostsPath, 'utf8')
        assert.equal(content, `198.51.100.42 ssh-ed25519 ${b64Key}\n`)
      } finally {
        pinned.cleanup()
      }

      await assert.rejects(
        () =>
          verifyAndMaterializePinnedKnownHosts({
            sshHost: '198.51.100.42',
            sshPort: 22,
            expectedHostKeyFp: wrongFp,
            candidateKnownHostsFiles: [candidateKh],
          }),
        /REMOTE_NODE_HOST_KEY_FP_MISMATCH/,
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('applyRemoteNodeProbeResult enforces runner_mode=interactive, logged_in, tmux_version and mod_digest (B6 & B8)', async () => {
    const mod = loadBoxBridgeMod()
    // Missing runner_mode is rejected (no default fallback to interactive)
    await assert.rejects(
      () =>
        applyRemoteNodeProbeResult('00000000-0000-0000-0000-000000000001', {
          profiles: [
            {
              engine: 'cc',
              profile_name: 'default',
              account_fingerprint: 'fp-1',
              tmux_version: 'tmux 3.4',
              mod_digest: mod.sha256,
              discovered_models: [{ upstream_model_id: 'claude-opus-4-7', display_name: 'Opus 4.7' }],
            },
          ],
        }),
      /REMOTE_CC_PRINT_MODE_FORBIDDEN/,
    )

    // Unauthenticated profile (logged_in: false) is rejected
    await assert.rejects(
      () =>
        applyRemoteNodeProbeResult('00000000-0000-0000-0000-000000000001', {
          profiles: [
            {
              engine: 'cc',
              profile_name: 'default',
              account_fingerprint: 'fp-1',
              runner_mode: 'interactive',
              logged_in: false,
              tmux_version: 'tmux 3.4',
              mod_digest: mod.sha256,
              discovered_models: [{ upstream_model_id: 'claude-opus-4-7', display_name: 'Opus 4.7' }],
            },
          ],
        }),
      /REMOTE_PROFILE_NOT_LOGGED_IN/,
    )

    // CC profile without tmux_version is rejected
    await assert.rejects(
      () =>
        applyRemoteNodeProbeResult('00000000-0000-0000-0000-000000000001', {
          profiles: [
            {
              engine: 'cc',
              profile_name: 'default',
              account_fingerprint: 'fp-1',
              runner_mode: 'interactive',
              logged_in: true,
              mod_digest: mod.sha256,
              discovered_models: [{ upstream_model_id: 'claude-opus-4-7', display_name: 'Opus 4.7' }],
            },
          ],
        }),
      /REMOTE_CC_TMUX_REQUIRED/,
    )

    // CC profile with wrong mod_digest is rejected
    await assert.rejects(
      () =>
        applyRemoteNodeProbeResult('00000000-0000-0000-0000-000000000001', {
          profiles: [
            {
              engine: 'cc',
              profile_name: 'default',
              account_fingerprint: 'fp-1',
              runner_mode: 'interactive',
              logged_in: true,
              tmux_version: 'tmux 3.4',
              mod_digest: 'f'.repeat(64),
              discovered_models: [{ upstream_model_id: 'claude-opus-4-7', display_name: 'Opus 4.7' }],
            },
          ],
        }),
      /REMOTE_CC_BRIDGE_MOD_DIGEST_MISMATCH/,
    )
  })

  it('computeAggregatedRemoteCatalogState aggregates multi-node offers and preserves global admin disable (B7 & B9)', () => {
    // 1. When execution backend is not enabled, new offers stay staged (not active)
    assert.deepEqual(
      computeAggregatedRemoteCatalogState({
        prevActiveOfferCount: 0,
        nextActiveOfferCount: 1,
        existingCatalogState: null,
        executionEnabled: false,
      }),
      {
        catalogState: 'staged',
        pricingEnabled: false,
        globalAdminDisabled: false,
      },
    )

    // 2. When execution backend is enabled and >=1 offer is active, model becomes active
    assert.deepEqual(
      computeAggregatedRemoteCatalogState({
        prevActiveOfferCount: 0,
        nextActiveOfferCount: 2,
        existingCatalogState: 'staged',
        executionEnabled: true,
      }),
      {
        catalogState: 'active',
        pricingEnabled: true,
        globalAdminDisabled: false,
      },
    )

    // 3. Disabling one node's offer when another node still serves the same model keeps catalog active
    assert.deepEqual(
      computeAggregatedRemoteCatalogState({
        prevActiveOfferCount: 2,
        nextActiveOfferCount: 1,
        existingCatalogState: 'active',
        executionEnabled: true,
      }),
      {
        catalogState: 'active',
        pricingEnabled: true,
        globalAdminDisabled: false,
      },
    )

    // 4. Disabling the last remaining offer transitions catalog to disabled
    assert.deepEqual(
      computeAggregatedRemoteCatalogState({
        prevActiveOfferCount: 1,
        nextActiveOfferCount: 0,
        existingCatalogState: 'active',
        executionEnabled: true,
      }),
      {
        catalogState: 'disabled',
        pricingEnabled: false,
        globalAdminDisabled: false,
      },
    )

    // 5. Global catalog admin disable is never overridden by a single profile offer update, even across 1 -> 0 -> 1 transitions (W1)
    assert.deepEqual(
      computeAggregatedRemoteCatalogState({
        prevActiveOfferCount: 1,
        nextActiveOfferCount: 2,
        existingCatalogState: 'disabled',
        executionEnabled: true,
      }),
      {
        catalogState: 'disabled',
        pricingEnabled: false,
        globalAdminDisabled: true,
      },
    )
    const afterLastOfferRemovedWhileAdminDisabled = computeAggregatedRemoteCatalogState({
      prevActiveOfferCount: 1,
      nextActiveOfferCount: 0,
      existingCatalogState: 'disabled',
      executionEnabled: true,
    })
    assert.deepEqual(afterLastOfferRemovedWhileAdminDisabled, {
      catalogState: 'disabled',
      pricingEnabled: false,
      globalAdminDisabled: true,
    })
    const afterOfferReenabledWhileAdminDisabled = computeAggregatedRemoteCatalogState({
      prevActiveOfferCount: 0,
      nextActiveOfferCount: 1,
      existingCatalogState: afterLastOfferRemovedWhileAdminDisabled.catalogState,
      executionEnabled: true,
    })
    assert.deepEqual(afterOfferReenabledWhileAdminDisabled, {
      catalogState: 'disabled',
      pricingEnabled: false,
      globalAdminDisabled: true,
    })

    // 6. Pool auto-disabled catalog entry (poolAutoDisabled: true) recovers when an active offer returns
    assert.deepEqual(
      computeAggregatedRemoteCatalogState({
        prevActiveOfferCount: 0,
        nextActiveOfferCount: 1,
        existingCatalogState: 'disabled',
        executionEnabled: true,
        poolAutoDisabled: true,
      }),
      {
        catalogState: 'active',
        pricingEnabled: true,
        globalAdminDisabled: false,
      },
    )

    // 7. Admin activate/disable stored procedures in 0333_remote_agent_pool.sql explicitly reset pool_auto_disabled = FALSE (W1)
    const migSql = readFileSync(
      resolve(import.meta.dirname, '../../db/migrations/0333_remote_agent_pool.sql'),
      'utf8',
    )
    assert.match(
      migSql,
      /CREATE OR REPLACE FUNCTION fn_model_activate_entry[\s\S]*?SET state = 'active',\s*pool_auto_disabled = FALSE/,
    )
    assert.match(
      migSql,
      /CREATE OR REPLACE FUNCTION fn_model_disable_entry[\s\S]*?SET state = 'disabled',\s*pool_auto_disabled = FALSE/,
    )
  })

  it('preheatRemotePoolSession honestly reports REMOTE_POOL_EXECUTION_DISABLED when execution is gated off (B7)', async () => {
    const prev = process.env.OC_REMOTE_POOL_EXECUTION_ENABLED
    process.env.OC_REMOTE_POOL_EXECUTION_ENABLED = '0'
    try {
      const res = await preheatRemotePoolSession({
        uid: '1001',
        sessionKey: 'sess-1',
        canonicalModelId: 'claude-opus-4-7-remote',
      })
      assert.equal(res.preheated, false)
      assert.equal(res.reason, 'REMOTE_POOL_EXECUTION_DISABLED')
    } finally {
      if (prev !== undefined) {
        process.env.OC_REMOTE_POOL_EXECUTION_ENABLED = prev
      } else {
        delete process.env.OC_REMOTE_POOL_EXECUTION_ENABLED
      }
    }
  })
})
