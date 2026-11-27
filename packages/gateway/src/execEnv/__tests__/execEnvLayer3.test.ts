import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  type ExecutionPolicyEnvelope,
  type ToolCallEnvelope,
  type ToolStreamFrame,
} from '@openclaude/protocol'
import { issueRebindAuthToken } from '../containerLinkBrokerTransport.js'
import type {
  DiskWalAttemptRecord,
  DiskWalResultRecord,
  ToolBrokerDurableWalAdapter,
} from '../toolBroker.js'
import {
  BoundedDeltaStreamBuffer,
  ContainerLinkToolBrokerHost,
  ExecEnvJobError,
  ExecEnvJobRegistry,
  ExecEnvLeaseError,
  ExecEnvLeaseManager,
  SCOPED_CAPABILITY_TOKEN_PREFIX,
  ScopedCapabilityTokenAuthority,
  ScopedCapabilityTokenError,
  ToolBrokerPolicyError,
  ToolBrokerServer,
  ToolBrokerTransportError,
  constantTimeBytesEqual,
  createInMemoryFrameLinkPair,
  openChannel,
  parseProcStatStartTimeTicks,
  rfc2104HmacSha256,
  type DetachedApprovalCard,
  type SpilledBlobRefOutput,
} from '../index.js'

const registriesToDispose: ExecEnvJobRegistry[] = []
const tempWalDirsToRemove: string[] = []

function makeTempWalDir(prefix = 'oc-tool-broker-test-wal-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempWalDirsToRemove.push(dir)
  return dir
}

function makeRegistry(opts?: ConstructorParameters<typeof ExecEnvJobRegistry>[0]): ExecEnvJobRegistry {
  const reg = new ExecEnvJobRegistry(opts)
  registriesToDispose.push(reg)
  return reg
}

function makeCallEnvelope(params: {
  leaseId: string
  turnId: string
  callId: string
  canonicalName: string
  arguments: Record<string, unknown>
  inputSchema?: Record<string, unknown> | null
  overrideArgsSha256?: string
  timeoutMs?: number
}): ToolCallEnvelope {
  const argsSha256 =
    params.overrideArgsSha256 ??
    computeSchemaFilteredArgsSha256(params.arguments, params.inputSchema ?? null)
  return {
    schemaVersion: 1,
    leaseId: params.leaseId,
    turnId: params.turnId,
    callId: params.callId,
    idempotencyKey: computeToolIdempotencyKey(params.leaseId, params.turnId, params.callId),
    canonicalName: params.canonicalName,
    arguments: params.arguments,
    argsSha256,
    attestation: {
      kind: 'schema_filtered_hook',
      argsSha256,
      observedAt: new Date().toISOString(),
    },
    ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
  }
}

afterEach(async () => {
  while (registriesToDispose.length > 0) {
    const reg = registriesToDispose.pop()!
    await reg.disposeAll()
  }
  while (tempWalDirsToRemove.length > 0) {
    const dir = tempWalDirsToRemove.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Layer 3 JobRegistry (ExecEnvJobRegistry & BoundedDeltaStreamBuffer)', () => {
  it('enforces bounded head+tail buffer with incremental readFrom(cursor) and UTF-8 safety', () => {
    const buf = new BoundedDeltaStreamBuffer({ maxBytes: 100, headBytes: 32 })
    buf.push('A'.repeat(32))
    buf.push('B'.repeat(120))
    buf.push('C'.repeat(40))

    assert.equal(buf.isTruncated, true)
    assert.equal(buf.byteLength, 192)

    const full = buf.readFrom(0, true)
    assert.equal(full.truncated, true)
    assert.ok(full.text.startsWith('A'.repeat(32)))
    assert.ok(full.text.includes('...[truncated '))
    assert.ok(full.text.endsWith('C'.repeat(40)))
    assert.equal(full.nextCursor, 192)

    // Incremental read from cursor near tail returns lossless delta without truncation marker
    buf.push('TAIL-DELTA-你好')
    const delta = buf.readFrom(full.nextCursor, true)
    assert.equal(delta.truncated, false)
    assert.equal(delta.text, 'TAIL-DELTA-你好')

    // Split multi-byte UTF-8 sequence across non-final readFrom holds incomplete bytes until next read
    const utf8Buf = new BoundedDeltaStreamBuffer({ maxBytes: 1024 })
    const emoji = Buffer.from('hi😀', 'utf8')
    utf8Buf.push(emoji.subarray(0, 4)) // "hi" + first 2 bytes of 4-byte emoji
    const part1 = utf8Buf.readFrom(0, false)
    assert.equal(part1.text, 'hi')
    assert.equal(part1.nextCursor, 2)
    utf8Buf.push(emoji.subarray(4))
    const part2 = utf8Buf.readFrom(part1.nextCursor, true)
    assert.equal(part2.text, '😀')
  })

  it('parses Linux /proc/<pid>/stat starttime ticks even with spaces and parens in comm', () => {
    const fakeStat =
      '12345 (my (weird) proc) S 1 12345 12345 0 -1 4194304 100 0 0 0 5 2 0 0 20 0 1 0 987654 1000 50'
    assert.equal(parseProcStatStartTimeTicks(fakeStat), 987654)
    assert.equal(parseProcStatStartTimeTicks('invalid'), null)
  })

  it('preserves managed_job & daemon_service across reapByClass([ephemeral_turn]) and brain switch', async () => {
    const leaseMgr = new ExecEnvLeaseManager()
    const lease1 = leaseMgr.issueLease({
      execEnvId: 'env-local-1',
      incarnationId: 'inc-1',
      sessionKey: 'sess:brain-switch',
      brainGen: 1,
      fencingToken: 'ft-brain-1',
    })
    const reg = makeRegistry({ killGraceMs: 150, closeDrainSafetyMs: 400 })

    // 1. Start ephemeral_turn (long sleep), managed_job (emits phase1, sleeps briefly, emits phase2), daemon_service
    const ephemeral = await reg.startJob({
      leaseId: lease1.leaseId,
      sessionKey: lease1.sessionKey,
      lifecycleClass: 'ephemeral_turn',
      command: ['/bin/sh', '-c', 'echo eph-start; sleep 30'],
      yieldAfterMs: 60,
      label: 'turn-ephemeral',
    })
    assert.equal(ephemeral.status, 'running')

    const managed = await reg.startJob({
      leaseId: lease1.leaseId,
      sessionKey: lease1.sessionKey,
      lifecycleClass: 'managed_job',
      command: ['/bin/sh', '-c', 'echo phase1; sleep 1.5; echo phase2'],
      yieldAfterMs: 80,
      label: 'long-build',
    })
    assert.equal(managed.status, 'running')
    assert.ok(managed.stdout.includes('phase1'))

    const daemon = await reg.startJob({
      leaseId: lease1.leaseId,
      sessionKey: lease1.sessionKey,
      lifecycleClass: 'daemon_service',
      command: ['/bin/sh', '-c', 'echo daemon-up; sleep 30'],
      yieldAfterMs: 60,
      label: 'preview-dev-server',
    })
    assert.equal(daemon.status, 'running')

    // 2. Lane teardown reaps ONLY ephemeral_turn
    const stopProof = await reg.reapByClass(lease1.leaseId, ['ephemeral_turn'])
    assert.equal(stopProof.reapedPgidCount, 1)
    assert.deepEqual(stopProof.reapedJobIds, [ephemeral.jobId])
    assert.ok(stopProof.survivingJobIds.includes(managed.jobId))
    assert.ok(stopProof.survivingJobIds.includes(daemon.jobId))
    assert.ok(stopProof.verifiedAtMs > 0)

    // 3. 3-step brain switch while managed_job & daemon_service stay alive in L3
    const quiesced = leaseMgr.quiesceBrain(lease1.leaseId)
    assert.equal(quiesced.state, 'quiescing')
    assert.throws(
      () => leaseMgr.validateFencingToken(lease1.leaseId, 'ft-brain-1', 1),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_LEASE_QUIESCING',
    )

    const digest = await leaseMgr.exportAttachmentDigest(lease1.leaseId, {
      jobRegistry: reg,
      previewPorts: [{ port: 3000, protocol: 'http', label: 'web' }],
      liveBrowser: { active: true, url: 'http://127.0.0.1:3000', tabCount: 1 },
      workspaceCwd: '/workspace/app',
      repoBinding: { branch: 'main', headSha: 'abc123', dirty: false },
      swarmHeadSeq: 42,
    })
    assert.ok(digest.activeJobs.some((j) => j.jobId === managed.jobId && j.state === 'running'))
    assert.ok(digest.activeJobs.some((j) => j.jobId === daemon.jobId && j.state === 'running'))
    assert.equal(digest.previewPorts.length, 1)
    assert.equal(digest.swarmHeadSeq, 42)

    const rebound = await leaseMgr.rebindBrain(lease1.leaseId, 2, 'ft-brain-2')
    assert.equal(rebound.lease.brainGen, 2)
    assert.equal(rebound.lease.state, 'active')
    assert.throws(
      () => leaseMgr.validateFencingToken(lease1.leaseId, 'ft-brain-1', 1),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_FENCING_TOKEN_STALE',
    )

    // 4. New brain resumes waiting on the surviving managed_job using the cursor from Brain 1!
    const finished = await reg.waitJob(managed.jobId, {
      leaseId: rebound.lease.leaseId,
      action: 'wait',
      timeoutMs: 5_000,
      fromCursor: managed.nextStdoutCursor,
    })
    assert.equal(finished.status, 'exited')
    assert.equal(finished.exitCode, 0)
    assert.ok(finished.stdout.includes('phase2'))

    // Cross-lease waitJob is rejected
    await assert.rejects(
      () => reg.waitJob(daemon.jobId, { leaseId: 'other-lease', action: 'status' }),
      (err: unknown) => err instanceof ExecEnvJobError && err.code === 'EXEC_JOB_LEASE_MISMATCH',
    )

    // 5. Environment migration tombstones active daemon and returns structured status instead of hanging
    const migrated = await reg.markEnvMigratedTombstones(lease1.leaseId, 'container_recreated')
    assert.ok(migrated.tombstonedJobIds.includes(daemon.jobId))
    const afterMigration = await reg.waitJob(daemon.jobId, {
      leaseId: lease1.leaseId,
      action: 'wait',
      timeoutMs: 1_000,
    })
    assert.equal(afterMigration.status, 'terminated_env_migrated')
    assert.equal(afterMigration.tombstoneReason, 'container_recreated')
    assert.ok(afterMigration.message?.includes('container_recreated'))
  })
})

describe('Layer 3 ExecEnvLeaseManager (Incarnation CAS & Monotonic Rebind)', () => {
  it('enforces incarnation ownerEpoch CAS and monotonic brainGen/fencingToken rules', async () => {
    let now = 10_000
    const mgr = new ExecEnvLeaseManager({ clock: () => now, defaultTtlMs: 5_000 })

    // Incarnation CAS
    mgr.registerIncarnation('env-1', 'inc-old', 1)
    mgr.registerIncarnation('env-1', 'inc-new', 2)
    assert.throws(
      () => mgr.registerIncarnation('env-1', 'inc-stale', 1),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_INCARNATION_EPOCH_STALE',
    )
    // Late teardown of old incarnation must NOT delete new incarnation route
    const lateUnreg = mgr.unregisterIncarnation('env-1', 'inc-old', 1)
    assert.equal(lateUnreg.removed, false)
    assert.equal(lateUnreg.reason, 'stale_owner_epoch')
    assert.equal(mgr.getIncarnation('env-1')?.incarnationId, 'inc-new')

    // Lease renew + monotonic rebind
    const lease = mgr.issueLease({
      execEnvId: 'env-1',
      incarnationId: 'inc-new',
      sessionKey: 'sess:1',
      brainGen: 1,
      fencingToken: 'ft-1',
      ttlMs: 5_000,
    })
    const renewed = mgr.renewLease(lease.leaseId, 5_000)
    assert.equal(renewed.expiresAtMs, lease.expiresAtMs + 5_000)

    await assert.rejects(
      () => mgr.rebindBrain(lease.leaseId, 1, 'ft-2'),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_BRAIN_GEN_NOT_MONOTONIC',
    )
    await assert.rejects(
      () => mgr.rebindBrain(lease.leaseId, 2, 'ft-1'),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_FENCING_TOKEN_REUSED',
    )

    await mgr.rebindBrain(lease.leaseId, 2, 'ft-2')
    // Cannot reuse revoked token ft-1 on brainGen 3
    await assert.rejects(
      () => mgr.rebindBrain(lease.leaseId, 3, 'ft-1'),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_FENCING_TOKEN_REUSED',
    )

    // Expiration check
    now += 20_000
    assert.throws(
      () => mgr.validateFencingToken(lease.leaseId, 'ft-2', 2),
      (err: unknown) => err instanceof ExecEnvLeaseError && err.code === 'EXEC_LEASE_EXPIRED',
    )
  })
})

describe('Layer 3 R8 ScopedCapabilityTokenAuthority (RFC 2104 HMAC-SHA256 & Anti-Replay)', () => {
  it('matches RFC 4231 Test Case 2 for RFC 2104 HMAC-SHA256 without forbidden crypto calls', () => {
    // RFC 4231 Section 4.3 Test Case 2: Key = "Jefe", Data = "what do ya want for nothing?"
    const mac = rfc2104HmacSha256('Jefe', 'what do ya want for nothing?').toString('hex')
    assert.equal(mac, '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    assert.equal(constantTimeBytesEqual(Buffer.from('abc'), Buffer.from('abc')), true)
    assert.equal(constantTimeBytesEqual(Buffer.from('abc'), Buffer.from('abd')), false)
    assert.equal(constantTimeBytesEqual(Buffer.from('abc'), Buffer.from('ab')), false)
  })

  it('prevents replay, cross-tool, cross-session, stale brainGen, expiry, and tampering', () => {
    let now = 1_000_000
    const auth = new ScopedCapabilityTokenAuthority({
      secret: '0123456789abcdef0123456789abcdef',
      defaultTtlMs: 10_000,
      maxConsumedNonces: 3,
      clock: () => now,
    })

    const { token, claims } = auth.issueToken({
      callId: 'call-1',
      toolName: 'read_file',
      sessionKey: 'sess:alpha',
      leaseId: 'lease-1',
      brainGen: 2,
    })
    assert.ok(token.startsWith(`${SCOPED_CAPABILITY_TOKEN_PREFIX}.`))
    assert.equal(claims.toolName, 'read_file')

    // Cross-tool rejection (does NOT consume nonce before mismatch)
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(token, {
          toolName: 'bash',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError && err.code === 'CAPABILITY_TOKEN_TOOL_MISMATCH',
    )

    // Cross-session rejection
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(token, {
          toolName: 'read_file',
          sessionKey: 'sess:beta',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError && err.code === 'CAPABILITY_TOKEN_SESSION_MISMATCH',
    )

    // Stale brainGen rejection
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(token, {
          toolName: 'read_file',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
          minBrainGen: 3,
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError &&
        err.code === 'CAPABILITY_TOKEN_BRAIN_GEN_STALE',
    )

    // Tampered token signature rejection
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(tampered, {
          toolName: 'read_file',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError &&
        err.code === 'CAPABILITY_TOKEN_SIGNATURE_INVALID',
    )

    // First valid consumption succeeds
    const verified = auth.verifyAndConsumeToken(token, {
      toolName: 'read_file',
      sessionKey: 'sess:alpha',
      leaseId: 'lease-1',
      callId: 'call-1',
      minBrainGen: 2,
    })
    assert.equal(verified.nonce, claims.nonce)

    // Replay is immediately rejected!
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(token, {
          toolName: 'read_file',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError && err.code === 'CAPABILITY_TOKEN_REPLAYED',
    )

    // Expired token rejection
    const { token: shortToken } = auth.issueToken({
      callId: 'call-exp',
      toolName: 'read_file',
      sessionKey: 'sess:alpha',
      leaseId: 'lease-1',
      brainGen: 2,
      ttlMs: 500,
    })
    now += 1_000
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(shortToken, {
          toolName: 'read_file',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError && err.code === 'CAPABILITY_TOKEN_EXPIRED',
    )

    // Bounded nonce table capacity (Warning #2): fail-closed when full of unexpired nonces (NEVER evict unexpired!)
    // Already holding 1 unexpired nonce (`token` above); consume 2 more to fill capacity (3/3)
    for (let i = 0; i < 2; i++) {
      const issued = auth.issueToken({
        callId: `c-${i}`,
        toolName: 'read_file',
        sessionKey: 'sess:alpha',
        leaseId: 'lease-1',
        brainGen: 2,
      })
      auth.verifyAndConsumeToken(issued.token, {
        toolName: 'read_file',
        sessionKey: 'sess:alpha',
        leaseId: 'lease-1',
      })
    }
    assert.equal(auth.consumedNonceCount, 3)

    // 4th unexpired token must fail-closed with CAPABILITY_TOKEN_REPLAY_CACHE_FULL
    const overflowToken = auth.issueToken({
      callId: 'c-overflow',
      toolName: 'read_file',
      sessionKey: 'sess:alpha',
      leaseId: 'lease-1',
      brainGen: 2,
    })
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(overflowToken.token, {
          toolName: 'read_file',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError &&
        err.code === 'CAPABILITY_TOKEN_REPLAY_CACHE_FULL',
    )

    // Original unexpired token MUST still be retained in replay cache (never evicted!)
    assert.throws(
      () =>
        auth.verifyAndConsumeToken(token, {
          toolName: 'read_file',
          sessionKey: 'sess:alpha',
          leaseId: 'lease-1',
        }),
      (err: unknown) =>
        err instanceof ScopedCapabilityTokenError && err.code === 'CAPABILITY_TOKEN_REPLAYED',
    )

    // Once previous entries expire, purging frees capacity and new tokens succeed
    now += 20_000
    const afterExpiry = auth.issueToken({
      callId: 'c-after-expiry',
      toolName: 'read_file',
      sessionKey: 'sess:alpha',
      leaseId: 'lease-1',
      brainGen: 2,
    })
    const okAfterPurge = auth.verifyAndConsumeToken(afterExpiry.token, {
      toolName: 'read_file',
      sessionKey: 'sess:alpha',
      leaseId: 'lease-1',
    })
    assert.equal(okAfterPurge.callId, 'c-after-expiry')
    assert.equal(auth.consumedNonceCount, 1)
  })
})

describe('Layer 3 Unified ToolBrokerServer (7 Gates: R8/R9/R10/R11, WAL, Concurrency, Blob Spill)', () => {
  it('enforces R10 fencingToken, R8 capabilityToken, R9 read_only & compound shell, R11 OCV5-800 hash', async () => {
    const leaseMgr = new ExecEnvLeaseManager()
    const capAuth = new ScopedCapabilityTokenAuthority({
      secret: 'broker-test-secret-0123456789abcdef',
    })
    const lease = leaseMgr.issueLease({
      execEnvId: 'env-1',
      incarnationId: 'inc-1',
      sessionKey: 'sess:broker',
      brainGen: 1,
      fencingToken: 'ft-gen-1',
    })

    let bashExecuted = 0
    let readExecuted = 0
    const detachedCards: DetachedApprovalCard[] = []

    const broker = new ToolBrokerServer({
      leaseManager: leaseMgr,
      capabilityAuthority: capAuth,
      walDir: makeTempWalDir(),
      detachedFallbackAfterMs: 40,
      onDetachedApprovalCard: (card) => detachedCards.push(card),
      approvalHandler: async (req, signal) => {
        if (req.command?.includes('git reset --hard')) {
          // Simulate slow human who never replies in time -> detached fallback
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return { decision: 'deny' }
        }
        return { decision: 'approve' }
      },
    })

    const bashSchema = {
      type: 'object',
      properties: {
        CommandLine: { type: 'string' },
      },
      required: ['CommandLine'],
    }
    const readSchema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    }

    broker.registerTool({
      canonicalName: 'bash',
      inputSchema: bashSchema,
      isShell: true,
      handler: (args) => {
        bashExecuted += 1
        return { ran: args.CommandLine }
      },
    })
    broker.registerTool({
      canonicalName: 'read_file',
      inputSchema: readSchema,
      readOnly: true,
      handler: (args) => {
        readExecuted += 1
        return { content: `read:${String(args.path)}` }
      },
    })

    const issueCap = (callId: string, toolName: string, brainGen = 1) =>
      capAuth.issueToken({
        callId,
        toolName,
        sessionKey: lease.sessionKey,
        leaseId: lease.leaseId,
        brainGen,
      }).token

    // R11 / OCV5-800: CLI-private `toolSummary` stripped -> 100% pass!
    const cleanArgs = { CommandLine: 'echo hello', toolSummary: 'Say hello' }
    const hashWithoutSummary = computeSchemaFilteredArgsSha256(
      { CommandLine: 'echo hello' },
      bashSchema,
    )
    const r11Pass = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-r11-pass',
        canonicalName: 'bash',
        arguments: cleanArgs,
        overrideArgsSha256: hashWithoutSummary,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-r11-pass', 'bash'),
    })
    assert.equal(r11Pass.status, 'ok')
    assert.equal(bashExecuted, 1)

    // R11: 1-byte tamper in schema-declared arg -> TOOL_ARGS_SCHEMA_HASH_MISMATCH, ZERO execution!
    const r11Tamper = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-r11-tamper',
        canonicalName: 'bash',
        arguments: { CommandLine: 'echo hellp', toolSummary: 'Say hello' },
        overrideArgsSha256: hashWithoutSummary,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-r11-tamper', 'bash'),
    })
    assert.equal(r11Tamper.status, 'denied')
    assert.equal(r11Tamper.errorCode, 'TOOL_ARGS_SCHEMA_HASH_MISMATCH')
    assert.equal(bashExecuted, 1)

    // R9: Compound destructive shell `echo ok && $(rm -rf /)` blocked by ActionPolicy -> ZERO execution!
    const compoundDeny = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-compound',
        canonicalName: 'bash',
        arguments: { CommandLine: 'echo ok && $(rm -rf /)' },
        inputSchema: bashSchema,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-compound', 'bash'),
    })
    assert.equal(compoundDeny.status, 'denied')
    assert.equal(compoundDeny.errorCode, 'ACTION_POLICY_DENIED')
    assert.equal(bashExecuted, 1)

    // R9: Shell efficiency guard blocks `sleep 120` in deny mode
    const sleepDeny = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-sleep',
        canonicalName: 'bash',
        arguments: { CommandLine: 'sleep 120' },
        inputSchema: bashSchema,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-sleep', 'bash'),
    })
    assert.equal(sleepDeny.status, 'denied')
    assert.equal(sleepDeny.errorCode, 'SHELL_EFFICIENCY_GUARD_DENIED')
    assert.equal(bashExecuted, 1)

    // R9: human_approval `blocking_then_detached` falls back cleanly after 40ms without hanging
    const detachedRes = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-detached',
        canonicalName: 'bash',
        arguments: { CommandLine: 'git reset --hard HEAD~1' },
        inputSchema: bashSchema,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-detached', 'bash'),
    })
    assert.equal(detachedRes.status, 'denied')
    assert.equal(detachedRes.errorCode, 'APPROVAL_DEFERRED_DETACHED')
    assert.equal(detachedRes.approvalStatus, 'detached_pending')
    assert.equal(detachedCards.length, 1)
    assert.equal(bashExecuted, 1)

    // R9: Monotonic policy tightening normal -> read_only blocks bash, allows read_file; relaxing throws!
    const normalPolicy: ExecutionPolicyEnvelope = {
      schemaVersion: 1,
      mode: 'normal',
      allowedTools: ['bash', 'read_file'],
      allowNetworkEgress: true,
      allowWorkspaceWrite: true,
      allowSubprocessSpawn: true,
    }
    const readOnlyPolicy: ExecutionPolicyEnvelope = {
      schemaVersion: 1,
      mode: 'read_only',
      allowedTools: ['read_file'],
      allowNetworkEgress: false,
      allowWorkspaceWrite: false,
      allowSubprocessSpawn: false,
    }
    broker.setPolicy(lease.leaseId, normalPolicy)
    broker.setPolicy(lease.leaseId, readOnlyPolicy)
    assert.throws(
      () => broker.setPolicy(lease.leaseId, normalPolicy),
      (err: unknown) =>
        err instanceof ToolBrokerPolicyError && err.code === 'EXEC_POLICY_RELAXATION_FORBIDDEN',
    )

    const roBash = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-ro-bash',
        canonicalName: 'bash',
        arguments: { CommandLine: 'echo nope' },
        inputSchema: bashSchema,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-ro-bash', 'bash'),
    })
    assert.equal(roBash.status, 'denied')
    assert.equal(roBash.errorCode, 'EXEC_POLICY_READ_ONLY_DENIED')

    const roRead = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-ro-read',
        canonicalName: 'read_file',
        arguments: { path: 'README.md' },
        inputSchema: readSchema,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-ro-read', 'read_file'),
    })
    assert.equal(roRead.status, 'ok')
    assert.equal(readExecuted, 1)

    // R10: After brain rebind, old fencingToken is rejected with EXEC_FENCING_TOKEN_STALE
    await leaseMgr.rebindBrain(lease.leaseId, 2, 'ft-gen-2')
    const staleBrainCall = await broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-2',
        callId: 'call-stale',
        canonicalName: 'read_file',
        arguments: { path: 'README.md' },
        inputSchema: readSchema,
      }),
      fencingToken: 'ft-gen-1',
      brainGen: 1,
      capabilityToken: issueCap('call-stale', 'read_file', 1),
    })
    assert.equal(staleBrainCall.status, 'denied')
    assert.equal(staleBrainCall.errorCode, 'EXEC_FENCING_TOKEN_STALE')
    assert.equal(readExecuted, 1)
  })

  it('supports Idempotency WAL (cached_receipt & unknown_effect_fenced), multi-concurrency, cancel, and blob_ref auto-spill', async () => {
    const spilledBlobs = new Map<string, { bytes: Uint8Array; mimeType: string; sha256: string }>()
    const broker = new ToolBrokerServer({
      maxConcurrentToolCalls: 4,
      maxInlinePayloadBytes: 128,
      walDir: makeTempWalDir(),
      spillBlob: async (bytes, mimeType) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const blobId = `spilled_${sha256.slice(0, 12)}`
        spilledBlobs.set(blobId, { bytes: new Uint8Array(bytes), mimeType, sha256 })
        return { blobId, sha256, mimeType, bytes: bytes.byteLength }
      },
      readSpilledBlob: (blobId) => spilledBlobs.get(blobId) ?? null,
    })

    let sideEffectRuns = 0
    broker.registerTool({
      canonicalName: 'side_effect',
      handler: async (args, ctx) => {
        sideEffectRuns += 1
        if (args.hang) {
          await new Promise<void>((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        return { count: sideEffectRuns }
      },
    })

    broker.registerTool({
      canonicalName: 'slow_concurrent',
      handler: async (args) => {
        await new Promise((r) => setTimeout(r, 40))
        return { slot: args.slot }
      },
    })

    broker.registerTool({
      canonicalName: 'big_output',
      handler: () => 'X'.repeat(512),
    })

    // 1. Idempotency WAL: completed call replay -> cached_receipt, handler runs only ONCE
    const call1 = makeCallEnvelope({
      leaseId: 'lease-wal',
      turnId: 'turn-1',
      callId: 'call-idem-1',
      canonicalName: 'side_effect',
      arguments: { op: 'charge' },
    })
    const first = await broker.invoke(call1)
    assert.equal(first.status, 'ok')
    assert.equal(first.replayStatus, 'executed')
    const replay = await broker.invoke(call1)
    assert.equal(replay.status, 'ok')
    assert.equal(replay.replayStatus, 'cached_receipt')
    assert.equal(sideEffectRuns, 1)

    // 2. Idempotency WAL: interrupted mid-flight call replay -> unknown_effect_fenced (fail-closed!)
    const callHang = makeCallEnvelope({
      leaseId: 'lease-wal',
      turnId: 'turn-1',
      callId: 'call-idem-hang',
      canonicalName: 'side_effect',
      arguments: { hang: true },
    })
    const hangingPromise = broker.invoke(callHang)
    await new Promise((r) => setTimeout(r, 15))
    const interruptedCount = broker.markLeaseDisconnected('lease-wal', 'ws_dropped')
    assert.equal(interruptedCount, 1)
    const hangResult = await hangingPromise
    assert.equal(hangResult.replayStatus, 'unknown_effect_fenced')

    const replayAfterDrop = await broker.invoke(callHang)
    assert.equal(replayAfterDrop.status, 'error')
    assert.equal(replayAfterDrop.errorCode, 'UNKNOWN_EFFECT_FENCED')
    assert.equal(replayAfterDrop.replayStatus, 'unknown_effect_fenced')
    assert.equal(sideEffectRuns, 2) // Never executed a 3rd time!

    // 3. Multi-concurrency execution (>1 concurrent calls break single-lock bottleneck)
    const concurrentResults = await Promise.all(
      [1, 2, 3, 4].map((slot) =>
        broker.invoke(
          makeCallEnvelope({
            leaseId: 'lease-conc',
            turnId: 'turn-1',
            callId: `call-conc-${slot}`,
            canonicalName: 'slow_concurrent',
            arguments: { slot },
          }),
        ),
      ),
    )
    assert.equal(concurrentResults.every((r) => r.status === 'ok'), true)
    assert.ok(broker.observedPeakConcurrency >= 3)

    // 4. Large output auto-spill to BlobRef (> 128 bytes)
    const bigRes = await broker.invoke(
      makeCallEnvelope({
        leaseId: 'lease-spill',
        turnId: 'turn-1',
        callId: 'call-big',
        canonicalName: 'big_output',
        arguments: {},
      }),
    )
    assert.equal(bigRes.status, 'ok')
    assert.ok(bigRes.spilledBlobId)
    const blobRef = bigRes.output as SpilledBlobRefOutput
    assert.equal(blobRef.type, 'blob_ref')
    assert.equal(blobRef.blobId, bigRes.spilledBlobId)
    assert.equal(blobRef.bytes, 512)
    assert.equal(spilledBlobs.get(blobRef.blobId)?.bytes.byteLength, 512)
  })
})

describe('Layer 3 ContainerLinkBrokerTransport (Multiplexed End-to-End Invoke, Stream & Rebind)', () => {
  it('multiplexes listCatalog, invoke, stream, cancel, and rebind over FrameLinkLike without polling', async () => {
    const leaseMgr = new ExecEnvLeaseManager()
    const lease = leaseMgr.issueLease({
      execEnvId: 'env-remote-1',
      incarnationId: 'inc-remote-1',
      sessionKey: 'sess:tunnel',
      hostKind: 'compute-pool-docker',
      brainGen: 1,
      fencingToken: 'ft-tunnel-1',
    })

    const broker = new ToolBrokerServer({
      leaseManager: leaseMgr,
      channelKind: 'ws_tunnel',
      walDir: makeTempWalDir(),
    })

    broker.registerTool({
      canonicalName: 'stream_echo',
      description: 'Streams stdout & stderr chunks',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (args, ctx) => {
        ctx.emitStdout(`out:${String(args.text)}`)
        ctx.emitStderr('err:trace')
        return { echoed: args.text }
      },
    })

    const rebindAuthority = new ScopedCapabilityTokenAuthority({
      secret: 'rebind-auth-secret-0123456789abcdef',
    })
    const [clientLink, hostLink] = createInMemoryFrameLinkPair()
    const host = new ContainerLinkToolBrokerHost({
      link: hostLink,
      server: broker,
      leaseManager: leaseMgr,
      rebindAuthority,
    })

    const client = openChannel('tool-broker', {
      link: clientLink,
      hostKind: 'compute-pool-docker',
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      brainGen: lease.brainGen,
      sessionKey: lease.sessionKey,
    })

    // Unrelated frames on the same multiplexed ContainerLink are safely ignored
    clientLink.send(JSON.stringify({ type: 'unrelated.heartbeat', ts: Date.now() }))

    // 1. listCatalog over ContainerLink
    const catalog = await client.listCatalog()
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0]?.canonicalName, 'stream_echo')

    // 2. invoke over ContainerLink
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    }
    const invokeRes = await client.invoke(
      makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-wire-1',
        canonicalName: 'stream_echo',
        arguments: { text: 'hello-wire', toolSummary: 'ignored-ui-field' },
        inputSchema: schema,
      }),
    )
    assert.equal(invokeRes.status, 'ok')
    assert.deepEqual(invokeRes.output, { echoed: 'hello-wire' })

    // 3. stream over ContainerLink
    const frames: ToolStreamFrame[] = []
    for await (const frame of client.stream(
      makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-1',
        callId: 'call-wire-stream-1',
        canonicalName: 'stream_echo',
        arguments: { text: 'live-chunk' },
        inputSchema: schema,
      }),
    )) {
      frames.push(frame)
    }
    assert.equal(frames[0]?.kind, 'tool_call')
    assert.ok(frames.some((f) => f.kind === 'tool_stdout' && f.chunk === 'out:live-chunk'))
    assert.ok(frames.some((f) => f.kind === 'tool_stderr' && f.chunk === 'err:trace'))
    assert.equal(frames[frames.length - 1]?.kind, 'tool_result')

    // 4. rebind over ContainerLink requires migration authority token + expectedCurrentBrainGen
    const rebindAuthToken = issueRebindAuthToken(rebindAuthority, {
      leaseId: lease.leaseId,
      sessionKey: lease.sessionKey,
      expectedCurrentBrainGen: 1,
      nextBrainGen: 2,
      nextFencingToken: 'ft-tunnel-2',
    })
    const ack = await client.rebind(2, 'ft-tunnel-2', {
      expectedCurrentBrainGen: 1,
      rebindAuthToken,
    })
    assert.equal(ack.brainGen, 2)
    assert.equal(client.activeFencingToken, 'ft-tunnel-2')

    const afterRebind = await client.invoke(
      makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-2',
        callId: 'call-wire-after-rebind',
        canonicalName: 'stream_echo',
        arguments: { text: 'post-rebind' },
        inputSchema: schema,
      }),
    )
    assert.equal(afterRebind.status, 'ok')
    assert.deepEqual(afterRebind.output, { echoed: 'post-rebind' })

    client.close()
    host.dispose()
  })

  it('B12: enforces same-generation fencing on broker.cancel, single-use authority on broker.rebind, and pre-side-effect fencing re-validation after approval/semaphore waits', async () => {
    const leaseMgr = new ExecEnvLeaseManager()
    const rebindAuthority = new ScopedCapabilityTokenAuthority({
      secret: 'b12-rebind-authority-secret-0123456789',
    })
    const lease = leaseMgr.issueLease({
      execEnvId: 'env-b12',
      incarnationId: 'inc-b12',
      sessionKey: 'sess:b12',
      hostKind: 'compute-pool-docker',
      brainGen: 1,
      fencingToken: 'ft-b12-gen-1',
    })

    let sideEffects = 0
    const hooks: { releaseBlocker: (() => void) | null; releaseApproval: (() => void) | null } = {
      releaseBlocker: null,
      releaseApproval: null,
    }
    let gen2Cancelled = false

    const broker = new ToolBrokerServer({
      leaseManager: leaseMgr,
      requireFencingToken: true,
      maxConcurrentToolCalls: 1,
      walDir: makeTempWalDir(),
      approvalHandler: async () => {
        await new Promise<void>((resolve) => {
          hooks.releaseApproval = resolve
        })
        return { decision: 'approve' }
      },
    })

    const bashSchema = {
      type: 'object',
      properties: { CommandLine: { type: 'string' } },
      required: ['CommandLine'],
    }
    const workSchema = {
      type: 'object',
      properties: { op: { type: 'string' } },
      required: ['op'],
    }

    broker.registerTool({
      canonicalName: 'bash',
      isShell: true,
      inputSchema: bashSchema,
      handler: () => {
        sideEffects += 1
        return { ok: true }
      },
    })
    broker.registerTool({
      canonicalName: 'side_work',
      inputSchema: workSchema,
      handler: async (args, ctx) => {
        if (args.op === 'hold_slot') {
          await new Promise<void>((resolve) => {
            hooks.releaseBlocker = resolve
            ctx.signal.addEventListener(
              'abort',
              () => {
                gen2Cancelled = true
                resolve()
              },
              { once: true },
            )
          })
          return { held: true }
        }
        sideEffects += 1
        return { op: args.op }
      },
    })

    const [clientLink, hostLink] = createInMemoryFrameLinkPair()
    const host = new ContainerLinkToolBrokerHost({
      link: hostLink,
      server: broker,
      leaseManager: leaseMgr,
      rebindAuthority,
    })

    const staleClient = openChannel('tool-broker', {
      link: clientLink,
      hostKind: 'compute-pool-docker',
      leaseId: lease.leaseId,
      fencingToken: 'ft-b12-gen-1',
      brainGen: 1,
      sessionKey: lease.sessionKey,
      channelId: 'ch-stale-gen1',
    })
    const activeClient = openChannel('tool-broker', {
      link: clientLink,
      hostKind: 'compute-pool-docker',
      leaseId: lease.leaseId,
      fencingToken: 'ft-b12-gen-1',
      brainGen: 1,
      sessionKey: lease.sessionKey,
      channelId: 'ch-active',
    })

    // 1. Unauthorized broker.rebind (bogus token) rejected with EXEC_REBIND_UNAUTHORIZED
    await assert.rejects(
      () =>
        activeClient.rebind(2, 'ft-b12-gen-2', {
          expectedCurrentBrainGen: 1,
          rebindAuthToken: 'forged-token',
        }),
      (err: unknown) =>
        err instanceof ToolBrokerTransportError && err.code === 'EXEC_REBIND_UNAUTHORIZED',
    )
    assert.equal(leaseMgr.getLease(lease.leaseId)?.brainGen, 1)

    // 2. Wrong expectedCurrentBrainGen rejected with EXEC_REBIND_UNAUTHORIZED
    const wrongGenToken = issueRebindAuthToken(rebindAuthority, {
      leaseId: lease.leaseId,
      sessionKey: lease.sessionKey,
      expectedCurrentBrainGen: 9,
      nextBrainGen: 10,
      nextFencingToken: 'ft-b12-gen-10',
    })
    await assert.rejects(
      () =>
        activeClient.rebind(10, 'ft-b12-gen-10', {
          expectedCurrentBrainGen: 9,
          rebindAuthToken: wrongGenToken,
        }),
      (err: unknown) =>
        err instanceof ToolBrokerTransportError && err.code === 'EXEC_REBIND_UNAUTHORIZED',
    )

    // 3. Queue two gen-1 calls:
    //    (a) one waiting on human approval (`git reset --hard`)
    //    (b) one occupying semaphore + one queued behind semaphore
    const approvalWaitingCall = broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-b12-1',
        callId: 'call-wait-approval',
        canonicalName: 'bash',
        arguments: { CommandLine: 'git reset --hard HEAD~1' },
        inputSchema: bashSchema,
      }),
      fencingToken: 'ft-b12-gen-1',
      brainGen: 1,
    })

    const blockerCall = broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-b12-1',
        callId: 'call-hold-slot',
        canonicalName: 'side_work',
        arguments: { op: 'hold_slot' },
        inputSchema: workSchema,
      }),
      fencingToken: 'ft-b12-gen-1',
      brainGen: 1,
    })
    await new Promise((r) => setTimeout(r, 15))

    const semaphoreQueuedCall = broker.invoke({
      ...makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-b12-1',
        callId: 'call-queued-sem',
        canonicalName: 'side_work',
        arguments: { op: 'queued_mutation' },
        inputSchema: workSchema,
      }),
      fencingToken: 'ft-b12-gen-1',
      brainGen: 1,
    })
    await new Promise((r) => setTimeout(r, 15))

    // 4. Perform authorized rebind 1 -> 2 while both gen-1 calls are waiting!
    const validRebindToken = issueRebindAuthToken(rebindAuthority, {
      leaseId: lease.leaseId,
      sessionKey: lease.sessionKey,
      expectedCurrentBrainGen: 1,
      nextBrainGen: 2,
      nextFencingToken: 'ft-b12-gen-2',
    })
    const rebindAck = await activeClient.rebind(2, 'ft-b12-gen-2', {
      expectedCurrentBrainGen: 1,
      rebindAuthToken: validRebindToken,
    })
    assert.equal(rebindAck.brainGen, 2)

    // Replaying the same single-use rebindAuthToken MUST be rejected!
    await assert.rejects(
      () =>
        activeClient.rebind(3, 'ft-b12-gen-3', {
          expectedCurrentBrainGen: 2,
          rebindAuthToken: validRebindToken,
        }),
      (err: unknown) =>
        err instanceof ToolBrokerTransportError && err.code === 'EXEC_REBIND_UNAUTHORIZED',
    )

    // Release approval and semaphore blocker -> BOTH gen-1 waiting calls MUST be rejected with EXEC_FENCING_TOKEN_STALE and ZERO sideEffects!
    hooks.releaseApproval?.()
    hooks.releaseBlocker?.()
    const [approvalRes, queuedRes] = await Promise.all([
      approvalWaitingCall,
      semaphoreQueuedCall,
      blockerCall,
    ])
    assert.equal(approvalRes.status, 'denied')
    assert.equal(approvalRes.errorCode, 'EXEC_FENCING_TOKEN_STALE')
    assert.equal(queuedRes.status, 'denied')
    assert.equal(queuedRes.errorCode, 'EXEC_FENCING_TOKEN_STALE')
    assert.equal(sideEffects, 0, 'queued/approved stale gen-1 calls must execute ZERO side effects')

    // 5. Stale gen-1 broker.cancel MUST be rejected with EXEC_FENCING_TOKEN_STALE and NOT cancel a gen-2 call!
    hooks.releaseBlocker = null
    gen2Cancelled = false
    const gen2CallPromise = activeClient.invoke(
      makeCallEnvelope({
        leaseId: lease.leaseId,
        turnId: 'turn-b12-2',
        callId: 'call-gen2-active',
        canonicalName: 'side_work',
        arguments: { op: 'hold_slot' },
        inputSchema: workSchema,
      }),
    )
    await new Promise((r) => setTimeout(r, 15))

    await assert.rejects(
      () => staleClient.cancel('call-gen2-active', 'stale_brain_late_cancel'),
      (err: unknown) =>
        err instanceof ToolBrokerTransportError && err.code === 'EXEC_FENCING_TOKEN_STALE',
    )
    assert.equal(gen2Cancelled, false, 'stale cancel frame must NEVER abort active gen-2 call')

    // Active gen-2 broker.cancel SUCCEEDS!
    await activeClient.cancel('call-gen2-active', 'active_brain_cancel')
    await gen2CallPromise
    assert.equal(gen2Cancelled, true)

    staleClient.close()
    activeClient.close()
    host.dispose()
  })
})

describe('Layer 3 B13 — Cross-Process Persistent Disk WAL in ToolBrokerServer', () => {
  it('replays cached_receipt across independent broker instances (count stays 1), rejects args conflict, and fences incomplete attempt as unknown_effect_fenced', async () => {
    const walDir = mkdtempSync(join(tmpdir(), 'oc-tool-broker-wal-'))
    let effectCounter = 0

    const registerCounterTool = (
      broker: ToolBrokerServer,
      opts?: { readonly hangOnCrashKey?: boolean },
    ) => {
      broker.registerTool({
        canonicalName: 'charge_ledger',
        inputSchema: {
          type: 'object',
          properties: {
            amountFen: { type: 'number' },
            mode: { type: 'string' },
          },
          required: ['amountFen'],
        },
        handler: async (args) => {
          effectCounter += 1
          if (opts?.hangOnCrashKey && args.mode === 'crash_mid_flight') {
            // Simulate process crash after attempt was durably persisted on disk and handler started
            await new Promise<void>(() => {})
          }
          return { chargedFen: args.amountFen, runNumber: effectCounter }
        },
      })
    }

    const schema = {
      type: 'object',
      properties: {
        amountFen: { type: 'number' },
        mode: { type: 'string' },
      },
      required: ['amountFen'],
    }

    try {
      // (a) Instance 1 executes successfully (count=1) -> dispose/discard Instance 1 -> Instance 2 returns cached_receipt (count STILL 1!)
      const broker1 = new ToolBrokerServer({ walDir })
      registerCounterTool(broker1)

      const callA = makeCallEnvelope({
        leaseId: 'lease-wal-disk',
        turnId: 'turn-wal-1',
        callId: 'call-wal-ok',
        canonicalName: 'charge_ledger',
        arguments: { amountFen: 500 },
        inputSchema: schema,
      })

      const res1 = await broker1.invoke(callA)
      assert.equal(res1.status, 'ok')
      assert.equal(res1.replayStatus, 'executed')
      assert.deepEqual(res1.output, { chargedFen: 500, runNumber: 1 })
      assert.equal(effectCounter, 1)
      assert.equal(existsSync(join(walDir, `${callA.idempotencyKey}.attempt.json`)), true)
      assert.equal(existsSync(join(walDir, `${callA.idempotencyKey}.result.json`)), true)

      // New independent ToolBrokerServer instance sharing the same walDir (simulated process restart)
      const broker2 = new ToolBrokerServer({ walDir })
      registerCounterTool(broker2)

      const res2 = await broker2.invoke(callA)
      assert.equal(res2.status, 'ok')
      assert.equal(res2.replayStatus, 'cached_receipt')
      assert.deepEqual(res2.output, { chargedFen: 500, runNumber: 1 })
      assert.equal(effectCounter, 1, 'replayed call on restarted instance must NEVER re-run handler')

      // Same idempotencyKey with different argsSchemaSha256 throws TOOL_IDEMPOTENCY_ARGS_CONFLICT
      const mutatedCallA = makeCallEnvelope({
        leaseId: 'lease-wal-disk',
        turnId: 'turn-wal-1',
        callId: 'call-wal-ok',
        canonicalName: 'charge_ledger',
        arguments: { amountFen: 999 },
        inputSchema: schema,
      })
      assert.equal(mutatedCallA.idempotencyKey, callA.idempotencyKey)
      await assert.rejects(
        () => broker2.invoke(mutatedCallA),
        (err: unknown) =>
          err instanceof ToolBrokerPolicyError && err.code === 'TOOL_IDEMPOTENCY_ARGS_CONFLICT',
      )
      assert.equal(effectCounter, 1)

      // (b) Instance 1 persists attempt and "crashes" before writing result -> Instance 2 fails closed with unknown_effect_fenced
      const brokerCrash1 = new ToolBrokerServer({ walDir })
      registerCounterTool(brokerCrash1, { hangOnCrashKey: true })

      const callCrash = makeCallEnvelope({
        leaseId: 'lease-wal-disk',
        turnId: 'turn-wal-2',
        callId: 'call-wal-crash',
        canonicalName: 'charge_ledger',
        arguments: { amountFen: 750, mode: 'crash_mid_flight' },
        inputSchema: schema,
      })

      // Fire callCrash on brokerCrash1; wait briefly until attempt file is on disk and handler entered (count=2), then abandon brokerCrash1
      void brokerCrash1.invoke(callCrash)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(effectCounter, 2)
      assert.equal(existsSync(join(walDir, `${callCrash.idempotencyKey}.attempt.json`)), true)
      assert.equal(existsSync(join(walDir, `${callCrash.idempotencyKey}.result.json`)), false)

      // New independent instance brokerCrash2 starts up with the same walDir
      const brokerCrash2 = new ToolBrokerServer({ walDir })
      registerCounterTool(brokerCrash2)

      const crashReplay = await brokerCrash2.invoke(callCrash)
      assert.equal(crashReplay.status, 'error')
      assert.equal(crashReplay.isError, true)
      assert.equal(crashReplay.errorCode, 'UNKNOWN_EFFECT_FENCED')
      assert.equal(crashReplay.replayStatus, 'unknown_effect_fenced')
      assert.equal(
        effectCounter,
        2,
        'handler MUST NEVER run a second time when persisted attempt lacks result',
      )
    } finally {
      rmSync(walDir, { recursive: true, force: true })
    }
  })

  it('B13-R2: refuses side-effecting tools without walDir by default and persists large spilled blobs to disk across restarts', async () => {
    // 1. Default ToolBrokerServer without walDir MUST refuse side-effecting tool BEFORE handler runs
    const ephemeralBroker = new ToolBrokerServer()
    let sideEffectRuns = 0
    let readOnlyRuns = 0
    ephemeralBroker.registerTool({
      canonicalName: 'write_file',
      readOnly: false,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: () => {
        sideEffectRuns += 1
        return { written: true }
      },
    })
    ephemeralBroker.registerTool({
      canonicalName: 'read_file',
      readOnly: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: () => {
        readOnlyRuns += 1
        return { content: 'ok' }
      },
    })

    const deniedSideEffect = await ephemeralBroker.invoke(
      makeCallEnvelope({
        leaseId: 'lease-no-wal',
        turnId: 'turn-1',
        callId: 'call-no-wal-write',
        canonicalName: 'write_file',
        arguments: { path: 'a.txt' },
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }),
    )
    assert.equal(deniedSideEffect.status, 'denied')
    assert.equal(deniedSideEffect.errorCode, 'TOOL_BROKER_DURABLE_WAL_REQUIRED')
    assert.equal(sideEffectRuns, 0, 'side-effect handler must never run without durable WAL')

    const allowedReadOnly = await ephemeralBroker.invoke(
      makeCallEnvelope({
        leaseId: 'lease-no-wal',
        turnId: 'turn-1',
        callId: 'call-no-wal-read',
        canonicalName: 'read_file',
        arguments: { path: 'a.txt' },
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }),
    )
    assert.equal(allowedReadOnly.status, 'ok')
    assert.equal(readOnlyRuns, 1)

    // 2. Two independent broker instances with walDir persist & recover large spilled output bytes
    const walDir = mkdtempSync(join(tmpdir(), 'ocv5-b13-spill-wal-'))
    try {
      const largePayload = 'Z'.repeat(1024)
      let spillToolRuns = 0
      const schema = { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] }

      const broker1 = new ToolBrokerServer({ walDir, maxInlinePayloadBytes: 128 })
      broker1.registerTool({
        canonicalName: 'emit_large_side_effect',
        readOnly: false,
        inputSchema: schema,
        handler: () => {
          spillToolRuns += 1
          return largePayload
        },
      })

      const call = makeCallEnvelope({
        leaseId: 'lease-spill-disk',
        turnId: 'turn-1',
        callId: 'call-large-1',
        canonicalName: 'emit_large_side_effect',
        arguments: { tag: 'v1' },
        inputSchema: schema,
      })

      const res1 = await broker1.invoke(call)
      assert.equal(res1.status, 'ok')
      assert.equal(res1.replayStatus, 'executed')
      assert.equal(spillToolRuns, 1)
      assert.ok(res1.spilledBlobId)
      const ref1 = res1.output as SpilledBlobRefOutput
      assert.equal(ref1.type, 'blob_ref')
      assert.equal(ref1.bytes, 1024)
      assert.equal(ref1.byteLength, 1024)
      const expectedSpillPath = join(walDir, 'spill', `${ref1.sha256}.bin`)
      assert.equal(existsSync(expectedSpillPath), true, 'large output must be persisted to <walDir>/spill/<sha256>.bin')

      // Restarted independent broker2 reads cached receipt AND recovers exact persisted spill bytes with SHA-256 verification
      const broker2 = new ToolBrokerServer({ walDir, maxInlinePayloadBytes: 128 })
      broker2.registerTool({
        canonicalName: 'emit_large_side_effect',
        readOnly: false,
        inputSchema: schema,
        handler: () => {
          spillToolRuns += 1
          return largePayload
        },
      })

      const res2 = await broker2.invoke(call)
      assert.equal(res2.status, 'ok')
      assert.equal(res2.replayStatus, 'cached_receipt')
      assert.equal(spillToolRuns, 1, 'large spilled tool must not re-run across restart')
      const recovered = broker2.getSpilledBlob(res2.spilledBlobId!)
      assert.ok(recovered !== null, 'restarted broker must recover spilled bytes from disk')
      assert.equal(Buffer.from(recovered.bytes).toString('utf8'), largePayload)
      assert.equal(
        createHash('sha256').update(recovered.bytes).digest('hex'),
        ref1.sha256,
      )
      const verifiedPayload = broker2.readSpilledBlobVerified(res2.output as SpilledBlobRefOutput)
      assert.equal(verifiedPayload.sha256, ref1.sha256)
      assert.equal(verifiedPayload.byteLength, 1024)
      assert.equal(Buffer.from(verifiedPayload.bytes).toString('utf8'), largePayload)

      // Corrupting 1 byte of <walDir>/spill/<sha256>.bin makes fresh broker3 fail closed with TOOL_SPILLED_BLOB_CORRUPT
      writeFileSync(expectedSpillPath, Buffer.from(`X${'Z'.repeat(1023)}`, 'utf8'))
      const broker3 = new ToolBrokerServer({ walDir, maxInlinePayloadBytes: 128 })
      broker3.registerTool({
        canonicalName: 'emit_large_side_effect',
        readOnly: false,
        inputSchema: schema,
        handler: () => {
          spillToolRuns += 1
          return largePayload
        },
      })
      const res3 = await broker3.invoke(call)
      assert.equal(res3.status, 'error')
      assert.equal(res3.isError, true)
      assert.equal(res3.errorCode, 'TOOL_SPILLED_BLOB_CORRUPT')
      assert.equal(res3.replayStatus, 'unknown_effect_fenced')
      assert.equal(spillToolRuns, 1)
      assert.throws(
        () => broker3.readSpilledBlobVerified(ref1),
        (err: unknown) =>
          err instanceof ToolBrokerPolicyError && err.code === 'TOOL_SPILLED_BLOB_CORRUPT',
      )

      // Deleting persisted spill blob makes fresh broker4 fail closed with TOOL_SPILLED_BLOB_MISSING
      rmSync(expectedSpillPath, { force: true })
      const broker4 = new ToolBrokerServer({ walDir, maxInlinePayloadBytes: 128 })
      broker4.registerTool({
        canonicalName: 'emit_large_side_effect',
        readOnly: false,
        inputSchema: schema,
        handler: () => {
          spillToolRuns += 1
          return largePayload
        },
      })
      const res4 = await broker4.invoke(call)
      assert.equal(res4.status, 'error')
      assert.equal(res4.isError, true)
      assert.equal(res4.errorCode, 'TOOL_SPILLED_BLOB_MISSING')
      assert.equal(res4.replayStatus, 'unknown_effect_fenced')
      assert.equal(spillToolRuns, 1)
    } finally {
      rmSync(walDir, { recursive: true, force: true })
    }
  })

  it('B13-R2(b): reads back legacy spilled/<24hex>.bin receipts with full SHA-256 verification (zero handler replay) and fails closed on 1-byte corruption', async () => {
    const schema = { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] }
    const legacyPayload = 'L'.repeat(1024)
    const legacyBytes = Buffer.from(legacyPayload, 'utf8')
    const fullSha256 = createHash('sha256').update(legacyBytes).digest('hex')
    const legacyBlobId = `blob_${fullSha256.slice(0, 24)}`

    const call = makeCallEnvelope({
      leaseId: 'lease-legacy-spill',
      turnId: 'turn-legacy-1',
      callId: 'call-legacy-large',
      canonicalName: 'legacy_large_tool',
      arguments: { tag: 'old-writer' },
      inputSchema: schema,
    })

    const seedLegacyWalDir = (dir: string, payloadBytes: Buffer) => {
      const legacyDir = join(dir, 'spilled')
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, `${legacyBlobId}.bin`), payloadBytes)
      writeFileSync(
        join(legacyDir, `${legacyBlobId}.meta.json`),
        JSON.stringify({
          sha256: fullSha256,
          mimeType: 'text/plain; charset=utf-8',
          bytes: legacyBytes.byteLength,
        }),
      )
      const legacyResult: DiskWalResultRecord = {
        schemaVersion: 1,
        idempotencyKey: call.idempotencyKey,
        callId: call.callId,
        toolName: call.canonicalName,
        argsSchemaSha256: call.argsSha256,
        leaseId: call.leaseId,
        brainGen: null,
        finalizedAtMs: Date.now(),
        receipt: {
          schemaVersion: 1,
          leaseId: call.leaseId,
          turnId: call.turnId,
          callId: call.callId,
          idempotencyKey: call.idempotencyKey,
          status: 'ok',
          spilledBlobId: legacyBlobId,
          replayStatus: 'executed',
          approvalStatus: 'not_required',
          durationMs: 5,
          output: {
            type: 'blob_ref',
            blobId: legacyBlobId,
            sha256: fullSha256,
            mimeType: 'text/plain; charset=utf-8',
            bytes: legacyBytes.byteLength,
          },
        },
      }
      writeFileSync(join(dir, `${call.idempotencyKey}.result.json`), JSON.stringify(legacyResult))
    }

    // 1. Intact legacy spilled/<24hex>.bin -> new reader verifies full SHA-256 & returns cached_receipt (handlerRuns = 0!)
    const walDirIntact = makeTempWalDir('ocv5-b13-legacy-ok-')
    seedLegacyWalDir(walDirIntact, legacyBytes)
    let intactHandlerRuns = 0
    const newReader = new ToolBrokerServer({ walDir: walDirIntact, maxInlinePayloadBytes: 128 })
    newReader.registerTool({
      canonicalName: 'legacy_large_tool',
      readOnly: false,
      inputSchema: schema,
      handler: () => {
        intactHandlerRuns += 1
        return 'MUST_NEVER_RE_RUN'
      },
    })

    const replayed = await newReader.invoke(call)
    assert.equal(replayed.status, 'ok')
    assert.equal(replayed.replayStatus, 'cached_receipt')
    assert.equal(intactHandlerRuns, 0, 'legacy receipt replay MUST NEVER re-run handler')
    const recoveredById = newReader.getSpilledBlob(legacyBlobId)
    assert.ok(recoveredById !== null)
    assert.equal(Buffer.from(recoveredById.bytes).toString('utf8'), legacyPayload)
    assert.equal(recoveredById.sha256, fullSha256)
    const verifiedLegacy = newReader.readSpilledBlobVerified(replayed.output as SpilledBlobRefOutput)
    assert.equal(verifiedLegacy.sha256, fullSha256)
    assert.equal(Buffer.from(verifiedLegacy.bytes).toString('utf8'), legacyPayload)

    // 2. 1-byte tampered legacy spilled/<24hex>.bin -> fail-closed TOOL_SPILLED_BLOB_CORRUPT, handlerRuns = 0!
    const walDirCorrupt = makeTempWalDir('ocv5-b13-legacy-corrupt-')
    seedLegacyWalDir(walDirCorrupt, Buffer.from(`X${'L'.repeat(1023)}`, 'utf8'))
    let corruptHandlerRuns = 0
    const corruptReader = new ToolBrokerServer({ walDir: walDirCorrupt, maxInlinePayloadBytes: 128 })
    corruptReader.registerTool({
      canonicalName: 'legacy_large_tool',
      readOnly: false,
      inputSchema: schema,
      handler: () => {
        corruptHandlerRuns += 1
        return 'MUST_NEVER_RE_RUN'
      },
    })

    const corruptReplay = await corruptReader.invoke(call)
    assert.equal(corruptReplay.status, 'error')
    assert.equal(corruptReplay.isError, true)
    assert.equal(corruptReplay.errorCode, 'TOOL_SPILLED_BLOB_CORRUPT')
    assert.equal(corruptReplay.replayStatus, 'unknown_effect_fenced')
    assert.equal(corruptHandlerRuns, 0, 'corrupt legacy spill MUST NEVER re-run handler')
  })

  it('B13-R2(c): rejects durableWalAdapter-only without durable spill storage before handler, and recovers verified large blobs across restart when durable spill storage is provided', async () => {
    const schema = { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }
    const attempts = new Map<string, DiskWalAttemptRecord>()
    const results = new Map<string, DiskWalResultRecord>()
    const blobs = new Map<string, { bytes: Uint8Array; mimeType: string; sha256: string }>()

    const walOnlyAdapter: ToolBrokerDurableWalAdapter = {
      durable: true,
      writeAttempt: (rec) => {
        if (attempts.has(rec.idempotencyKey)) return 'exists'
        attempts.set(rec.idempotencyKey, rec)
        return 'created'
      },
      writeResult: (rec) => {
        results.set(rec.idempotencyKey, rec)
      },
      readAttempt: (k) => attempts.get(k) ?? null,
      readResult: (k) => results.get(k) ?? null,
    }

    // 1. durableWalAdapter-only (no walDir, no durable spill read/write) -> fail-closed BEFORE handler runs!
    let rejectedRuns = 0
    const incompleteBroker = new ToolBrokerServer({
      durableWalAdapter: walOnlyAdapter,
      maxInlinePayloadBytes: 128,
    })
    incompleteBroker.registerTool({
      canonicalName: 'adapter_large_op',
      readOnly: false,
      inputSchema: schema,
      handler: () => {
        rejectedRuns += 1
        return 'A'.repeat(512)
      },
    })
    const denied = await incompleteBroker.invoke(
      makeCallEnvelope({
        leaseId: 'lease-adapter-no-spill',
        turnId: 'turn-1',
        callId: 'call-adapter-denied',
        canonicalName: 'adapter_large_op',
        arguments: { op: 'write' },
        inputSchema: schema,
      }),
    )
    assert.equal(denied.status, 'denied')
    assert.equal(denied.errorCode, 'TOOL_BROKER_DURABLE_SPILL_REQUIRED')
    assert.equal(rejectedRuns, 0, 'handler MUST NOT run when durableWalAdapter lacks durable spill storage')

    // 2. durableWalAdapter WITH durable spill read/write -> persists & verifies across independent broker restart!
    const fullAdapter: ToolBrokerDurableWalAdapter = {
      ...walOnlyAdapter,
      writeSpilledBlob: (blobId, bytes, meta) => {
        blobs.set(blobId, {
          bytes: new Uint8Array(bytes),
          mimeType: meta.mimeType,
          sha256: meta.sha256,
        })
      },
      readSpilledBlob: (blobId) => blobs.get(blobId) ?? null,
    }

    const largeText = 'M'.repeat(600)
    let adapterRuns = 0
    const callOk = makeCallEnvelope({
      leaseId: 'lease-adapter-full',
      turnId: 'turn-1',
      callId: 'call-adapter-ok',
      canonicalName: 'adapter_large_op',
      arguments: { op: 'write_large' },
      inputSchema: schema,
    })

    const broker1 = new ToolBrokerServer({
      durableWalAdapter: fullAdapter,
      maxInlinePayloadBytes: 128,
    })
    broker1.registerTool({
      canonicalName: 'adapter_large_op',
      readOnly: false,
      inputSchema: schema,
      handler: () => {
        adapterRuns += 1
        return largeText
      },
    })

    const res1 = await broker1.invoke(callOk)
    assert.equal(res1.status, 'ok')
    assert.equal(res1.replayStatus, 'executed')
    assert.equal(adapterRuns, 1)
    assert.ok(res1.spilledBlobId)
    const ref1 = res1.output as SpilledBlobRefOutput

    // Independent restarted broker2 sharing fullAdapter replays cached_receipt and reads verified bytes
    const broker2 = new ToolBrokerServer({
      durableWalAdapter: fullAdapter,
      maxInlinePayloadBytes: 128,
    })
    broker2.registerTool({
      canonicalName: 'adapter_large_op',
      readOnly: false,
      inputSchema: schema,
      handler: () => {
        adapterRuns += 1
        return largeText
      },
    })

    const res2 = await broker2.invoke(callOk)
    assert.equal(res2.status, 'ok')
    assert.equal(res2.replayStatus, 'cached_receipt')
    assert.equal(adapterRuns, 1)
    const verified = broker2.readSpilledBlobVerified(res2.output as SpilledBlobRefOutput)
    assert.equal(verified.sha256, ref1.sha256)
    assert.equal(Buffer.from(verified.bytes).toString('utf8'), largeText)

    // Tampering adapter spill bytes makes fresh broker3 fail closed with TOOL_SPILLED_BLOB_CORRUPT
    blobs.set(res2.spilledBlobId!, {
      bytes: Buffer.from(`X${'M'.repeat(599)}`, 'utf8'),
      mimeType: ref1.mimeType,
      sha256: ref1.sha256,
    })
    const broker3 = new ToolBrokerServer({
      durableWalAdapter: fullAdapter,
      maxInlinePayloadBytes: 128,
    })
    broker3.registerTool({
      canonicalName: 'adapter_large_op',
      readOnly: false,
      inputSchema: schema,
      handler: () => {
        adapterRuns += 1
        return largeText
      },
    })
    const res3 = await broker3.invoke(callOk)
    assert.equal(res3.status, 'error')
    assert.equal(res3.errorCode, 'TOOL_SPILLED_BLOB_CORRUPT')
    assert.equal(res3.replayStatus, 'unknown_effect_fenced')
    assert.equal(adapterRuns, 1)
  })
})
