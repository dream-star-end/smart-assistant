import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  formatRemoteModelDisplayName,
  projectPublicModels,
  projectLockedModels,
} from '../../billing/modelPublicProjection.js'
import type { ModelRow } from '../../billing/modelCatalog.js'
import {
  assertRemoteCcInteractiveRunner,
  boxCcInteractiveLaunchExec,
  loadBoxBridgeMod,
} from '@openclaude/gateway'
import {
  buildRemoteNodeInstallCommand,
  rankRemotePoolCandidates,
  toRemotePoolModelId,
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

    const publicModels = projectPublicModels(snapshot, { isAdmin: false, planCode: 'pro' }, new Set())
    assert.equal(publicModels.length, 1)
    assert.equal(publicModels[0]?.display_name, 'Opus 4.7 (1M) 远端')
    assert.equal(publicModels[0]?.placement, 'remote_pool')

    const lockedModels = projectLockedModels(snapshot, { isAdmin: false, planCode: 'free' })
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
  })
})
