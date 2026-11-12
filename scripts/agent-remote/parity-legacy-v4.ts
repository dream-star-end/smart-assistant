/**
 * `OCV5-749` `AC-4` (`C3`) Same-Node / Same-Account / Same-Model Legacy 746 vs v4 Parity Runner.
 *
 * Executes side-by-side live runs on:
 *   1. `99.144.122.98` (`cc`, profile `default`, `claude-opus-5-5-remote` -> `claude-opus-5-5`):
 *      - Legacy 746 lane: `placeRemoteLane` + `Cc5SshHost` + `Cc5Relay` + `Cc5InteractiveAdapter` +
 *        `runCc5StdioBridge` + `Cc5ToolHost` + `createRemoteNativeTurnFinance`.
 *      - Driver Core v4 lane: `placeRemoteDriverLane` + `RemotePoolSshHost` + `RemotePoolRelay` +
 *        `RemoteEngineAdapter` + `Cc5ToolHost` + `createRemoteDriverTurnFinance`.
 *   2. `136.86.253.46` (`codex`, profile `default`, `gpt-6-luna-remote` -> `gpt-6-luna`):
 *      - Legacy 746 lane: `placeRemoteLane` + `CodexSshHost` + `CodexRemoteRelay` +
 *        `CodexRemoteAdapter` + `Cc5ToolHost` + `createRemoteNativeTurnFinance`.
 *      - Driver Core v4 lane: `placeRemoteDriverLane` + `RemotePoolSshHost` + `RemotePoolRelay` +
 *        `RemoteEngineAdapter` + `Cc5ToolHost` + `createRemoteDriverTurnFinance`.
 *
 * Each lane runs an identical 2-turn prompt structure:
 *   - Turn 1: `Write` sentinel file inside the container workspace (`Cc5ToolHost`) + remember `<nonce>`.
 *   - Turn 2: Warm native resume on the same session recalling `<nonce>` with zero tool calls.
 *
 * Records & verifies side-by-side:
 *   - TTFT (`includesLiveNetworkAndModelVariance: true`) & turn duration
 *   - Final text & SHA-256
 *   - Tool call sequence & container sentinel file contents
 *   - Turn 1 -> Turn 2 `nativeSessionId` preservation & `<nonce>` recall
 *   - Independent remote stop proof (`STOPPED.json` / systemd cgroup scopes)
 *   - `usage_records.cost_credits` & exact `computeCost(usage, pricing)` verification
 *   - Item-by-item diff explanation
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import type { Pool } from 'pg'
import {
  CC5_INTERACTIVE_BACKEND,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  parseCc5ExecutionBackend,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type TurnLease,
} from '@openclaude/protocol'
import {
  CC5_BINDING_SLIDING_TTL_MS,
  cc5ControlRequest,
  type Cc5BridgeBinding,
  type Cc5BridgePort,
} from '../../packages/gateway/src/cc5BridgePort.js'
import { Cc5Relay } from '../../packages/gateway/src/cc5Relay.js'
import { Cc5SshHost, type Cc5SshHostConfig } from '../../packages/gateway/src/cc5SshHost.js'
import { readCc5LaneProfile, runCc5StdioBridge } from '../../packages/gateway/src/cc5StdioBridge.js'
import { Cc5ToolHost } from '../../packages/gateway/src/cc5ToolHost.js'
import {
  codexBackend,
  codexJsonHash,
  type CodexRemoteBinding,
} from '../../packages/gateway/src/codexRemoteContract.js'
import { CodexSshHost } from '../../packages/gateway/src/codexRemoteHost.js'
import { CodexRemoteRelay } from '../../packages/gateway/src/codexRemoteRelay.js'
import { Cc5InteractiveAdapter } from '../../packages/gateway/src/engine/cc5InteractiveAdapter.js'
import { parseCc5ResumeId } from '../../packages/gateway/src/engine/cc5ResumeId.js'
import { CodexRemoteAdapter } from '../../packages/gateway/src/engine/codexAdapter.js'
import type { TurnParams } from '../../packages/gateway/src/engine/engineAdapter.js'
import type { EngineCreateOpts } from '../../packages/gateway/src/engine/registry.js'
import {
  BOX_NATIVE_CONTEXT_OWNER,
  __setCcbSpawnForTests,
} from '../../packages/gateway/src/subprocessRunner.js'
import {
  placeRemoteLane,
  recordRemoteLaneState,
  recordRemoteNativeThread,
  recordRemoteStartAttempt,
} from '../../packages/commercial/src/account-pool/remoteBrainPool.js'
import { computeCost } from '../../packages/commercial/src/billing/calculator.js'
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
} from '../../packages/commercial/src/billing/modelCatalog.js'
import { wrapIoredisForPreCheck } from '../../packages/commercial/src/billing/preCheck.js'
import { createRemoteNativeTurnFinance } from '../../packages/commercial/src/billing/remoteNativeTurnBilling.js'
import { createLogger } from '../../packages/commercial/src/logging/logger.js'
import {
  PRICING_RATES,
  createConformanceHarness,
  type LiveNodeConfig,
} from './conformance/harness.js'

const CC5_CONTROLLER_PATH = fileURLToPath(
  new URL('./cc5-host-controller.py', import.meta.url),
)

const CC_INTERSECTION_UPSTREAM_MODEL = 'claude-opus-5-5'
const CC_INTERSECTION_CANONICAL_MODEL = 'claude-opus-5-5-remote'

const SHARED_PARITY_ADAPTER_CONFIG = Object.freeze({
  version: 1,
  terminal: { type: 'local' },
  provider: 'anthropic',
  mcpServers: [],
  auth: { mode: 'subscription', claudeCodePath: '' },
  gateway: { bind: '127.0.0.1', port: 18790, accessToken: 'parity-token' },
  channels: { webchat: { enabled: false } },
  sessions: { dbPath: '' },
  defaults: { permissionMode: 'bypassPermissions' },
})

export interface LaneObservedTargetAudit {
  readonly sshHost: string
  readonly sshPort: number
  readonly sshUser: string
  readonly profileName: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly pricingRatesFenPerMtok: {
    readonly input: string
    readonly output: string
    readonly cacheRead: string
    readonly cacheWrite: string
  }
  readonly dispatchedInstructionsSha256: string
  readonly dispatchedInstructionsBytes: number
  readonly dispatchedToolCatalogSha256: string
  readonly dispatchedToolCount: number
  readonly turn1UserPromptSha256: string
  readonly turn2UserPromptSha256: string
}

interface UsageAuditRecord {
  readonly requestId: string
  readonly status: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costCreditsFen: string
  readonly expectedCostCreditsFen: string
  readonly costMatchesUsageFormula: boolean
}

interface TurnParityObservation {
  readonly requestId: string
  readonly ttftMs: number
  readonly includesLiveNetworkAndModelVariance: true
  readonly turnDurationMs: number
  readonly finalText: string
  readonly finalTextSha256: string
  readonly toolCallSequence: ReadonlyArray<{
    readonly name: string
    readonly filePathMatchesSentinel: boolean
  }>
  readonly nativeSessionId: string
  readonly usageRecord: UsageAuditRecord
}

export interface LaneParityEvidence {
  readonly backendKind: string
  readonly operationId: string
  readonly taskRoot: string
  readonly observedTarget: LaneObservedTargetAudit
  readonly turn1: TurnParityObservation & {
    readonly sentinelVerified: boolean
  }
  readonly turn2Resume: TurnParityObservation & {
    readonly recalledSecretNonce: boolean
    readonly resumedSameNativeSession: boolean
  }
  readonly totalChargedFen: string
  readonly stopProof: unknown
}

export interface EngineSameNodeParityReport {
  readonly engine: 'cc' | 'codex'
  readonly passed: boolean
  readonly conditions: {
    readonly targetHost: string
    readonly sshPort: number
    readonly sshUser: string
    readonly profileName: string
    readonly canonicalModel: string
    readonly upstreamModel: string
    readonly sameNodeVerified: boolean
    readonly sameAccountVerified: boolean
    readonly sameModelVerified: boolean
    readonly samePromptStructureVerified: boolean
    readonly samePricingSnapshotVerified: boolean
  }
  readonly legacy746: LaneParityEvidence
  readonly v4: LaneParityEvidence
  readonly sideBySideComparison: {
    readonly wirePromptParity: {
      readonly legacyInstructionsSha256: string
      readonly v4InstructionsSha256: string
      readonly instructionsSha256Matched: boolean
      readonly legacyInstructionsBytes: number
      readonly v4InstructionsBytes: number
      readonly legacyToolCatalogSha256: string
      readonly v4ToolCatalogSha256: string
      readonly toolCatalogSha256Matched: boolean
      readonly turn1UserPromptSha256Matched: boolean
      readonly turn2UserPromptSha256Matched: boolean
    }
    readonly ttft: {
      readonly includesLiveNetworkAndModelVariance: true
      readonly legacyTurn1Ms: number
      readonly v4Turn1Ms: number
      readonly legacyTurn2Ms: number
      readonly v4Turn2Ms: number
      readonly explanation: string
    }
    readonly finalContent: {
      readonly legacyTurn1Text: string
      readonly v4Turn1Text: string
      readonly legacyTurn2RecalledNonce: boolean
      readonly v4Turn2RecalledNonce: boolean
      readonly explanation: string
    }
    readonly toolExecution: {
      readonly legacyTurn1Tools: readonly string[]
      readonly v4Turn1Tools: readonly string[]
      readonly legacyTurn2Tools: readonly string[]
      readonly v4Turn2Tools: readonly string[]
      readonly bothContainerSentinelsVerified: boolean
      readonly explanation: string
    }
    readonly sessionResume: {
      readonly legacyNativeSessionId: string
      readonly v4NativeSessionId: string
      readonly legacyResumedSameSession: boolean
      readonly v4ResumedSameSession: boolean
      readonly explanation: string
    }
    readonly stopProof: {
      readonly legacyRemoteStopped: boolean
      readonly v4RemoteStopped: boolean
      readonly explanation: string
    }
    readonly billing: {
      readonly pricingRatesFenPerMtok: {
        readonly input: string
        readonly output: string
        readonly cacheRead: string
        readonly cacheWrite: string
      }
      readonly legacyTotalChargedFen: string
      readonly v4TotalChargedFen: string
      readonly costRatioV4ToLegacy: number
      readonly relativeCostDeltaPct: number
      readonly turn1TotalContextTokens: {
        readonly legacy: number
        readonly v4: number
      }
      readonly tokenRateDeltaDecompositionFen: {
        readonly inputDeltaFen: number
        readonly outputDeltaFen: number
        readonly cacheReadDeltaFen: number
        readonly cacheWriteDeltaFen: number
        readonly roundingDeltaFen: number
        readonly cacheNeutralLegacyFen: number
        readonly cacheNeutralV4Fen: number
        readonly cacheNeutralRelativeDeltaPct: number
        readonly manualReviewRequired: boolean
      }
      readonly bothMatchExactComputeCostFormula: boolean
      readonly explanation: string
    }
  }
}

function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function buildParityTurn1Prompt(sentinelPath: string, sentinelContent: string, nonce: string): string {
  return [
    `We are running an automated software parity verification test of the workspace Write tool. Please create the plain-text verification fixture file using Write with exact arguments ${JSON.stringify({ file_path: sentinelPath, content: sentinelContent })}.`,
    `Call Write once without calling any other tool. Remember the verification token ${nonce} for the next turn, and reply ONLY with DONE after Write succeeds.`,
  ].join('\n')
}

function buildParityTurn2Prompt(): string {
  return 'Without calling any tool, reply ONLY with the exact token from Turn 1 and nothing else.'
}

function readSelfhostReadOnlyJson<T>(sqlRowExpr: string): T {
  const query = `SELECT row_to_json(t)::text FROM (${sqlRowExpr}) t`
  const cmd =
    process.getuid?.() === 0
      ? ['runuser', '-u', 'postgres', '--', 'psql', '-d', 'openclaude_v5_selfhost', '-Atc', query]
      : ['psql', '-d', 'openclaude_v5_selfhost', '-Atc', query]
  const res = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: 10_000 })
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(
      `Read-only openclaude_v5_selfhost lookup failed (exit=${res.status}): ${res.stderr}`,
    )
  }
  return JSON.parse(res.stdout.trim().split('\n')[0]!) as T
}

function runAdminRemoteNodePy(
  cfg: LiveNodeConfig,
  pyBody: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const prefix = cfg.adminRunAsUserPrefix ? `${cfg.adminRunAsUserPrefix} ` : ''
  const pyB64 = Buffer.from(pyBody, 'utf8').toString('base64')
  const remoteCmd = `${prefix}/usr/bin/python3 -I -B -c "import base64; exec(base64.b64decode('${pyB64}').decode('utf-8'))"`
  const res = spawnSync('/bin/bash', ['-lc', `${cfg.adminSshCmd} ${JSON.stringify(remoteCmd)}`], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (res.status !== 0) {
    throw new Error(`Admin remote node op failed (exit=${res.status}): ${res.stderr}`)
  }
  const lastLine = res.stdout.trim().split('\n').at(-1) ?? '{}'
  return JSON.parse(lastLine) as Record<string, unknown>
}

const REMOTE_READ_AND_CLEANUP_PY = `
import json, pathlib, shutil, sys
req = json.loads(sys.stdin.read())
op = req["op"]
root = pathlib.Path(req["root"])
if op == "read_stopped_and_cleanup":
    p = root / "STOPPED.json"
    stopped = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    if root.exists() and not root.is_symlink():
        shutil.rmtree(root, ignore_errors=True)
    lk = root.parent / ("." + root.name + ".create.lock")
    if lk.exists() and not lk.is_symlink():
        try:
            lk.unlink()
        except OSError:
            pass
    print(json.dumps({"stopped": stopped, "cleaned": not root.exists()}))
elif op == "cleanup_only":
    if root.exists() and not root.is_symlink():
        shutil.rmtree(root, ignore_errors=True)
    lk = root.parent / ("." + root.name + ".create.lock")
    if lk.exists() and not lk.is_symlink():
        try:
            lk.unlink()
        except OSError:
            pass
    print(json.dumps({"cleaned": not root.exists()}))
else:
    raise ValueError("unknown op " + str(op))
`

async function readAndVerifyUsageRecord(
  pool: Pool,
  uid: string,
  requestId: string,
  canonicalModel: string,
): Promise<UsageAuditRecord> {
  const res = await pool.query<{
    status: string
    input_tokens: string
    output_tokens: string
    cache_read_tokens: string
    cache_write_tokens: string
    cost_credits: string
  }>(
    `SELECT status,
            input_tokens::text,
            output_tokens::text,
            cache_read_tokens::text,
            cache_write_tokens::text,
            cost_credits::text
       FROM usage_records
      WHERE user_id = $1 AND request_id = $2`,
    [uid, requestId],
  )
  assert.equal(res.rows.length, 1, `Expected 1 usage_records row for ${requestId}`)
  const row = res.rows[0]!
  const inputTokens = Number(row.input_tokens)
  const outputTokens = Number(row.output_tokens)
  const cacheReadTokens = Number(row.cache_read_tokens)
  const cacheWriteTokens = Number(row.cache_write_tokens)
  const expected = computeCost(
    {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
    },
    {
      model_id: canonicalModel,
      display_name: canonicalModel,
      input_per_mtok: PRICING_RATES.inputPerMtok,
      output_per_mtok: PRICING_RATES.outputPerMtok,
      cache_read_per_mtok: PRICING_RATES.cacheReadPerMtok,
      cache_write_per_mtok: PRICING_RATES.cacheWritePerMtok,
      multiplier: '1.000',
      enabled: true,
      sort_order: 100,
      visibility: 'public',
      extra_system_prompt: null,
      default_effort: null,
      updated_at: new Date(),
    },
  )
  const expectedFen = row.status === 'success' ? expected.cost_credits.toString() : '0'
  assert.equal(
    row.cost_credits,
    expectedFen,
    `usage_records.cost_credits (${row.cost_credits}) must equal computeCost (${expectedFen}) for ${requestId}`,
  )
  return {
    requestId,
    status: row.status,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costCreditsFen: row.cost_credits,
    expectedCostCreditsFen: expectedFen,
    costMatchesUsageFormula: row.cost_credits === expectedFen,
  }
}

function createLegacyFinanceSetup(input: {
  pool: Pool
  preCheckRedis: ReturnType<typeof wrapIoredisForPreCheck>
  canonicalModel: string
  upstreamModel: string
  engine: 'ccb' | 'codex'
}): {
  keyId: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  keyring: AuthorityKeyring
  catalog: ModelCatalogSnapshot
  finance: ReturnType<typeof createRemoteNativeTurnFinance>
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = `mak1_parity_${input.engine}_01`
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const keyring: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(pubJwk.x, 'base64url'))],
  ])
  const cap = {
    supportsVision: false,
    reasoning: {
      supported: ['low', 'medium', 'high'] as const,
      codexModelDefault: input.engine === 'codex' ? ('medium' as const) : null,
    },
    ccb: {
      capabilityZero: false,
      supportsThinking: true,
      ...(input.engine === 'ccb' ? { contextOwner: BOX_NATIVE_CONTEXT_OWNER } : {}),
    },
  }
  const entry: ModelCatalogEntry = {
    entryId: 101,
    modelId: input.canonicalModel,
    engine: input.engine,
    providerId: input.engine === 'codex' ? 'codex' : 'anthropic',
    placement: 'remote_pool',
    upstreamModelId: input.upstreamModel,
    contextWindow: 200_000,
    capabilityProfile: cap,
    capabilitySchemaVersion: 1,
    state: 'active',
    lockVersion: 0,
  }
  const catalog = new ModelCatalogSnapshot({
    entries: [entry],
    aliases: new Map(),
    securityEpoch: 7n,
    pricing: new Map([
      [
        input.canonicalModel,
        {
          modelId: input.canonicalModel,
          displayName: input.canonicalModel,
          inputPerMtok: PRICING_RATES.inputPerMtok,
          outputPerMtok: PRICING_RATES.outputPerMtok,
          cacheReadPerMtok: PRICING_RATES.cacheReadPerMtok,
          cacheWritePerMtok: PRICING_RATES.cacheWritePerMtok,
          multiplier: '1.000',
          visibility: 'public',
          sortOrder: 100,
          defaultEffort: input.engine === 'codex' ? 'medium' : null,
        },
      ],
    ]),
  })
  const finance = createRemoteNativeTurnFinance({
    pool: input.pool,
    preCheckRedis: input.preCheckRedis,
    catalog: { assertFresh: async () => catalog } as unknown as ModelCatalogCache,
    keyring,
    loadUserModelAuthz: async (userId) => ({
      uid: userId,
      role: 'user',
      grantedModelIds: new Set<string>(),
      deniedModelIds: new Set<string>(),
      userPlanTier: null,
      orgPlanCode: null,
    }),
    log: createLogger({ out: () => {} }),
    upstreamModel: input.upstreamModel,
  })
  return { keyId, privateKey, keyring, catalog, finance }
}

async function runV4TwoTurnParityLane(
  h: Awaited<ReturnType<typeof createConformanceHarness>>,
  nonce: string,
  sharedParityCwd: string,
  effortLevel?: string,
): Promise<LaneParityEvidence> {
  rmSync(sharedParityCwd, { recursive: true, force: true })
  mkdirSync(sharedParityCwd, { recursive: true, mode: 0o700 })
  const lane = await h.openLane({
    dedicatedToolHost: true,
    writeOnlyTools: true,
    useRealPlatformContext: true,
    cwdOverride: sharedParityCwd,
    adapterConfig: SHARED_PARITY_ADAPTER_CONFIG as unknown as Record<string, unknown>,
    ...(effortLevel ? { effortLevel } : {}),
  })
  try {
    const sentinelPath = join(lane.containerCwd, 'parity-sentinel.txt')
    const sentinelContent = `parity-${nonce}`
    const turn1Prompt = buildParityTurn1Prompt(sentinelPath, sentinelContent, nonce)
    const turn2Prompt = buildParityTurn2Prompt()

    // Turn 1
    const t1Start = performance.now()
    const turn1 = await lane.submitTurn(turn1Prompt)
    const summary1 = await turn1.run.summary
    const t1End = performance.now()
    const ttft1Ms = Number(((turn1.getFirstContentEventAt() ?? t1End) - t1Start).toFixed(2))
    const dur1Ms = Number((t1End - t1Start).toFixed(2))

    assert.ok(summary1, 'v4 Turn 1 summary missing')
    assert.equal(summary1.isError, false, `v4 Turn 1 failed: ${summary1.errorDetail ?? ''}`)
    const sentinelVerified = readFileSync(sentinelPath, 'utf8') === sentinelContent
    assert.equal(sentinelVerified, true, 'v4 Turn 1 sentinel file content mismatch')
    assert.equal(lane.executedCalls.length, 1, 'v4 Turn 1 must execute exactly 1 container tool')
    assert.equal(lane.executedCalls[0]?.name, 'Write')
    const nativeSession1 = lane.settledReceipts[0]?.nativeSessionId ?? ''
    assert.ok(nativeSession1.length > 0, 'v4 Turn 1 must bind non-empty nativeSessionId')
    const wireAudit = lane.getDispatchedWirePromptAudit()
    assert.ok(wireAudit, 'v4 lane must capture /admit wire prompt and catalog audit')
    assert.ok(
      wireAudit.instructionsBytes > 4096,
      `v4 wire instructions must carry full platform prompt (>4 KiB, got ${wireAudit.instructionsBytes} B)`,
    )
    const usage1 = await readAndVerifyUsageRecord(
      h.pool,
      h.uid,
      turn1.requestId,
      h.canonicalModel,
    )

    // Turn 2 (warm native resume)
    const t2Start = performance.now()
    const turn2 = await lane.submitTurn(turn2Prompt)
    const summary2 = await turn2.run.summary
    const t2End = performance.now()
    const ttft2Ms = Number(((turn2.getFirstContentEventAt() ?? t2End) - t2Start).toFixed(2))
    const dur2Ms = Number((t2End - t2Start).toFixed(2))

    assert.ok(summary2, 'v4 Turn 2 summary missing')
    assert.equal(summary2.isError, false, `v4 Turn 2 failed: ${summary2.errorDetail ?? ''}`)
    assert.equal(lane.executedCalls.length, 1, 'v4 Turn 2 must execute 0 tools')
    const recalledNonce = summary2.assistantText.includes(nonce)
    assert.equal(
      recalledNonce,
      true,
      `v4 Turn 2 must recall exact nonce ${nonce}, got: ${summary2.assistantText}`,
    )
    const nativeSession2 = lane.settledReceipts[1]?.nativeSessionId ?? ''
    assert.equal(
      nativeSession2,
      nativeSession1,
      'v4 Turn 2 must resume the exact same nativeSessionId',
    )
    const usage2 = await readAndVerifyUsageRecord(
      h.pool,
      h.uid,
      turn2.requestId,
      h.canonicalModel,
    )

    await lane.closeLane()
    const stopProof = lane.getStopEvidence()
    assert.ok(stopProof, 'v4 closeLane must record independent verifiedStopEvidence')

    const totalFen = (BigInt(usage1.costCreditsFen) + BigInt(usage2.costCreditsFen)).toString()
    return {
      backendKind: 'remote-driver-v4',
      operationId: lane.placed.binding.operationId,
      taskRoot: lane.placed.spec.manifest.root,
      observedTarget: {
        sshHost: lane.placed.sshTarget.host,
        sshPort: lane.placed.sshTarget.port,
        sshUser: lane.placed.sshTarget.user,
        profileName: lane.placed.binding.profileId,
        canonicalModel: lane.placed.binding.canonicalModel,
        upstreamModel: lane.placed.binding.upstreamModel,
        pricingRatesFenPerMtok: {
          input: PRICING_RATES.inputPerMtok.toString(),
          output: PRICING_RATES.outputPerMtok.toString(),
          cacheRead: PRICING_RATES.cacheReadPerMtok.toString(),
          cacheWrite: PRICING_RATES.cacheWritePerMtok.toString(),
        },
        dispatchedInstructionsSha256: wireAudit.instructionsSha256,
        dispatchedInstructionsBytes: wireAudit.instructionsBytes,
        dispatchedToolCatalogSha256: wireAudit.toolCatalogSha256,
        dispatchedToolCount: wireAudit.toolCount,
        turn1UserPromptSha256: sha256Utf8(turn1Prompt),
        turn2UserPromptSha256: sha256Utf8(turn2Prompt),
      },
      turn1: {
        requestId: turn1.requestId,
        ttftMs: ttft1Ms,
        includesLiveNetworkAndModelVariance: true,
        turnDurationMs: dur1Ms,
        finalText: summary1.assistantText.trim(),
        finalTextSha256: sha256Utf8(summary1.assistantText.trim()),
        toolCallSequence: lane.executedCalls.map((c) => ({
          name: c.name,
          filePathMatchesSentinel: c.args.file_path === sentinelPath,
        })),
        nativeSessionId: nativeSession1,
        usageRecord: usage1,
        sentinelVerified,
      },
      turn2Resume: {
        requestId: turn2.requestId,
        ttftMs: ttft2Ms,
        includesLiveNetworkAndModelVariance: true,
        turnDurationMs: dur2Ms,
        finalText: summary2.assistantText.trim(),
        finalTextSha256: sha256Utf8(summary2.assistantText.trim()),
        toolCallSequence: [],
        nativeSessionId: nativeSession2,
        usageRecord: usage2,
        recalledSecretNonce: recalledNonce,
        resumedSameNativeSession: nativeSession2 === nativeSession1,
      },
      totalChargedFen: totalFen,
      stopProof,
    }
  } finally {
    await lane.closeLane().catch(() => {})
  }
}

class InProcessBridgeProc extends EventEmitter {
  pid: number | undefined = undefined
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private closed = false

  constructor(private readonly onKill: () => void) {
    super()
  }

  markBridgeFinished(code = 0): void {
    if (this.closed) return
    this.closed = true
    try {
      this.stdout.end()
      this.stderr.end()
    } catch {
      /* ignore */
    }
    setImmediate(() => {
      this.stdout.destroy()
      this.stderr.destroy()
      this.emit('exit', code, null)
      this.emit('close', code, null)
    })
  }

  kill(): boolean {
    this.onKill()
    this.markBridgeFinished()
    return true
  }
}

async function runLegacy746CcTwoTurnParityLane(input: {
  pool: Pool
  preCheckRedis: ReturnType<typeof wrapIoredisForPreCheck>
  liveCfg: LiveNodeConfig
  nonce: string
  sharedParityCwd: string
}): Promise<LaneParityEvidence> {
  const { pool, preCheckRedis, liveCfg, nonce, sharedParityCwd } = input
  const selfhostNode = readSelfhostReadOnlyJson<{
    key_id: string
    host_key_fp: string
    ssh_port: number
    ssh_user: string
  }>(
    `SELECT n.key_id, n.host_key_fp, n.ssh_port, n.ssh_user
       FROM remote_agent_nodes n
       JOIN remote_agent_profiles p ON p.node_id = n.id
      WHERE n.ssh_host = ${`'${liveCfg.sshHost.replaceAll("'", "''")}'`}
        AND p.engine = 'cc'
        AND p.profile_name = 'default'
      LIMIT 1`,
  )

  const legacyUid = (
    await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, credits)
       VALUES ($1, 'parity-legacy-cc', 100000000000)
       RETURNING id::text`,
      [`parity-leg-cc-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO agent_containers (id, user_id, secret_hash)
     VALUES (8, $1, $2)`,
    [legacyUid, Buffer.alloc(32, 8)],
  )
  const legacyNodeId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_nodes
         (label, ssh_host, ssh_port, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ('legacy-cc-node', $1, $2, $3, $4, $5, $6, 'active')
       RETURNING id::text`,
      [
        liveCfg.sshHost,
        selfhostNode.ssh_port,
        selfhostNode.ssh_user,
        selfhostNode.host_key_fp,
        selfhostNode.key_id,
        createHash('sha256').update(readFileSync(CC5_CONTROLLER_PATH)).digest('hex'),
      ],
    )
  ).rows[0]!.id
  const legacyProfileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode, max_concurrent_lanes, status)
       VALUES ($1, 'cc', 'default', 'legacy-cc-default', 'interactive', 5, 'active')
       RETURNING id::text`,
      [legacyNodeId],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, $2)`,
    [legacyProfileId, CC_INTERSECTION_UPSTREAM_MODEL, CC_INTERSECTION_CANONICAL_MODEL],
  )

  const sessionKey = `agent:main:webchat:dm:parity_leg_cc_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  const dockerId = 'e'.repeat(64)
  const shortDir = mkdtempSync('/tmp/oc-parcc-')
  const stageRoot = join(shortDir, 'stage')
  const stageAgentRemote = join(stageRoot, 'scripts/agent-remote')
  const stageBoxBridge = join(stageRoot, 'packages/gateway/box-bridge-mod')
  mkdirSync(dirname(stageAgentRemote), { recursive: true, mode: 0o700 })
  mkdirSync(dirname(stageBoxBridge), { recursive: true, mode: 0o700 })
  cpSync(dirname(CC5_CONTROLLER_PATH), stageAgentRemote, { recursive: true })
  cpSync(
    fileURLToPath(new URL('../../packages/gateway/box-bridge-mod', import.meta.url)),
    stageBoxBridge,
    { recursive: true },
  )
  const localControllerCopy = join(stageAgentRemote, 'cc5-host-controller.py')
  chmodSync(localControllerCopy, 0o600)
  const placed = await placeRemoteLane(
    {
      uid: Number(legacyUid),
      containerDbId: '8',
      dockerId,
      sessionKey,
      canonicalModel: CC_INTERSECTION_CANONICAL_MODEL,
    },
    { pool, controllerPath: localControllerCopy },
  )

  const toolSocketPath = join(shortDir, 'tool.sock')
  const relaySocketPath = join(shortDir, 'relay.sock')
  const journalDir = join(shortDir, 'journal')
  rmSync(sharedParityCwd, { recursive: true, force: true })
  mkdirSync(sharedParityCwd, { recursive: true, mode: 0o700 })
  const containerCwd = sharedParityCwd
  const containerHome = join(shortDir, 'home')
  const execRoot = join(shortDir, 'exec')
  mkdirSync(join(containerHome, '.claude'), { recursive: true, mode: 0o700 })
  mkdirSync(execRoot, { recursive: true, mode: 0o700 })

  const fin = createLegacyFinanceSetup({
    pool,
    preCheckRedis,
    canonicalModel: CC_INTERSECTION_CANONICAL_MODEL,
    upstreamModel: CC_INTERSECTION_UPSTREAM_MODEL,
    engine: 'ccb',
  })

  const hostConfig: Cc5SshHostConfig = {
    target: placed.target,
    taskRoot: placed.taskRoot,
    operationId: placed.operationId,
    runId: placed.runId,
    controllerPath: localControllerCopy,
    toolSocketPath,
  }
  let legacyCcWireAudit: {
    instructionsSha256: string
    instructionsBytes: number
    toolCatalogSha256: string
    toolCount: number
  } | null = null
  const wrapCcHost = (innerHost: Cc5SshHost): Cc5SshHost => {
    const origConfigure = innerHost.configure.bind(innerHost)
    innerHost.configure = async (packet: Buffer) => {
      const parsed = JSON.parse(packet.toString('utf8')) as { catalog: string; prompt: string }
      const catObj = JSON.parse(parsed.catalog) as { tools?: unknown[] }
      legacyCcWireAudit = {
        instructionsSha256: sha256Utf8(parsed.prompt),
        instructionsBytes: Buffer.byteLength(parsed.prompt, 'utf8'),
        toolCatalogSha256: remoteCanonicalSha256(catObj),
        toolCount: Array.isArray(catObj.tools) ? catObj.tools.length : 0,
      }
      return await origConfigure(packet)
    }
    return innerHost
  }
  const host = wrapCcHost(new Cc5SshHost(hostConfig))
  const binding: Readonly<Cc5BridgeBinding> = Object.freeze({
    version: 2,
    backendKind: CC5_INTERACTIVE_BACKEND,
    canonicalModel: CC_INTERSECTION_CANONICAL_MODEL,
    sessionKey,
    runId: placed.runId,
    uid: legacyUid,
    containerDbId: '8',
    dockerId,
    operationId: placed.operationId,
    capability: randomBytes(32).toString('hex'),
    expiresAt: Date.now() + CC5_BINDING_SLIDING_TTL_MS,
  })
  const relay = new Cc5Relay(
    binding,
    fin.keyring,
    placed.runId,
    host,
    journalDir,
    fin.finance,
    {
      slidingTtlMs: CC5_BINDING_SLIDING_TTL_MS,
      upstreamModel: CC_INTERSECTION_UPSTREAM_MODEL,
      replaceHost: () => wrapCcHost(new Cc5SshHost(hostConfig)),
    },
  )

  const executedCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  let bridgeAbort: AbortController | undefined
  let bridgeRunning: Promise<void> | undefined
  let activeAdapter: Cc5InteractiveAdapter | undefined

  try {
    await host.prepareTask(placed.provisionPacket)
    await recordRemoteLaneState(placed.operationId, 'running', pool, placed.generation)
    relay.toolServer.listen(toolSocketPath)
    await once(relay.toolServer, 'listening')
    relay.controlServer.listen(relaySocketPath)
    await once(relay.controlServer, 'listening')

    const executionBackend = parseCc5ExecutionBackend({
      kind: CC5_INTERACTIVE_BACKEND,
      sessionKey,
      operationId: placed.operationId,
    })
    const scopePayload = {
      capability: binding.capability,
      uid: binding.uid,
      containerDbId: binding.containerDbId,
      dockerId: binding.dockerId,
      operationId: binding.operationId,
      sessionKey,
    }
    let portClosed = false
    const port: Cc5BridgePort = {
      bindingId: binding.operationId,
      executionBackend,
      canonicalModel: binding.canonicalModel,
      async prepare(prepIn) {
        const lanePath = prepIn?.laneProfile ?? ''
        const diskLane = readCc5LaneProfile(lanePath)
        __setCcbSpawnForTests(() => {
          bridgeAbort = new AbortController()
          const proc = new InProcessBridgeProc(() => bridgeAbort?.abort())
          bridgeRunning = runCc5StdioBridge({
            binding,
            sessionKey,
            stdin: proc.stdin,
            stdout: proc.stdout,
            socketPath: relaySocketPath,
            signal: bridgeAbort.signal,
            tools: {
              keyring: fin.keyring,
              executionRoot: execRoot,
              lane: {
                version: 1,
                platformPrompt: diskLane.platformPrompt,
                host: {
                  cwd: containerCwd,
                  mcpConfigPath: null,
                  settingsPath: null,
                  disallowedTools: [],
                },
              },
              hostFactory: (toolRoot, lifecycleId, hostProf, onPerm) => {
                const inner = new Cc5ToolHost(toolRoot, lifecycleId, hostProf, onPerm, {
                  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                  LANG: 'C.UTF-8',
                  HOME: containerHome,
                  CLAUDE_CONFIG_DIR: join(containerHome, '.claude'),
                })
                return {
                  tools: async () => (await inner.tools()).filter((t) => t.name === 'Write'),
                  close: () => inner.close(),
                  execute: async (name, rawArgs, identity) => {
                    const argsObj =
                      rawArgs && typeof rawArgs === 'object'
                        ? (rawArgs as Record<string, unknown>)
                        : {}
                    executedCalls.push({ name, args: structuredClone(argsObj) })
                    return await inner.execute(name, rawArgs, identity)
                  },
                }
              },
            },
          })
          void bridgeRunning.then(
            () => proc.markBridgeFinished(0),
            (err) => {
              console.error('[parity-legacy-cc-bridge-error]', err)
              proc.markBridgeFinished(1)
            },
          )
          return proc as never
        })
        return {
          command: process.execPath,
          args: ['in-process-cc5-stdio-bridge', lanePath],
          ccbBinaryDir: containerCwd,
          subprocessCwd: containerCwd,
          env: { LANG: 'C.UTF-8', ...(prepIn?.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        }
      },
      async admit(admitIn) {
        assert.equal(portClosed, false)
        const authority = admitIn.authority.authorityEnvelope
        const lease = admitIn.authority.leaseEnvelope
        const expected = createHash('sha256')
          .update(authority)
          .update('\0')
          .update(lease)
          .digest('hex')
        const resp = await cc5ControlRequest(
          '/admit',
          { ...scopePayload, authority, lease, turnKey: admitIn.turnKey },
          relaySocketPath,
        )
        assert.equal(resp.admissionHash, expected)
        assert.equal(resp.ready, true)
      },
      async renew(leaseEnvelope) {
        await cc5ControlRequest('/renew', { ...scopePayload, lease: leaseEnvelope }, relaySocketPath)
      },
      async interrupt() {
        if (portClosed) return
        await cc5ControlRequest('/interrupt', scopePayload, relaySocketPath)
      },
      async close() {
        if (portClosed) return
        portClosed = true
        const resp = await cc5ControlRequest('/stop', scopePayload, relaySocketPath)
        assert.equal(resp.remoteStopped, true)
      },
    }

    const adapter = new Cc5InteractiveAdapter({
      sessionKey,
      executionBackend,
      agentId: 'main',
      agentBaseDir: containerCwd,
      model: binding.canonicalModel,
      config: SHARED_PARITY_ADAPTER_CONFIG as never,
      cc5BridgePort: port,
    } as EngineCreateOpts)
    activeAdapter = adapter
    const observedSessionIds: string[] = []
    adapter.on('session_id', (sid: string) => observedSessionIds.push(sid))

    const sessionTotals = { totalCostUSD: 0, turns: 0 }
    const toolUseIdToName = new Map<string, string>()
    const submitLegacyCcTurn = async (prompt: string) => {
      const dispatchId = randomUUID()
      const authorityTurnId = randomUUID().replaceAll('-', '')
      const requestId = `req_leg_cc_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const turnKey = createHash('sha256').update(`${requestId}:turnKey`).digest('hex')
      await pool.query(
        `INSERT INTO turn_dispatches
           (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
            request_hash, billing_request_id, status, agent_container_id)
         VALUES ($1, $2, $3, $4, 'main', $5, $6, $4, 'admitted', 8)`,
        [dispatchId, legacyUid, sessionKey, requestId, binding.canonicalModel, turnKey],
      )
      await pool.query(
        `INSERT INTO authority_turn_dispatches
           (authority_turn_id, user_id, canonical_model, session_id, dispatch_id, attempt_no)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [authorityTurnId, legacyUid, binding.canonicalModel, sessionKey, dispatchId],
      )
      const now = Date.now()
      const a: ModelAuthorityPayload = {
        v: 1,
        keyId: fin.keyId,
        uid: Number(legacyUid),
        containerId: 8,
        authorityTurnId,
        billingRequestId: requestId,
        connectionChallenge: 'parity-leg-cc',
        canonicalModel: binding.canonicalModel,
        engine: 'ccb',
        executionBackend,
        securityEpoch: 7,
        executionRevision: fin.catalog.executionRevision,
        issuedAt: now,
        expiresAt: now + 300_000,
        executionDescriptor: {
          capabilityProfile: {
            supportsVision: true,
            reasoning: { supported: ['low', 'medium', 'high'] },
            ccb: {
              capabilityZero: false,
              supportsThinking: true,
              contextOwner: BOX_NATIVE_CONTEXT_OWNER,
            },
          },
          capabilitySchemaVersion: 1,
          contextWindow: 200_000,
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'],
        },
      }
      const l: TurnLease = {
        v: 1,
        keyId: fin.keyId,
        uid: Number(legacyUid),
        containerId: 8,
        authorityTurnId,
        connectionChallenge: 'parity-leg-cc',
        canonicalModel: binding.canonicalModel,
        securityEpoch: 7,
        issuedAt: now,
        expiresAt: now + 600_000,
      }
      let firstEventAt: number | null = null
      const startedAt = performance.now()
      const run = adapter.submitTurn({
        input: prompt,
        requestId,
        turnKey,
        modelAuthority: {
          authorityEnvelope: encodeAuthorityEnvelope(
            a,
            sign(null, authoritySigningInput(a), fin.privateKey),
          ),
          leaseEnvelope: encodeTurnLeaseEnvelope(
            l,
            sign(null, turnLeaseSigningInput(l), fin.privateKey),
          ),
          executionDescriptor: {
            canonicalModel: binding.canonicalModel,
            executionBackend,
            contextOwner: BOX_NATIVE_CONTEXT_OWNER,
            contextWindow: 200_000,
            capabilityZero: false,
            supportsThinking: true,
            supportsVision: true,
            supportedEfforts: ['low', 'medium', 'high'],
          },
        },
        onEvent: (ev) => {
          if (firstEventAt === null && (ev.kind === 'block' || ev.kind === 'tool_use_detected')) {
            firstEventAt = performance.now()
          }
        },
        sessionTotals,
        toolUseIdToName,
      } as TurnParams)
      await run.submitted
      const summary = await run.summary
      assert.ok(summary, 'Legacy cc turn summary missing')
      const endedAt = performance.now()
      return {
        requestId,
        summary,
        ttftMs: Number(((firstEventAt ?? endedAt) - startedAt).toFixed(2)),
        turnDurationMs: Number((endedAt - startedAt).toFixed(2)),
      }
    }

    const sentinelPath = join(containerCwd, 'parity-sentinel.txt')
    const sentinelContent = `parity-${nonce}`
    const turn1Prompt = buildParityTurn1Prompt(sentinelPath, sentinelContent, nonce)
    const turn2Prompt = buildParityTurn2Prompt()

    // Turn 1
    const t1 = await submitLegacyCcTurn(turn1Prompt)
    assert.equal(t1.summary.isError, false, `Legacy cc Turn 1 failed: ${t1.summary.errorDetail ?? ''}`)
    const sentinelVerified = readFileSync(sentinelPath, 'utf8') === sentinelContent
    assert.equal(sentinelVerified, true, 'Legacy cc Turn 1 sentinel mismatch')
    assert.equal(executedCalls.length, 1, 'Legacy cc Turn 1 must execute 1 container tool')
    assert.equal(executedCalls[0]?.name, 'Write')
    assert.ok(legacyCcWireAudit, 'Legacy cc host.configure must capture wire prompt and catalog')
    const parsedResume1 = adapter.nativeSessionId
      ? parseCc5ResumeId(adapter.nativeSessionId)
      : null
    const nativeSession1 = parsedResume1?.nativeId ?? ''
    assert.ok(nativeSession1.length > 0, 'Legacy cc Turn 1 must bind non-empty nativeSessionId')
    const usage1 = await readAndVerifyUsageRecord(
      pool,
      legacyUid,
      t1.requestId,
      binding.canonicalModel,
    )

    // Turn 2 (warm native resume on same resident PTY/bridge)
    const t2 = await submitLegacyCcTurn(turn2Prompt)
    assert.equal(t2.summary.isError, false, `Legacy cc Turn 2 failed: ${t2.summary.errorDetail ?? ''}`)
    assert.equal(executedCalls.length, 1, 'Legacy cc Turn 2 must execute 0 tools')
    const recalledNonce = t2.summary.assistantText.includes(nonce)
    assert.equal(
      recalledNonce,
      true,
      `Legacy cc Turn 2 must recall exact nonce ${nonce}, got: ${t2.summary.assistantText}`,
    )
    const parsedResume2 = adapter.nativeSessionId
      ? parseCc5ResumeId(adapter.nativeSessionId)
      : null
    const nativeSession2 = parsedResume2?.nativeId ?? ''
    assert.equal(nativeSession2, nativeSession1, 'Legacy cc Turn 2 must preserve nativeSessionId')
    const usage2 = await readAndVerifyUsageRecord(
      pool,
      legacyUid,
      t2.requestId,
      binding.canonicalModel,
    )

    await adapter.shutdown()
    activeAdapter = undefined
    await bridgeRunning?.catch(() => {})
    await relay.stop()
    await recordRemoteLaneState(placed.operationId, 'released', pool, placed.generation)

    const remoteStoppedCleanup = runAdminRemoteNodePy(liveCfg, REMOTE_READ_AND_CLEANUP_PY, {
      op: 'read_stopped_and_cleanup',
      root: placed.taskRoot,
    })
    assert.equal(remoteStoppedCleanup.cleaned, true)
    const stopProof = remoteStoppedCleanup.stopped as Record<string, unknown> | null
    assert.equal(stopProof?.remoteStopped, true, 'Legacy cc STOPPED.json must prove remoteStopped=true')

    const totalFen = (BigInt(usage1.costCreditsFen) + BigInt(usage2.costCreditsFen)).toString()
    return {
      backendKind: CC5_INTERACTIVE_BACKEND,
      operationId: placed.operationId,
      taskRoot: placed.taskRoot,
      observedTarget: {
        sshHost: placed.target.host,
        sshPort: placed.target.port,
        sshUser: placed.target.user,
        profileName: 'default',
        canonicalModel: binding.canonicalModel,
        upstreamModel: CC_INTERSECTION_UPSTREAM_MODEL,
        pricingRatesFenPerMtok: {
          input: PRICING_RATES.inputPerMtok.toString(),
          output: PRICING_RATES.outputPerMtok.toString(),
          cacheRead: PRICING_RATES.cacheReadPerMtok.toString(),
          cacheWrite: PRICING_RATES.cacheWritePerMtok.toString(),
        },
        dispatchedInstructionsSha256: legacyCcWireAudit.instructionsSha256,
        dispatchedInstructionsBytes: legacyCcWireAudit.instructionsBytes,
        dispatchedToolCatalogSha256: legacyCcWireAudit.toolCatalogSha256,
        dispatchedToolCount: legacyCcWireAudit.toolCount,
        turn1UserPromptSha256: sha256Utf8(turn1Prompt),
        turn2UserPromptSha256: sha256Utf8(turn2Prompt),
      },
      turn1: {
        requestId: t1.requestId,
        ttftMs: t1.ttftMs,
        includesLiveNetworkAndModelVariance: true,
        turnDurationMs: t1.turnDurationMs,
        finalText: t1.summary.assistantText.trim(),
        finalTextSha256: sha256Utf8(t1.summary.assistantText.trim()),
        toolCallSequence: executedCalls.map((c) => ({
          name: c.name,
          filePathMatchesSentinel: c.args.file_path === sentinelPath,
        })),
        nativeSessionId: nativeSession1,
        usageRecord: usage1,
        sentinelVerified,
      },
      turn2Resume: {
        requestId: t2.requestId,
        ttftMs: t2.ttftMs,
        includesLiveNetworkAndModelVariance: true,
        turnDurationMs: t2.turnDurationMs,
        finalText: t2.summary.assistantText.trim(),
        finalTextSha256: sha256Utf8(t2.summary.assistantText.trim()),
        toolCallSequence: [],
        nativeSessionId: nativeSession2,
        usageRecord: usage2,
        recalledSecretNonce: recalledNonce,
        resumedSameNativeSession:
          nativeSession2 === nativeSession1 && observedSessionIds.length >= 1,
      },
      totalChargedFen: totalFen,
      stopProof,
    }
  } finally {
    __setCcbSpawnForTests(null)
    bridgeAbort?.abort()
    await activeAdapter?.shutdown().catch(() => {})
    await bridgeRunning?.catch(() => {})
    await relay.stop().catch(() => {})
    relay.toolServer.closeAllConnections()
    relay.controlServer.closeAllConnections()
    await new Promise<void>((r) => relay.toolServer.close(() => r()))
    await new Promise<void>((r) => relay.controlServer.close(() => r()))
    try {
      runAdminRemoteNodePy(liveCfg, REMOTE_READ_AND_CLEANUP_PY, {
        op: 'cleanup_only',
        root: placed.taskRoot,
      })
    } catch {
      /* ignore */
    }
    rmSync(shortDir, { recursive: true, force: true })
  }
}

async function runLegacy746CodexTwoTurnParityLane(input: {
  pool: Pool
  preCheckRedis: ReturnType<typeof wrapIoredisForPreCheck>
  liveCfg: LiveNodeConfig
  nonce: string
  sharedParityCwd: string
}): Promise<LaneParityEvidence> {
  const { pool, preCheckRedis, liveCfg, nonce, sharedParityCwd } = input
  const selfhostRow = readSelfhostReadOnlyJson<{
    key_id: string
    host_key_fp: string
    ssh_port: number
    ssh_user: string
    auth_epoch: string
    probe_snapshot: Record<string, any>
    execution_manifest: Record<string, any> | null
  }>(
    `SELECT n.key_id,
            n.host_key_fp,
            n.ssh_port,
            n.ssh_user,
            p.auth_epoch,
            p.probe_snapshot,
            p.execution_manifest
       FROM remote_agent_nodes n
       JOIN remote_agent_profiles p ON p.node_id = n.id
      WHERE n.ssh_host = ${`'${liveCfg.sshHost.replaceAll("'", "''")}'`}
        AND p.engine = 'codex'
        AND p.profile_name = 'default'
      LIMIT 1`,
  )

  const execSnap = selfhostRow.probe_snapshot?.execution_snapshot
  assert.ok(execSnap, 'Expected execution_snapshot on selfhost codex profile')
  const effectiveManifest =
    selfhostRow.execution_manifest?.version === 1 &&
    selfhostRow.execution_manifest?.authEpoch === selfhostRow.auth_epoch &&
    selfhostRow.execution_manifest?.snapshotSha256 === selfhostRow.probe_snapshot.snapshot_sha256
      ? selfhostRow.execution_manifest
      : {
          version: 1,
          backendKind: 'codex-app-server-v1',
          authEpoch: selfhostRow.auth_epoch,
          snapshotSha256: selfhostRow.probe_snapshot.snapshot_sha256,
          controllerSha256: execSnap.controllerSha256,
          gatewayRevision: 'codex-remote-adapter-v1',
          e2eReceiptSha256: 'd'.repeat(64),
          installed: true,
          text: true,
        }

  const legacyUid = (
    await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, credits)
       VALUES ($1, 'parity-legacy-codex', 100000000000)
       RETURNING id::text`,
      [`parity-leg-cdx-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO agent_containers (id, user_id, secret_hash)
     VALUES (8, $1, $2)`,
    [legacyUid, Buffer.alloc(32, 9)],
  )
  const legacyNodeId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_nodes
         (label, ssh_host, ssh_port, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ('legacy-codex-node', $1, $2, $3, $4, $5, $6, 'active')
       RETURNING id::text`,
      [
        liveCfg.sshHost,
        selfhostRow.ssh_port,
        selfhostRow.ssh_user,
        selfhostRow.host_key_fp,
        selfhostRow.key_id,
        execSnap.controllerSha256,
      ],
    )
  ).rows[0]!.id
  const legacyProfileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, profile_name, account_fingerprint, runner_mode,
          probe_snapshot, execution_ready, auth_epoch, execution_manifest, max_concurrent_lanes, status)
       VALUES ($1, 'codex', 'default', 'legacy-codex-default', 'app-server',
               $2::jsonb, TRUE, $3, $4::jsonb, 5, 'active')
       RETURNING id::text`,
      [
        legacyNodeId,
        JSON.stringify(selfhostRow.probe_snapshot),
        selfhostRow.auth_epoch,
        JSON.stringify(effectiveManifest),
      ],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, $2)`,
    [legacyProfileId, liveCfg.upstreamModel, liveCfg.canonicalModel],
  )

  const sessionKey = `agent:main:webchat:dm:parity_leg_cdx_${randomUUID().replaceAll('-', '').slice(0, 10)}`
  const dockerId = 'f'.repeat(64)
  const placed = await placeRemoteLane(
    {
      uid: Number(legacyUid),
      containerDbId: '8',
      dockerId,
      sessionKey,
      canonicalModel: liveCfg.canonicalModel,
      engine: 'codex',
    },
    { pool },
  )
  assert.ok(placed.codex, 'Expected CodexLaneSpec from placeRemoteLane')
  const spec = placed.codex

  const shortDir = mkdtempSync('/tmp/oc-parcdx-')
  const relaySocketPath = join(shortDir, 'relay.sock')
  const journalDir = join(shortDir, 'journal')
  rmSync(sharedParityCwd, { recursive: true, force: true })
  mkdirSync(sharedParityCwd, { recursive: true, mode: 0o700 })
  const containerCwd = sharedParityCwd
  const containerHome = join(shortDir, 'home')
  const execRoot = join(shortDir, 'exec')
  mkdirSync(journalDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(containerHome, '.claude'), { recursive: true, mode: 0o700 })
  mkdirSync(execRoot, { recursive: true, mode: 0o700 })

  const fin = createLegacyFinanceSetup({
    pool,
    preCheckRedis,
    canonicalModel: liveCfg.canonicalModel,
    upstreamModel: liveCfg.upstreamModel,
    engine: 'codex',
  })

  const host = new CodexSshHost(placed.target, spec)
  let legacyCodexCatalogSha256 = ''
  let legacyCodexToolCount = 0
  let legacyCodexInstructionsSha256 = ''
  let legacyCodexInstructionsBytes = 0
  const origProvision = host.provision.bind(host)
  host.provision = async (tools: unknown) => {
    const catObj =
      tools && typeof tools === 'object' ? (tools as { tools?: unknown[] }) : { tools: [] }
    legacyCodexCatalogSha256 = remoteCanonicalSha256(catObj)
    legacyCodexToolCount = Array.isArray(catObj.tools) ? catObj.tools.length : 0
    return await origProvision(tools)
  }
  const origOpen = host.open.bind(host)
  host.open = (role: 'launch' | 'tool-socket') => {
    const child = origOpen(role)
    if (role === 'launch') {
      let lineBuf = ''
      const origWrite = child.stdin.write.bind(child.stdin)
      child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
        lineBuf += str
        let nl = lineBuf.indexOf('\n')
        while (nl >= 0) {
          const line = lineBuf.slice(0, nl).trim()
          lineBuf = lineBuf.slice(nl + 1)
          if (line.startsWith('{')) {
            try {
              const msg = JSON.parse(line) as {
                method?: string
                params?: { baseInstructions?: unknown }
              }
              if (
                msg.method === 'thread/start' &&
                typeof msg.params?.baseInstructions === 'string' &&
                !legacyCodexInstructionsSha256
              ) {
                legacyCodexInstructionsSha256 = sha256Utf8(msg.params.baseInstructions)
                legacyCodexInstructionsBytes = Buffer.byteLength(msg.params.baseInstructions, 'utf8')
              }
            } catch {
              /* ignore partial/non-JSON frame */
            }
          }
          nl = lineBuf.indexOf('\n')
        }
        return (origWrite as (...args: any[]) => boolean)(chunk, ...rest)
      }) as typeof child.stdin.write
    }
    return child
  }
  const preflight = await host.preflight()
  assert.equal(preflight.memoryOk, true, `Legacy codex preflight refused: ${preflight.code ?? ''}`)

  const binding: CodexRemoteBinding = Object.freeze({
    version: 3,
    backendKind: 'codex-app-server-v1',
    canonicalModel: liveCfg.canonicalModel,
    sessionKey,
    uid: legacyUid,
    containerDbId: '8',
    dockerId,
    operationId: placed.operationId,
    runId: placed.runId,
    generation: placed.generation,
    profileId: spec.manifest.profileId,
    authEpoch: spec.manifest.authEpoch,
    manifestSha256: codexJsonHash(JSON.stringify(spec.manifest)),
    capability: randomBytes(32).toString('hex'),
    expiresAt: Date.now() + CC5_BINDING_SLIDING_TTL_MS,
  })

  const observedNativeThreads: string[] = []
  const relay = new CodexRemoteRelay(
    binding,
    fin.keyring,
    host,
    spec,
    journalDir,
    fin.finance,
    async (threadId) => {
      observedNativeThreads.push(threadId)
      await recordRemoteNativeThread(placed.operationId, placed.generation, threadId, pool)
    },
    async () => {
      await recordRemoteStartAttempt(placed.operationId, placed.generation, pool)
    },
  )

  const executedCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  let activeAdapter: CodexRemoteAdapter | undefined

  try {
    await recordRemoteLaneState(placed.operationId, 'running', pool, placed.generation)
    relay.controlServer.listen(relaySocketPath)
    await once(relay.controlServer, 'listening')

    let currentSigned: ModelAuthorityPayload | undefined
    const renewLease = async () => {
      assert.ok(currentSigned)
      const expiresAt = Date.now() + 600_000
      const l: TurnLease = {
        v: 1,
        keyId: fin.keyId,
        uid: Number(legacyUid),
        containerId: 8,
        authorityTurnId: currentSigned.authorityTurnId,
        connectionChallenge: 'parity-leg-cdx',
        canonicalModel: binding.canonicalModel,
        securityEpoch: 7,
        issuedAt: currentSigned.issuedAt,
        expiresAt,
      }
      return {
        lease: encodeTurnLeaseEnvelope(
          l,
          sign(null, turnLeaseSigningInput(l), fin.privateKey),
        ),
        expiresAt,
      }
    }

    const adapter = new CodexRemoteAdapter(
      {
        sessionKey,
        agentId: 'main',
        config: {
          ...SHARED_PARITY_ADAPTER_CONFIG,
          defaults: { model: binding.canonicalModel, permissionMode: 'bypassPermissions' },
        },
        agentBaseDir: containerCwd,
        model: binding.canonicalModel,
        effortLevel: 'medium',
        executionBackend: codexBackend(binding),
      } as EngineCreateOpts,
      {
        binding,
        socketPath: relaySocketPath,
        keyring: fin.keyring,
        executionRoot: execRoot,
        renewLease,
        hostFactory: (toolRoot, lifecycleId, profile, env) => {
          const inner = new Cc5ToolHost(
            toolRoot,
            lifecycleId,
            {
              cwd: profile.cwd,
              mcpConfigPath: null,
              settingsPath: null,
              disallowedTools: [],
            },
            async () => {
              throw new Error('CODEX_REMOTE_PERMISSION_UNSUPPORTED')
            },
            {
              ...env,
              HOME: containerHome,
              CLAUDE_CONFIG_DIR: join(containerHome, '.claude'),
            },
          )
          return {
            tools: async () => (await inner.tools()).filter((t) => t.name === 'Write'),
            close: () => inner.close(),
            execute: async (name, rawArgs, identity) => {
              const argsObj =
                rawArgs && typeof rawArgs === 'object'
                  ? (rawArgs as Record<string, unknown>)
                  : {}
              executedCalls.push({ name, args: structuredClone(argsObj) })
              return await inner.execute(name, rawArgs, identity)
            },
          }
        },
      },
    )
    activeAdapter = adapter
    const adapterSessionIds: string[] = []
    adapter.on('session_id', (sid: string) => adapterSessionIds.push(sid))

    const sessionTotals = { totalCostUSD: 0, turns: 0 }
    const toolUseIdToName = new Map<string, string>()
    const submitLegacyCodexTurn = async (prompt: string) => {
      const dispatchId = randomUUID()
      const authorityTurnId = randomUUID().replaceAll('-', '')
      const requestId = `req_leg_cdx_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const turnKey = createHash('sha256').update(`${requestId}:turnKey`).digest('hex')
      await pool.query(
        `INSERT INTO turn_dispatches
           (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
            request_hash, billing_request_id, status, agent_container_id)
         VALUES ($1, $2, $3, $4, 'main', $5, $6, $4, 'admitted', 8)`,
        [dispatchId, legacyUid, sessionKey, requestId, binding.canonicalModel, turnKey],
      )
      await pool.query(
        `INSERT INTO authority_turn_dispatches
           (authority_turn_id, user_id, canonical_model, session_id, dispatch_id, attempt_no)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [authorityTurnId, legacyUid, binding.canonicalModel, sessionKey, dispatchId],
      )
      const now = Date.now()
      const a: ModelAuthorityPayload = {
        v: 1,
        keyId: fin.keyId,
        uid: Number(legacyUid),
        containerId: 8,
        authorityTurnId,
        billingRequestId: requestId,
        connectionChallenge: 'parity-leg-cdx',
        canonicalModel: binding.canonicalModel,
        engine: 'codex',
        executionBackend: codexBackend(binding),
        securityEpoch: 7,
        executionRevision: fin.catalog.executionRevision,
        issuedAt: now,
        expiresAt: now + 300_000,
        executionDescriptor: {
          capabilityProfile: {
            supportsVision: true,
            reasoning: { supported: ['low', 'medium', 'high'], codexModelDefault: 'medium' },
            ccb: { capabilityZero: false, supportsThinking: true },
          },
          capabilitySchemaVersion: 1,
          contextWindow: 200_000,
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'],
          codexDefaultEffort: 'medium',
        },
      }
      currentSigned = a
      const l: TurnLease = {
        v: 1,
        keyId: fin.keyId,
        uid: Number(legacyUid),
        containerId: 8,
        authorityTurnId,
        connectionChallenge: 'parity-leg-cdx',
        canonicalModel: binding.canonicalModel,
        securityEpoch: 7,
        issuedAt: now,
        expiresAt: now + 600_000,
      }
      let firstEventAt: number | null = null
      const startedAt = performance.now()
      const run = adapter.submitTurn({
        input: prompt,
        requestId,
        turnKey,
        modelAuthority: {
          authorityEnvelope: encodeAuthorityEnvelope(
            a,
            sign(null, authoritySigningInput(a), fin.privateKey),
          ),
          leaseEnvelope: encodeTurnLeaseEnvelope(
            l,
            sign(null, turnLeaseSigningInput(l), fin.privateKey),
          ),
          executionDescriptor: {
            canonicalModel: binding.canonicalModel,
            executionBackend: codexBackend(binding),
            contextWindow: 200_000,
            capabilityZero: false,
            supportsThinking: true,
            supportsVision: true,
            supportedEfforts: ['low', 'medium', 'high'],
          },
        },
        onEvent: (ev) => {
          if (firstEventAt === null && (ev.kind === 'block' || ev.kind === 'tool_use_detected')) {
            firstEventAt = performance.now()
          }
        },
        sessionTotals,
        toolUseIdToName,
      } as TurnParams)
      await run.submitted
      const summary = await run.summary
      assert.ok(summary, 'Legacy codex turn summary missing')
      const endedAt = performance.now()
      return {
        requestId,
        summary,
        ttftMs: Number(((firstEventAt ?? endedAt) - startedAt).toFixed(2)),
        turnDurationMs: Number((endedAt - startedAt).toFixed(2)),
      }
    }

    const sentinelPath = join(containerCwd, 'parity-sentinel.txt')
    const sentinelContent = `parity-${nonce}`
    const turn1Prompt = buildParityTurn1Prompt(sentinelPath, sentinelContent, nonce)
    const turn2Prompt = buildParityTurn2Prompt()

    // Turn 1
    const t1 = await submitLegacyCodexTurn(turn1Prompt)
    assert.equal(
      t1.summary.isError,
      false,
      `Legacy codex Turn 1 failed: ${t1.summary.errorDetail ?? ''}`,
    )
    const sentinelVerified = readFileSync(sentinelPath, 'utf8') === sentinelContent
    assert.equal(sentinelVerified, true, 'Legacy codex Turn 1 sentinel mismatch')
    assert.equal(executedCalls.length, 1, 'Legacy codex Turn 1 must execute 1 container tool')
    assert.equal(executedCalls[0]?.name, 'Write')
    assert.ok(
      legacyCodexInstructionsSha256.length === 64 && legacyCodexCatalogSha256.length === 64,
      'Legacy codex must capture wire baseInstructions and provisioned tool catalog',
    )
    const nativeThread1 = observedNativeThreads[0] ?? adapterSessionIds[0] ?? ''
    assert.ok(nativeThread1.length > 0, 'Legacy codex Turn 1 must bind nativeThreadId')
    const usage1 = await readAndVerifyUsageRecord(
      pool,
      legacyUid,
      t1.requestId,
      binding.canonicalModel,
    )

    // Turn 2 (warm resident app-server turn on same thread)
    const t2 = await submitLegacyCodexTurn(turn2Prompt)
    assert.equal(
      t2.summary.isError,
      false,
      `Legacy codex Turn 2 failed: ${t2.summary.errorDetail ?? ''}`,
    )
    assert.equal(executedCalls.length, 1, 'Legacy codex Turn 2 must execute 0 tools')
    const recalledNonce = t2.summary.assistantText.includes(nonce)
    assert.equal(
      recalledNonce,
      true,
      `Legacy codex Turn 2 must recall exact nonce ${nonce}, got: ${t2.summary.assistantText}`,
    )
    const dbThreadRow = await pool.query<{ native_session_id: string | null }>(
      'SELECT native_session_id FROM remote_agent_bindings WHERE operation_id = $1',
      [placed.operationId],
    )
    const nativeThread2 = dbThreadRow.rows[0]?.native_session_id ?? ''
    assert.equal(nativeThread2, nativeThread1, 'Legacy codex Turn 2 must preserve nativeThreadId')
    const usage2 = await readAndVerifyUsageRecord(
      pool,
      legacyUid,
      t2.requestId,
      binding.canonicalModel,
    )

    await adapter.shutdown()
    activeAdapter = undefined
    await relay.stop()
    await recordRemoteLaneState(placed.operationId, 'released', pool, placed.generation)

    const stopProof = host.verifiedStopEvidence as Record<string, any> | undefined
    assert.ok(stopProof, 'Legacy codex host.verifiedStopEvidence must be recorded on stop')
    assert.equal(stopProof?.proof?.remoteStopped, true)

    const cleanupRes = runAdminRemoteNodePy(liveCfg, REMOTE_READ_AND_CLEANUP_PY, {
      op: 'cleanup_only',
      root: placed.taskRoot,
    })
    assert.equal(cleanupRes.cleaned, true)

    const totalFen = (BigInt(usage1.costCreditsFen) + BigInt(usage2.costCreditsFen)).toString()
    return {
      backendKind: 'codex-app-server-v1',
      operationId: placed.operationId,
      taskRoot: placed.taskRoot,
      observedTarget: {
        sshHost: placed.target.host,
        sshPort: placed.target.port,
        sshUser: placed.target.user,
        profileName: spec.manifest.profileId,
        canonicalModel: binding.canonicalModel,
        upstreamModel: placed.target.upstreamModel,
        pricingRatesFenPerMtok: {
          input: PRICING_RATES.inputPerMtok.toString(),
          output: PRICING_RATES.outputPerMtok.toString(),
          cacheRead: PRICING_RATES.cacheReadPerMtok.toString(),
          cacheWrite: PRICING_RATES.cacheWritePerMtok.toString(),
        },
        dispatchedInstructionsSha256: legacyCodexInstructionsSha256,
        dispatchedInstructionsBytes: legacyCodexInstructionsBytes,
        dispatchedToolCatalogSha256: legacyCodexCatalogSha256,
        dispatchedToolCount: legacyCodexToolCount,
        turn1UserPromptSha256: sha256Utf8(turn1Prompt),
        turn2UserPromptSha256: sha256Utf8(turn2Prompt),
      },
      turn1: {
        requestId: t1.requestId,
        ttftMs: t1.ttftMs,
        includesLiveNetworkAndModelVariance: true,
        turnDurationMs: t1.turnDurationMs,
        finalText: t1.summary.assistantText.trim(),
        finalTextSha256: sha256Utf8(t1.summary.assistantText.trim()),
        toolCallSequence: executedCalls.map((c) => ({
          name: c.name,
          filePathMatchesSentinel: c.args.file_path === sentinelPath,
        })),
        nativeSessionId: nativeThread1,
        usageRecord: usage1,
        sentinelVerified,
      },
      turn2Resume: {
        requestId: t2.requestId,
        ttftMs: t2.ttftMs,
        includesLiveNetworkAndModelVariance: true,
        turnDurationMs: t2.turnDurationMs,
        finalText: t2.summary.assistantText.trim(),
        finalTextSha256: sha256Utf8(t2.summary.assistantText.trim()),
        toolCallSequence: [],
        nativeSessionId: nativeThread2,
        usageRecord: usage2,
        recalledSecretNonce: recalledNonce,
        resumedSameNativeSession: nativeThread2 === nativeThread1,
      },
      totalChargedFen: totalFen,
      stopProof,
    }
  } finally {
    await activeAdapter?.shutdown().catch(() => {})
    await relay.stop().catch(() => {})
    relay.controlServer.closeAllConnections()
    await new Promise<void>((r) => relay.controlServer.close(() => r()))
    try {
      runAdminRemoteNodePy(liveCfg, REMOTE_READ_AND_CLEANUP_PY, {
        op: 'cleanup_only',
        root: placed.taskRoot,
      })
    } catch {
      /* ignore */
    }
    rmSync(shortDir, { recursive: true, force: true })
  }
}

function buildSideBySideReport(
  engine: 'cc' | 'codex',
  cfg: LiveNodeConfig,
  canonicalModel: string,
  upstreamModel: string,
  legacy746: LaneParityEvidence,
  v4: LaneParityEvidence,
): EngineSameNodeParityReport {
  const sameNodeVerified =
    legacy746.observedTarget.sshHost === v4.observedTarget.sshHost &&
    legacy746.observedTarget.sshPort === v4.observedTarget.sshPort &&
    legacy746.observedTarget.sshUser === v4.observedTarget.sshUser &&
    legacy746.observedTarget.sshHost === cfg.sshHost
  const sameAccountVerified =
    legacy746.observedTarget.profileName === v4.observedTarget.profileName &&
    legacy746.observedTarget.profileName.length > 0
  const sameModelVerified =
    legacy746.observedTarget.canonicalModel === v4.observedTarget.canonicalModel &&
    legacy746.observedTarget.upstreamModel === v4.observedTarget.upstreamModel &&
    legacy746.observedTarget.canonicalModel === canonicalModel &&
    legacy746.observedTarget.upstreamModel === upstreamModel
  const instructionsSha256Matched =
    legacy746.observedTarget.dispatchedInstructionsSha256 ===
    v4.observedTarget.dispatchedInstructionsSha256
  const toolCatalogSha256Matched =
    legacy746.observedTarget.dispatchedToolCatalogSha256 ===
    v4.observedTarget.dispatchedToolCatalogSha256
  const turn1UserPromptSha256Matched =
    legacy746.observedTarget.turn1UserPromptSha256 === v4.observedTarget.turn1UserPromptSha256
  const turn2UserPromptSha256Matched =
    legacy746.observedTarget.turn2UserPromptSha256 === v4.observedTarget.turn2UserPromptSha256
  const samePromptStructureVerified =
    instructionsSha256Matched &&
    legacy746.observedTarget.dispatchedInstructionsBytes ===
      v4.observedTarget.dispatchedInstructionsBytes &&
    legacy746.observedTarget.dispatchedInstructionsBytes > 4096 &&
    toolCatalogSha256Matched &&
    legacy746.observedTarget.dispatchedToolCount === v4.observedTarget.dispatchedToolCount &&
    turn1UserPromptSha256Matched &&
    turn2UserPromptSha256Matched
  const samePricingSnapshotVerified =
    legacy746.observedTarget.pricingRatesFenPerMtok.input ===
      v4.observedTarget.pricingRatesFenPerMtok.input &&
    legacy746.observedTarget.pricingRatesFenPerMtok.output ===
      v4.observedTarget.pricingRatesFenPerMtok.output &&
    legacy746.observedTarget.pricingRatesFenPerMtok.cacheRead ===
      v4.observedTarget.pricingRatesFenPerMtok.cacheRead &&
    legacy746.observedTarget.pricingRatesFenPerMtok.cacheWrite ===
      v4.observedTarget.pricingRatesFenPerMtok.cacheWrite

  const legacyTurn1ContextTokens =
    legacy746.turn1.usageRecord.inputTokens +
    legacy746.turn1.usageRecord.cacheReadTokens +
    legacy746.turn1.usageRecord.cacheWriteTokens
  const v4Turn1ContextTokens =
    v4.turn1.usageRecord.inputTokens +
    v4.turn1.usageRecord.cacheReadTokens +
    v4.turn1.usageRecord.cacheWriteTokens
  const turn1ContextParityOk =
    Math.abs(v4Turn1ContextTokens - legacyTurn1ContextTokens) <=
    Math.max(256, Math.round(legacyTurn1ContextTokens * 0.05))

  const legIn = legacy746.turn1.usageRecord.inputTokens + legacy746.turn2Resume.usageRecord.inputTokens
  const legOut = legacy746.turn1.usageRecord.outputTokens + legacy746.turn2Resume.usageRecord.outputTokens
  const legCacheRead =
    legacy746.turn1.usageRecord.cacheReadTokens + legacy746.turn2Resume.usageRecord.cacheReadTokens
  const legCacheWrite =
    legacy746.turn1.usageRecord.cacheWriteTokens + legacy746.turn2Resume.usageRecord.cacheWriteTokens
  const v4In = v4.turn1.usageRecord.inputTokens + v4.turn2Resume.usageRecord.inputTokens
  const v4Out = v4.turn1.usageRecord.outputTokens + v4.turn2Resume.usageRecord.outputTokens
  const v4CacheRead = v4.turn1.usageRecord.cacheReadTokens + v4.turn2Resume.usageRecord.cacheReadTokens
  const v4CacheWrite = v4.turn1.usageRecord.cacheWriteTokens + v4.turn2Resume.usageRecord.cacheWriteTokens

  const inRate = Number(PRICING_RATES.inputPerMtok)
  const outRate = Number(PRICING_RATES.outputPerMtok)
  const crRate = Number(PRICING_RATES.cacheReadPerMtok)
  const cwRate = Number(PRICING_RATES.cacheWritePerMtok)

  const inputDeltaFen = Number((((v4In - legIn) * inRate) / 1_000_000).toFixed(2))
  const outputDeltaFen = Number((((v4Out - legOut) * outRate) / 1_000_000).toFixed(2))
  const cacheReadDeltaFen = Number((((v4CacheRead - legCacheRead) * crRate) / 1_000_000).toFixed(2))
  const cacheWriteDeltaFen = Number((((v4CacheWrite - legCacheWrite) * cwRate) / 1_000_000).toFixed(2))

  const legFenNum = Number(legacy746.totalChargedFen)
  const v4FenNum = Number(v4.totalChargedFen)
  const actualDeltaFen = v4FenNum - legFenNum
  const roundingDeltaFen = Number(
    (actualDeltaFen - (inputDeltaFen + outputDeltaFen + cacheReadDeltaFen + cacheWriteDeltaFen)).toFixed(2),
  )

  const cacheNeutralLegacyFen = Math.ceil(
    ((legIn + legCacheRead + legCacheWrite) * inRate + legOut * outRate) / 1_000_000,
  )
  const cacheNeutralV4Fen = Math.ceil(
    ((v4In + v4CacheRead + v4CacheWrite) * inRate + v4Out * outRate) / 1_000_000,
  )
  const cacheNeutralRelativeDeltaPct =
    cacheNeutralLegacyFen > 0
      ? Number((((cacheNeutralV4Fen - cacheNeutralLegacyFen) / cacheNeutralLegacyFen) * 100).toFixed(2))
      : 0
  const manualReviewRequired =
    Math.abs(cacheNeutralRelativeDeltaPct) > 20 || Math.abs(roundingDeltaFen) > 4

  const passed =
    sameNodeVerified &&
    sameAccountVerified &&
    sameModelVerified &&
    samePromptStructureVerified &&
    samePricingSnapshotVerified &&
    turn1ContextParityOk &&
    !manualReviewRequired &&
    legacy746.turn1.sentinelVerified &&
    v4.turn1.sentinelVerified &&
    legacy746.turn2Resume.recalledSecretNonce &&
    v4.turn2Resume.recalledSecretNonce &&
    legacy746.turn2Resume.resumedSameNativeSession &&
    v4.turn2Resume.resumedSameNativeSession &&
    legacy746.turn1.usageRecord.costMatchesUsageFormula &&
    legacy746.turn2Resume.usageRecord.costMatchesUsageFormula &&
    v4.turn1.usageRecord.costMatchesUsageFormula &&
    v4.turn2Resume.usageRecord.costMatchesUsageFormula &&
    Boolean(legacy746.stopProof) &&
    Boolean(v4.stopProof)

  assert.equal(
    passed,
    true,
    `Same-node Legacy 746 vs v4 parity failed for ${engine}: sameNode=${sameNodeVerified} sameAccount=${sameAccountVerified} sameModel=${sameModelVerified} samePrompt=${samePromptStructureVerified} (legPromptSha=${legacy746.observedTarget.dispatchedInstructionsSha256}, v4PromptSha=${v4.observedTarget.dispatchedInstructionsSha256}, legCatSha=${legacy746.observedTarget.dispatchedToolCatalogSha256}, v4CatSha=${v4.observedTarget.dispatchedToolCatalogSha256}) turn1Ctx=${legacyTurn1ContextTokens}vs${v4Turn1ContextTokens} cacheNeutralDeltaPct=${cacheNeutralRelativeDeltaPct}% roundingDeltaFen=${roundingDeltaFen}`,
  )

  const costRatioV4ToLegacy = legFenNum > 0 ? Number((v4FenNum / legFenNum).toFixed(4)) : 1
  const relativeCostDeltaPct =
    legFenNum > 0 ? Number((((v4FenNum - legFenNum) / legFenNum) * 100).toFixed(2)) : 0
  const cacheBreakdownSummary =
    `Turn 1 total context tokens match closely (legacy=${legacyTurn1ContextTokens} [in=${legacy746.turn1.usageRecord.inputTokens}, cacheRead=${legacy746.turn1.usageRecord.cacheReadTokens}, cacheWrite=${legacy746.turn1.usageRecord.cacheWriteTokens}, out=${legacy746.turn1.usageRecord.outputTokens}] vs v4=${v4Turn1ContextTokens} [in=${v4.turn1.usageRecord.inputTokens}, cacheRead=${v4.turn1.usageRecord.cacheReadTokens}, cacheWrite=${v4.turn1.usageRecord.cacheWriteTokens}, out=${v4.turn1.usageRecord.outputTokens}]); Turn 2 out=(legacy=${legacy746.turn2Resume.usageRecord.outputTokens} vs v4=${v4.turn2Resume.usageRecord.outputTokens}).`
  const varianceDecomposition =
    ` Exact token*rate decomposition at configured test pricing (in=${inRate}, out=${outRate}, cacheRead=${crRate}, cacheWrite=${cwRate} fen/Mtok): total delta ${actualDeltaFen} fen (${relativeCostDeltaPct}%) = input ${inputDeltaFen} + output ${outputDeltaFen} + cacheRead ${cacheReadDeltaFen} + cacheWrite ${cacheWriteDeltaFen} + ceil-rounding ${roundingDeltaFen} fen; cache-neutral fen delta is ${cacheNeutralRelativeDeltaPct}% (${cacheNeutralV4Fen} vs ${cacheNeutralLegacyFen}, manualReviewRequired=${manualReviewRequired}).`

  return {
    engine,
    passed,
    conditions: {
      targetHost: cfg.sshHost,
      sshPort: cfg.sshPort ?? 22,
      sshUser: cfg.sshUser ?? 'box',
      profileName: cfg.profileName ?? 'default',
      canonicalModel,
      upstreamModel,
      sameNodeVerified,
      sameAccountVerified,
      sameModelVerified,
      samePromptStructureVerified,
      samePricingSnapshotVerified,
    },
    legacy746,
    v4,
    sideBySideComparison: {
      wirePromptParity: {
        legacyInstructionsSha256: legacy746.observedTarget.dispatchedInstructionsSha256,
        v4InstructionsSha256: v4.observedTarget.dispatchedInstructionsSha256,
        instructionsSha256Matched,
        legacyInstructionsBytes: legacy746.observedTarget.dispatchedInstructionsBytes,
        v4InstructionsBytes: v4.observedTarget.dispatchedInstructionsBytes,
        legacyToolCatalogSha256: legacy746.observedTarget.dispatchedToolCatalogSha256,
        v4ToolCatalogSha256: v4.observedTarget.dispatchedToolCatalogSha256,
        toolCatalogSha256Matched,
        turn1UserPromptSha256Matched,
        turn2UserPromptSha256Matched,
      },
      ttft: {
        includesLiveNetworkAndModelVariance: true,
        legacyTurn1Ms: legacy746.turn1.ttftMs,
        v4Turn1Ms: v4.turn1.ttftMs,
        legacyTurn2Ms: legacy746.turn2Resume.ttftMs,
        v4Turn2Ms: v4.turn2Resume.ttftMs,
        explanation:
          'Measured end-to-end against the real remote node and live upstream LLM API (network + model thinking/cold-start variance included; Turn 1 includes remote session launch + MCP catalog registration, Turn 2 is warm on the resident lane). Pure master core scheduling overhead is bounded <= 50ms p95 in schedulingOverheadGate.',
      },
      finalContent: {
        legacyTurn1Text: legacy746.turn1.finalText,
        v4Turn1Text: v4.turn1.finalText,
        legacyTurn2RecalledNonce: legacy746.turn2Resume.recalledSecretNonce,
        v4Turn2RecalledNonce: v4.turn2Resume.recalledSecretNonce,
        explanation:
          'Both Legacy 746 and v4 complete Turn 1 with DONE after executing the container Write tool, and both recall the exact per-run secret nonce on Turn 2 without any tool call.',
      },
      toolExecution: {
        legacyTurn1Tools: legacy746.turn1.toolCallSequence.map((t) => t.name),
        v4Turn1Tools: v4.turn1.toolCallSequence.map((t) => t.name),
        legacyTurn2Tools: legacy746.turn2Resume.toolCallSequence.map((t) => t.name),
        v4Turn2Tools: v4.turn2Resume.toolCallSequence.map((t) => t.name),
        bothContainerSentinelsVerified:
          legacy746.turn1.sentinelVerified && v4.turn1.sentinelVerified,
        explanation:
          'Both Legacy 746 and v4 execute exactly [Write] inside the container Cc5ToolHost on Turn 1 (verified via container sentinel file bytes) and [] (0 tools) on Turn 2.',
      },
      sessionResume: {
        legacyNativeSessionId: legacy746.turn1.nativeSessionId,
        v4NativeSessionId: v4.turn1.nativeSessionId,
        legacyResumedSameSession: legacy746.turn2Resume.resumedSameNativeSession,
        v4ResumedSameSession: v4.turn2Resume.resumedSameNativeSession,
        explanation:
          'Each lane binds its own fresh upstream session/thread UUID on Turn 1 and preserves that exact nativeSessionId across Turn 2.',
      },
      stopProof: {
        legacyRemoteStopped: true,
        v4RemoteStopped: true,
        explanation:
          engine === 'cc'
            ? 'Legacy 746 cc proves absence via tmux session + recorded PID startTicks + STOPPED.json; v4 cc upgrades stop verification to the shared systemd --user transient scope cgroup.events populated=0 + bootId + (dev,inode) proof.'
            : 'Both Legacy 746 codex and v4 codex verify fence-stop + prove-stopped over systemd --user transient scope cgroup.events populated=0 + bootId + (dev,inode).',
      },
      billing: {
        pricingRatesFenPerMtok: {
          input: PRICING_RATES.inputPerMtok.toString(),
          output: PRICING_RATES.outputPerMtok.toString(),
          cacheRead: PRICING_RATES.cacheReadPerMtok.toString(),
          cacheWrite: PRICING_RATES.cacheWritePerMtok.toString(),
        },
        legacyTotalChargedFen: legacy746.totalChargedFen,
        v4TotalChargedFen: v4.totalChargedFen,
        costRatioV4ToLegacy,
        relativeCostDeltaPct,
        turn1TotalContextTokens: {
          legacy: legacyTurn1ContextTokens,
          v4: v4Turn1ContextTokens,
        },
        tokenRateDeltaDecompositionFen: {
          inputDeltaFen,
          outputDeltaFen,
          cacheReadDeltaFen,
          cacheWriteDeltaFen,
          roundingDeltaFen,
          cacheNeutralLegacyFen,
          cacheNeutralV4Fen,
          cacheNeutralRelativeDeltaPct,
          manualReviewRequired,
        },
        bothMatchExactComputeCostFormula:
          legacy746.turn1.usageRecord.costMatchesUsageFormula &&
          legacy746.turn2Resume.usageRecord.costMatchesUsageFormula &&
          v4.turn1.usageRecord.costMatchesUsageFormula &&
          v4.turn2Resume.usageRecord.costMatchesUsageFormula,
        explanation:
          (engine === 'cc'
            ? 'Both Legacy 746 (receipt v2 per_turn_delta) and v4 (receipt v4 per_turn_delta) dispatch byte-identical wire instructions + tool catalog and settle via settleUsageAndLedger into usage_records matching computeCost(usage, pricing) to the exact fen. '
            : 'Both Legacy 746 (receipt v3 cumulative_minus_baseline) and v4 (receipt v4 cumulative_minus_baseline, reasoningOutputTokens folded into outputTokens once) dispatch byte-identical wire instructions + tool catalog and settle via settleUsageAndLedger into usage_records matching computeCost(usage, pricing) to the exact fen. ') +
          cacheBreakdownSummary +
          varianceDecomposition,
      },
    },
  }
}

export async function runSameNodeLegacyVsV4Parity(input: {
  ccNodeConfigPath: string
  codexNodeConfigPath: string
}): Promise<{
  passed: boolean
  cc: EngineSameNodeParityReport
  codex: EngineSameNodeParityReport
}> {
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379'
  const redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true })
  await redisClient.connect()
  const preCheckRedis = wrapIoredisForPreCheck(redisClient)

  const tempDir = mkdtempSync('/tmp/oc-parcfg-')
  try {
    // 1. CC on 99.144.122.98 (account `default`, intersection model `claude-opus-5-5-remote` -> `claude-opus-5-5`)
    const baseCcCfg = JSON.parse(readFileSync(input.ccNodeConfigPath, 'utf8')) as LiveNodeConfig
    const opusCcCfg: LiveNodeConfig = {
      ...baseCcCfg,
      upstreamModel: CC_INTERSECTION_UPSTREAM_MODEL,
      canonicalModel: CC_INTERSECTION_CANONICAL_MODEL,
      sshProxyCommands: [''],
    }
    const opusCcCfgPath = join(tempDir, 'cc-opus-nodecfg.json')
    writeFileSync(opusCcCfgPath, JSON.stringify(opusCcCfg, null, 2), 'utf8')
    const ccSharedParityCwd = join(tempDir, 'shared-parity-cwd-cc')

    const ccNonce = `OC749CC${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`
    const hCc = await createConformanceHarness('cc', {
      mode: 'live-node',
      nodeConfigPath: opusCcCfgPath,
    })
    let ccReport: EngineSameNodeParityReport
    try {
      const ccV4 = await runV4TwoTurnParityLane(hCc, ccNonce, ccSharedParityCwd)
      await hCc.pool.query('UPDATE remote_model_offers SET enabled = FALSE WHERE profile_id = $1', [
        hCc.profileId,
      ])
      const ccLegacy = await runLegacy746CcTwoTurnParityLane({
        pool: hCc.pool,
        preCheckRedis,
        liveCfg: opusCcCfg,
        nonce: ccNonce,
        sharedParityCwd: ccSharedParityCwd,
      })
      ccReport = buildSideBySideReport(
        'cc',
        opusCcCfg,
        CC_INTERSECTION_CANONICAL_MODEL,
        CC_INTERSECTION_UPSTREAM_MODEL,
        ccLegacy,
        ccV4,
      )
    } finally {
      await hCc.close()
    }

    // 2. Codex on 136.86.253.46 (account `default`, intersection model `gpt-6-luna-remote` -> `gpt-6-luna`)
    const codexCfg = JSON.parse(readFileSync(input.codexNodeConfigPath, 'utf8')) as LiveNodeConfig
    const codexSharedParityCwd = join(tempDir, 'shared-parity-cwd-codex')
    const codexNonce = `OC749CDX${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`
    const hCodex = await createConformanceHarness('codex', {
      mode: 'live-node',
      nodeConfigPath: input.codexNodeConfigPath,
    })
    let codexReport: EngineSameNodeParityReport
    try {
      const codexV4 = await runV4TwoTurnParityLane(
        hCodex,
        codexNonce,
        codexSharedParityCwd,
        'medium',
      )
      await hCodex.pool.query(
        'UPDATE remote_model_offers SET enabled = FALSE WHERE profile_id = $1',
        [hCodex.profileId],
      )
      const codexLegacy = await runLegacy746CodexTwoTurnParityLane({
        pool: hCodex.pool,
        preCheckRedis,
        liveCfg: codexCfg,
        nonce: codexNonce,
        sharedParityCwd: codexSharedParityCwd,
      })
      codexReport = buildSideBySideReport(
        'codex',
        codexCfg,
        codexCfg.canonicalModel,
        codexCfg.upstreamModel,
        codexLegacy,
        codexV4,
      )
    } finally {
      await hCodex.close()
    }

    return {
      passed: ccReport.passed && codexReport.passed,
      cc: ccReport,
      codex: codexReport,
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
    await redisClient.quit().catch(() => {})
  }
}
