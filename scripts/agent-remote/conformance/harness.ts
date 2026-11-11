/**
 * End-to-end Conformance Harness (`OCV5-749` `AC-1`, `AC-2`):
 *
 * Supports two execution modes with ZERO per-engine branches in `runner.ts`:
 *   1. `sandbox`: hermetic `/tmp/oc-drvtest-*` local controller + protocol CLI fixtures (used for
 *      `example_echo` `AC-2` proof, fast CI gates, and isolated Red fault-injection controls).
 *   2. `live-node`: production `RemotePoolSshHost.forSshTarget` over real OpenSSH + `guard.py` +
 *      `controller.py` + real `systemd --user` cgroup scopes + real native CLI (`claude` / `codex`) +
 *      real Redis (`TEST_REDIS_URL`) + real `Cc5ToolHost` + real PostgreSQL (`0339_remote_driver_core_v4`).
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Redis } from 'ioredis'
import { Client, Pool } from 'pg'
import {
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  remoteCanonicalJson,
  turnLeaseSigningInput,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteDriverUsagePolicy,
  type RemoteProbeSnapshot,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import { Cc5ToolHost } from '../../../packages/gateway/src/cc5ToolHost.js'
import type { EngineBillingEvent, EngineEvent } from '../../../packages/gateway/src/engine/engineEvents.js'
import type { TurnParams } from '../../../packages/gateway/src/engine/engineAdapter.js'
import {
  DriverWorkerClient,
  RemoteEngineAdapter,
  RemotePoolRelay,
  RemotePoolSshHost,
  remotePoolBackendOf,
  remotePoolControlRequest,
  type LaneToolHost,
  type RemoteDriverPlacementResult,
  type RemotePoolFinancePort,
  type RemotePoolLaneSpec,
} from '../../../packages/gateway/src/remotePool/index.js'
import '../../../packages/gateway/src/remotePool/registerRemoteDriver.js'
import {
  claimDriverVerificationRun,
  completeDriverVerificationRun,
  computeProbeFingerprintTs,
  loadRemoteDriverRegistry,
  placeRemoteDriverLane,
  recordDriverProbeSnapshot,
  recordRemoteDriverLaneState,
  type PlaceRemoteDriverLaneOptions,
  type RemoteDriverRegistryEntry,
} from '../../../packages/commercial/src/account-pool/remotePool/index.js'
import { remoteNodeExecKeyDir } from '../../../packages/commercial/src/account-pool/remoteBrainPool.js'
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
} from '../../../packages/commercial/src/billing/modelCatalog.js'
import { wrapIoredisForPreCheck } from '../../../packages/commercial/src/billing/preCheck.js'
import {
  createRemoteDriverTurnFinance,
  recoverRemoteDriverTurnBilling,
} from '../../../packages/commercial/src/billing/remoteDriverTurnBilling.js'
import { recoverRemoteNativeTurnBilling } from '../../../packages/commercial/src/billing/remoteNativeTurnBilling.js'
import { closePool, setPoolOverride } from '../../../packages/commercial/src/db/index.js'
import { runMigrations } from '../../../packages/commercial/src/db/migrate.js'
import { createLogger } from '../../../packages/commercial/src/logging/logger.js'
import { prepareDriverSandbox, type DriverSandboxPrepared } from './fixtures.js'

const execFileAsync = promisify(execFile)

const CONTROLLER_PATH = fileURLToPath(new URL('../core/controller.py', import.meta.url))
const MCP_CLIENT_PATH = fileURLToPath(new URL('../core/mcp_client.py', import.meta.url))
const BOX_BRIDGE_DIR = fileURLToPath(
  new URL('../../../packages/gateway/box-bridge-mod', import.meta.url),
)

const BOX_BRIDGE_PLUGIN_FILES = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/register.ts',
  'hooks/frames.ts',
] as const

export const PRICING_RATES = {
  inputPerMtok: 1_000_000n,
  outputPerMtok: 5_000_000n,
  cacheReadPerMtok: 100_000n,
  cacheWritePerMtok: 1_250_000n,
} as const

export type ConformanceMode = 'sandbox' | 'live-node'

export interface LiveNodeConfig {
  readonly sshHost: string
  readonly sshPort?: number
  readonly sshUser?: string
  readonly keyId: string
  readonly hostKeyFp: string
  readonly adminSshCmd: string
  readonly adminRunAsUserPrefix?: string
  readonly upstreamModel: string
  readonly canonicalModel: string
  readonly profileName?: string
  readonly probeContext: Record<string, unknown>
  readonly driverContext: Record<string, unknown>
  readonly loadBoxBridgeForDriver?: boolean
  readonly sshConnectCooldownMs?: number
  readonly sshProxyCommands?: readonly string[]
}

export interface ToolExecutionBarrier {
  readonly onArrive: () => void
  readonly waitRelease: Promise<void>
  readonly abortExecution?: () => boolean
}

export interface OpenLaneOptions {
  readonly sessionKey?: string
  readonly sessionIndex?: number
  readonly memAvailableBytes?: number
  readonly nodeMemoryBudgetBytes?: number
  readonly maxSliceMemoryBytes?: number
  readonly extraDriverContext?: Record<string, unknown>
  readonly toolAuthorizeTimeoutMs?: number
  readonly toolExecutionBarrier?: ToolExecutionBarrier
  readonly disallowedTools?: readonly string[]
  readonly observationOptions?: {
    readonly testFaultBypassObservation?: boolean
    readonly allowTestBypassInTmp?: boolean
    readonly authorizeTimeoutMs?: number
  }
  readonly containerObservationOptions?: {
    readonly testFaultBypassObservation?: boolean
    readonly allowTestBypassInTmp?: boolean
  }
  readonly callInterceptor?: (
    path: string,
    body: Readonly<Record<string, unknown>>,
    defaultCall: (p: string, b: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>
  readonly customHostFactory?: (
    toolRoot: string,
    lifecycleId: string,
    containerCwd: string,
    containerHome: string,
  ) => LaneToolHost
  readonly failTurnInsertOnce?: { active: boolean }
  readonly autoRecordStopState?: boolean
  readonly dedicatedToolHost?: boolean
  readonly writeOnlyTools?: boolean
}

export interface SubmittedTurnHandle {
  readonly requestId: string
  readonly authorityTurnId: string
  readonly turnKey: string
  readonly authorityEnvelope: string
  readonly leaseEnvelope: string
  readonly events: EngineEvent[]
  readonly run: ReturnType<RemoteEngineAdapter['submitTurn']>
}

export interface SessionLaneHandle {
  readonly isFaultSandbox: boolean
  readonly placed: RemoteDriverPlacementResult
  readonly sandboxPrep: DriverSandboxPrepared
  readonly containerCwd: string
  readonly containerHome: string
  readonly containerExecRoot: string
  readonly journalDir: string
  readonly socketPath: string
  readonly host: RemotePoolSshHost
  readonly relay: RemotePoolRelay
  readonly adapter: RemoteEngineAdapter
  readonly executedCalls: Array<{
    readonly name: string
    readonly args: Record<string, unknown>
    readonly toolUseId: string
  }>
  readonly settledReceipts: RemoteReceiptV4[]
  readonly billingEvents: EngineBillingEvent[]
  readonly stopNotifications: Array<Record<string, unknown>>
  readonly getStopEvidence: () => unknown
  readonly getFenceDiag: () => string
  readonly submitTurn: (prompt: string, requestIdOverride?: string) => Promise<SubmittedTurnHandle>
  readonly closeLane: () => Promise<void>
}

export interface ConformanceHarness {
  readonly mode: ConformanceMode
  readonly targetHost: string
  readonly sshMode: 'local-sandbox' | 'real-ssh-guard'
  readonly driverId: string
  readonly registryPath?: string
  readonly reg: RemoteDriverRegistryEntry
  readonly pool: Pool
  readonly sandbox: string
  readonly resRoot: string
  readonly fakeSys: string
  readonly evidenceSpoolRoot: string
  readonly uid: string
  readonly nodeId: string
  readonly profileId: string
  readonly profileName: string
  readonly authEpoch: string
  readonly peerDriverId: string
  readonly peerProfileId: string
  readonly peerCanonicalModel: string
  readonly canonicalModel: string
  readonly upstreamModel: string
  readonly expectedPolicySha256: string
  readonly probedSnapshot: RemoteProbeSnapshot
  readonly probeFingerprint: string
  readonly usagePolicy: RemoteDriverUsagePolicy
  readonly worker: DriverWorkerClient
  readonly barrierTimeoutMs: number
  readonly placeLaneOptions: (extra?: Partial<PlaceRemoteDriverLaneOptions>) => PlaceRemoteDriverLaneOptions
  readonly buildWritePrompt: (filePath: string, content: string, dupConcurrent?: boolean) => string
  readonly buildNativeDangerPrompt: (dangerPath: string) => string
  readonly taskFileExists: (taskRoot: string, relPath?: string) => Promise<boolean>
  readonly readTaskFileUtf8: (taskRoot: string, relPath: string) => Promise<string>
  readonly readTaskFileBytes: (taskRoot: string, relPath: string) => Promise<Buffer>
  readonly writeTaskFileBytes: (
    taskRoot: string,
    relPath: string,
    data: Buffer,
    mode?: number,
  ) => Promise<void>
  readonly postTaskToolSockRoundtrip: (
    taskRoot: string,
    payloadBytes: Buffer,
  ) => Promise<{ status: number; body: string }>
  readonly verifyTaskWalReplay: (
    taskRoot: string,
    callId: string,
  ) => Promise<{ cachedReplayStatus: number; inflightDuplicateStatus: number }>
  readonly openLane: (opts?: OpenLaneOptions) => Promise<SessionLaneHandle>
  readonly openFaultInjectionLane: (opts?: OpenLaneOptions) => Promise<SessionLaneHandle>
  readonly getUserCredits: () => Promise<bigint>
  readonly recoverSpool: () => Promise<{ proven: number; pending: number }>
  readonly recoverV4Only: () => Promise<{ proven: number; pending: number }>
  readonly close: () => Promise<void>
}

function loadBoxBridgeBundle(): { bridgeSha256: string; bridgeFiles: Record<string, string> } {
  const hostBytes = readFileSync(join(BOX_BRIDGE_DIR, 'host.py'))
  const bridgeFiles: Record<string, string> = {
    'host.py': hostBytes.toString('base64'),
  }
  const modHash = createHash('sha256')
  for (const rel of [...BOX_BRIDGE_PLUGIN_FILES].sort()) {
    const raw = readFileSync(join(BOX_BRIDGE_DIR, 'oc-bridge', rel))
    bridgeFiles[`mod/oc-bridge/${rel}`] = raw.toString('base64')
    modHash.update(Buffer.from(`${rel}\0${raw.length}\0`, 'utf8'))
    modHash.update(raw)
  }
  return {
    bridgeSha256: modHash.digest('hex'),
    bridgeFiles,
  }
}

function postLocalUnixRoundtrip(
  unixSocketPath: string,
  payloadBytes: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        socketPath: unixSocketPath,
        path: '/roundtrip',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payloadBytes.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', rejectPromise)
    req.end(payloadBytes)
  })
}

const REMOTE_FS_HELPER_PY = `
import base64, http.client, json, os, pathlib, socket, sys

req = json.loads(sys.stdin.read())
op = req["op"]
root = pathlib.Path(req["root"])
rel = req.get("rel") or ""
target = (root / rel) if rel else root

if op == "exists":
    print(json.dumps({"exists": target.exists()}))
elif op == "read":
    data = target.read_bytes()
    print(json.dumps({"b64": base64.b64encode(data).decode("ascii")}))
elif op == "write":
    raw = base64.b64decode(req["b64"])
    mode = int(req.get("mode", 0o600))
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.write_bytes(raw)
    os.chmod(target, mode)
    print(json.dumps({"ok": True}))
elif op == "roundtrip":
    raw = base64.b64decode(req["b64"])
    sock_path = str(root / "tool.sock")
    class UnixConn(http.client.HTTPConnection):
        def connect(self):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(20.0)
            s.connect(sock_path)
            self.sock = s
    try:
        conn = UnixConn("localhost")
        conn.request("POST", "/roundtrip", body=raw, headers={"Content-Type": "application/json", "Content-Length": str(len(raw))})
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="replace")
        conn.close()
        print(json.dumps({"status": resp.status, "body": body}))
    except Exception as exc:
        print(json.dumps({"status": -1, "error": str(exc)}))
elif op == "wal_check":
    import hashlib, time
    call_id = req["callId"]
    call_key = hashlib.sha256(call_id.encode("utf-8")).hexdigest()
    attempt_p = root / "tool-attempts" / (call_key + ".attempt.json")
    result_p = root / "tool-attempts" / (call_key + ".result.json")
    deadline = time.monotonic() + 15.0
    while not result_p.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    saved_attempt = attempt_p.read_bytes()
    sock_path = str(root / "tool.sock")
    def post_raw(raw_b):
        class UnixConn(http.client.HTTPConnection):
            def connect(self):
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(10.0)
                s.connect(sock_path)
                self.sock = s
        conn = UnixConn("localhost")
        try:
            conn.request("POST", "/roundtrip", body=raw_b, headers={"Content-Type": "application/json", "Content-Length": str(len(raw_b))})
            resp = conn.getresponse()
            resp.read()
            return resp.status
        finally:
            conn.close()
    cached_status = post_raw(saved_attempt)
    unknown_cid = call_id + "_inflight_unknown"
    unknown_key = hashlib.sha256(unknown_cid.encode("utf-8")).hexdigest()
    obs_p = root / "observations" / (call_key + ".json")
    if obs_p.exists():
        orig_obs = json.loads(obs_p.read_text(encoding="utf-8"))
        orig_obs["callId"] = unknown_cid
        u_obs_p = root / "observations" / (unknown_key + ".json")
        u_obs_p.write_bytes(json.dumps(orig_obs, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        os.chmod(u_obs_p, 0o400)
    parsed_att = json.loads(saved_attempt.decode("utf-8"))
    parsed_att["rpcId"] = 99991
    parsed_att["callId"] = unknown_cid
    u_body = json.dumps(parsed_att, separators=(",", ":"), sort_keys=True).encode("utf-8")
    u_att_p = root / "tool-attempts" / (unknown_key + ".attempt.json")
    u_att_p.write_bytes(u_body)
    os.chmod(u_att_p, 0o600)
    inflight_status = post_raw(u_body)
    print(json.dumps({"cachedReplayStatus": cached_status, "inflightDuplicateStatus": inflight_status}))
elif op == "cleanup_roots":
    import shutil
    prefix = req["allowedPrefix"]
    removed = 0
    for r_str in req.get("roots") or []:
        if not isinstance(r_str, str) or not r_str.startswith(prefix):
            continue
        rp = pathlib.Path(r_str)
        if rp.exists() and not rp.is_symlink():
            shutil.rmtree(rp, ignore_errors=True)
            removed += 1
        lock_p = rp.parent / ("." + rp.name + ".create.lock")
        if lock_p.exists() and not lock_p.is_symlink():
            try:
                lock_p.unlink()
            except OSError:
                pass
    print(json.dumps({"removed": removed}))
else:
    raise ValueError("unknown op " + str(op))
`

export async function createConformanceHarness(
  driverId: string,
  opts: {
    mode?: ConformanceMode
    nodeConfigPath?: string
    registryPath?: string
    profileOverride?: string
  } = {},
): Promise<ConformanceHarness> {
  const mode: ConformanceMode = opts.mode ?? 'sandbox'
  const liveCfg: LiveNodeConfig | undefined =
    mode === 'live-node'
      ? (JSON.parse(
          readFileSync(
            (() => {
              assert.ok(opts.nodeConfigPath, 'live-node mode requires nodeConfigPath')
              return opts.nodeConfigPath
            })(),
            'utf8',
          ),
        ) as LiveNodeConfig)
      : undefined

  const baseDbUrl = process.env.TEST_DATABASE_URL
  assert.ok(
    baseDbUrl && new URL(baseDbUrl).pathname.endsWith('_test'),
    'Conformance runner requires isolated TEST_DATABASE_URL ending with _test',
  )
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379'
  const redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true })
  await redisClient.connect()
  assert.equal(await redisClient.ping(), 'PONG', 'Real Redis must be reachable for conformance')
  const preCheckRedis = wrapIoredisForPreCheck(redisClient)

  const templateDbName = 'oc_remote_conf_tmpl_v4_test'
  const dedicatedDbName = `oc_remote_conf_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`
  const ensureMigratedTemplate = async () => {
    const admin = new Client({ connectionString: baseDbUrl, connectionTimeoutMillis: 3000 })
    await admin.connect()
    try {
      await admin.query('SELECT pg_advisory_lock(7490339)')
      try {
        const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          templateDbName,
        ])
        if (exists.rowCount === 0) {
          await admin.query(`CREATE DATABASE ${templateDbName} TEMPLATE template0`)
          const tmplUrl = new URL(baseDbUrl)
          tmplUrl.pathname = `/${templateDbName}`
          const tmplPool = new Pool({ connectionString: tmplUrl.toString(), max: 2 })
          tmplPool.on('error', () => {})
          setPoolOverride(tmplPool)
          await runMigrations()
          await tmplPool.end()
        }
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [templateDbName],
        )
        await admin.query(`DROP DATABASE IF EXISTS ${dedicatedDbName}`)
        await admin.query(`CREATE DATABASE ${dedicatedDbName} TEMPLATE ${templateDbName}`)
      } finally {
        await admin.query('SELECT pg_advisory_unlock(7490339)').catch(() => {})
      }
    } finally {
      await admin.end().catch(() => {})
    }
  }
  const adminExec = async (sql: string) => {
    const admin = new Client({ connectionString: baseDbUrl, connectionTimeoutMillis: 3000 })
    await admin.connect()
    try {
      await admin.query(sql)
    } finally {
      await admin.end().catch(() => {})
    }
  }
  await ensureMigratedTemplate()
  const dedicatedUrlObj = new URL(baseDbUrl)
  dedicatedUrlObj.pathname = `/${dedicatedDbName}`
  const dedicatedDbUrl = dedicatedUrlObj.toString()

  const pool = new Pool({ connectionString: dedicatedDbUrl, max: 12, connectionTimeoutMillis: 3000 })
  pool.on('error', () => {})
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, dedicatedDbName)
  setPoolOverride(pool)
  await runMigrations()
  const v4Table = await pool.query(
    `SELECT to_regclass('public.remote_driver_verification_runs') AS rel`,
  )
  assert.ok(v4Table.rows[0]?.rel, 'Migration 0339_remote_driver_core_v4 must be applied')

  const regMap = loadRemoteDriverRegistry(opts.registryPath)
  const reg = regMap.get(driverId)
  assert.ok(reg, `Driver '${driverId}' not found in registry`)

  // Short `/tmp/oc-drvtest-cf-` prefix ensures AF_UNIX `tool.sock` stays well below 104 bytes.
  const sandbox = mkdtempSync('/tmp/oc-drvtest-cf-')
  const resRoot = join(sandbox, 'res')
  const fakeSys = join(sandbox, 'sys')
  const evidenceSpoolRoot = join(sandbox, 'spool')
  const sharedWorkspaceCwd = join(sandbox, 'workspace-cwd')
  mkdirSync(resRoot, { recursive: true, mode: 0o700 })
  mkdirSync(fakeSys, { recursive: true, mode: 0o700 })
  mkdirSync(evidenceSpoolRoot, { recursive: true, mode: 0o700 })
  mkdirSync(sharedWorkspaceCwd, { recursive: true, mode: 0o700 })

  const worker = new DriverWorkerClient({ registryPath: opts.registryPath })
  const workerInfo = await worker.info(driverId)
  const usagePolicy = workerInfo.usagePolicy

  const sandboxInitPrep = prepareDriverSandbox(driverId, sandbox, 1)
  const bridgeBundle = liveCfg?.loadBoxBridgeForDriver ? loadBoxBridgeBundle() : undefined

  const canonicalModel =
    mode === 'live-node' ? liveCfg!.canonicalModel : sandboxInitPrep.canonicalModel
  const upstreamModel =
    mode === 'live-node' ? liveCfg!.upstreamModel : sandboxInitPrep.upstreamModel
  const profileName = (
    opts.profileOverride ??
    liveCfg?.profileName ??
    `${driverId.replaceAll('_', '-')}-acct-1`
  ).slice(0, 48)
  const authEpoch = `epoch-${driverId.replaceAll('_', '-')}-1`
  const sshUser = liveCfg?.sshUser ?? 'box'
  const sshPort = liveCfg?.sshPort ?? 22
  const targetHost = mode === 'live-node' ? liveCfg!.sshHost : '127.0.0.1'
  const sshMode = mode === 'live-node' ? 'real-ssh-guard' : 'local-sandbox'
  const createdRemoteRoots = new Set<string>()

  const baseNodeEnv: Record<string, string> = {
    OC_REMOTE_RESOURCE_ROOT: resRoot,
    OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
    OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
    OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
  }

  const liveProbeContext: Record<string, unknown> =
    mode === 'live-node'
      ? {
          ...liveCfg!.probeContext,
          ...(bridgeBundle ? { bridgeSha256: bridgeBundle.bridgeSha256 } : {}),
        }
      : sandboxInitPrep.probeContext

  const liveDriverContextBase: Record<string, unknown> =
    mode === 'live-node'
      ? {
          ...liveCfg!.driverContext,
          ...(bridgeBundle ? { bridgeFiles: bridgeBundle.bridgeFiles } : {}),
        }
      : sandboxInitPrep.driverContext

  // Run REAL node-side probe (`forSshTarget` over real SSH guard in `live-node` mode; `forLocalSandbox` in `sandbox`).
  const probeRoot =
    mode === 'live-node'
      ? `/home/${sshUser}/oc-remotedrv-probe-${randomUUID().replaceAll('-', '').slice(0, 20)}`
      : join(sandbox, 'run-init-probe')
  if (mode === 'live-node') {
    createdRemoteRoots.add(probeRoot)
  }

  const liveControllerPath = `/opt/openclaude/remote-driver/${reg.controllerSha256}/core/controller.py`
  const bootstrapSpec: RemotePoolLaneSpec = {
    controllerPath: mode === 'live-node' ? liveControllerPath : CONTROLLER_PATH,
    controllerSha256: reg.controllerSha256,
    ...(mode === 'sandbox' && opts.registryPath ? { registryPath: opts.registryPath } : {}),
    manifest: {
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      root: probeRoot,
      driverId: reg.driverId,
      engineId: reg.engineId,
      operationId: randomUUID(),
      runId: randomUUID(),
      generation: '1',
      profileId: profileName,
      authEpoch,
      model: upstreamModel,
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
    },
    driverContext: liveDriverContextBase,
    verifiedProbe: {
      schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
      engineId: reg.engineId,
      driverId: reg.driverId,
      driverVersion: reg.driverVersion,
      source: 'bootstrap:conformance',
      freshness: 'cli-observed',
      authPresent: true,
      accountObserved: true,
      cliVersion: '0.0.0',
      cliSha256: 'a'.repeat(64),
      models: [
        {
          upstreamModelId: upstreamModel,
          displayName: upstreamModel,
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          supportsAdaptiveThinking: true,
          supportsVision: true,
        },
      ],
      rawResponseSha256: 'b'.repeat(64),
      observedAt: new Date().toISOString(),
    },
  }

  let sshEgressSeq = 0
  const spawnLiveSsh = liveCfg?.sshProxyCommands?.length
    ? (args: string[]) => {
        const proxy =
          liveCfg.sshProxyCommands![sshEgressSeq++ % liveCfg.sshProxyCommands!.length] ?? ''
        const finalArgs = proxy
          ? [
              ...args
                .slice(0, -2)
                .map((a) => (a === 'ConnectTimeout=10' ? 'ConnectTimeout=25' : a)),
              '-o',
              `ProxyCommand=${proxy}`,
              ...args.slice(-2),
            ]
          : args
        return spawn('/usr/bin/ssh', finalArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: process.env.HOME ?? '/root' },
        })
      }
    : undefined

  const probeHost =
    mode === 'live-node'
      ? (() => {
          const execDir = remoteNodeExecKeyDir(liveCfg!.keyId)
          return RemotePoolSshHost.forSshTarget(
            {
              host: liveCfg!.sshHost,
              port: sshPort,
              user: sshUser,
              keyPath: join(execDir, `v4_${reg.driverId}_id_ed25519`),
              knownHostsPath: join(execDir, 'known_hosts'),
              controllerSha256: reg.controllerSha256,
              taskRootPrefix: `/home/${sshUser}/oc-remotedrv-`,
              upstreamModel,
            },
            bootstrapSpec,
            spawnLiveSsh,
          )
        })()
      : RemotePoolSshHost.forLocalSandbox(bootstrapSpec, baseNodeEnv)

  const probed = await probeHost.probe(liveProbeContext, probeRoot)
  assert.ok(
    probed.snapshot.models.some((m) => m.upstreamModelId === upstreamModel),
    `Live/probed snapshot models [${probed.snapshot.models.map((m) => m.upstreamModelId).join(',')}] must include '${upstreamModel}'`,
  )

  // Compute deterministic `policySha256` via local policy-sample context (`launch_spec` policy hash
  // depends solely on `driverId`, `driverVersion`, and policy flags, never on host file paths).
  const policySampleCtx =
    mode === 'live-node'
      ? {
          ...sandboxInitPrep.driverContext,
          ...(bridgeBundle ? { bridgeFiles: bridgeBundle.bridgeFiles } : {}),
          bridgeMode: undefined,
          root: join(sandbox, 'run-policy-sample'),
          model: upstreamModel,
          operationId: randomUUID(),
          mcpClientPath: MCP_CLIENT_PATH,
          tools: {
            tools: [{ name: 'Write', description: 'Write file', inputSchema: { type: 'object' } }],
          },
        }
      : {
          ...sandboxInitPrep.driverContext,
          root: join(sandbox, 'run-policy-sample'),
          model: upstreamModel,
          operationId: randomUUID(),
          mcpClientPath: MCP_CLIENT_PATH,
          tools: {
            tools: [{ name: 'Write', description: 'Write file', inputSchema: { type: 'object' } }],
          },
        }
  const specSample = await worker.launchSpec(driverId, policySampleCtx, probed.snapshot)
  const expectedPolicySha256 = String(specSample.policySha256 ?? probed.snapshot.rawResponseSha256)
  assert.equal(
    computeProbeFingerprintTs(probed.snapshot, {
      driverDigest: probed.driverDigest,
      coreDigest: probed.coreDigest,
      policySha256: expectedPolicySha256,
    }),
    probed.probeFingerprint,
    'TS and Python probe fingerprints must be byte-identical',
  )

  // Seed user (`100_000_000_000` fen), container, target node, target profile, cross-engine peer profile,
  // and (when `live-node`) an isolated fault-injection sandbox node/profile so Red controls never touch user nodes.
  const uid = (
    await pool.query(
      `INSERT INTO users (email, password_hash, credits)
       VALUES ($1, 'conformance-only', 100000000000)
       RETURNING id::text`,
      [`conf-${driverId}-${randomUUID().slice(0, 8)}@example.test`],
    )
  ).rows[0].id

  await pool.query(
    `INSERT INTO agent_containers (id, user_id, secret_hash)
     VALUES (7, $1, $2)`,
    [uid, Buffer.alloc(32, 7)],
  )

  const nodeId = (
    await pool.query(
      `INSERT INTO remote_agent_nodes
         (label, ssh_host, ssh_port, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING id::text`,
      [
        mode === 'live-node' ? `live-${driverId}-node` : 'conf-node-1',
        targetHost,
        sshPort,
        sshUser,
        liveCfg?.hostKeyFp ?? 'SHA256:conftest',
        liveCfg?.keyId ?? 'confkey',
        reg.controllerSha256,
      ],
    )
  ).rows[0].id

  const legacyProfileEngine = reg.authorityEngine === 'codex' ? 'codex' : 'cc'
  const profileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, runner_mode, auth_epoch, max_concurrent_lanes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5)
       RETURNING id::text`,
      [
        nodeId,
        legacyProfileEngine,
        reg.driverId,
        reg.engineId,
        profileName,
        `fp-${profileName}`,
        reg.runnerMode,
        authEpoch,
      ],
    )
  ).rows[0].id

  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, $4)`,
    [profileId, upstreamModel, canonicalModel, upstreamModel],
  )

  const verifySeededProfile = async (pid: string, snap: RemoteProbeSnapshot, polSha: string) => {
    const r = await recordDriverProbeSnapshot(pool, {
      profileId: pid,
      snapshot: snap,
      policySha256: polSha,
      registryPath: opts.registryPath,
    })
    assert.ok(r.verificationRunId)
    const c = await claimDriverVerificationRun(pool, {
      leaseOwner: `conformance-init-${pid}`,
      profileId: pid,
    })
    assert.ok(c)
    const v = await completeDriverVerificationRun(pool, {
      runId: c.id,
      leaseOwner: `conformance-init-${pid}`,
      outcome: 'passed',
      evidenceDigest: r.fingerprint,
      registryPath: opts.registryPath,
    })
    assert.equal(v.executionReadyRestored, true)
  }

  await verifySeededProfile(profileId, probed.snapshot, expectedPolicySha256)

  // Secondary isolated fault-injection sandbox profile when running in `live-node` mode.
  const faultCanonicalModel = `${canonicalModel.replace(/-remote$/, '')}-faultsbx-remote`
  const faultUpstreamModel = sandboxInitPrep.upstreamModel
  if (mode === 'live-node') {
    const sbxProbeRoot = join(sandbox, 'run-faultsbx-probe')
    const sbxBootstrap: RemotePoolLaneSpec = {
      ...bootstrapSpec,
      controllerPath: CONTROLLER_PATH,
      ...(opts.registryPath ? { registryPath: opts.registryPath } : {}),
      manifest: {
        ...bootstrapSpec.manifest,
        root: sbxProbeRoot,
        profileId: `${driverId.replaceAll('_', '-')}-fault-sbx`,
        authEpoch: `epoch-fault-${driverId.replaceAll('_', '-')}`,
        model: faultUpstreamModel,
      },
      driverContext: sandboxInitPrep.driverContext,
    }
    const sbxProbed = await RemotePoolSshHost.forLocalSandbox(sbxBootstrap, baseNodeEnv).probe(
      sandboxInitPrep.probeContext,
      sbxProbeRoot,
    )
    const faultNodeId = (
      await pool.query(
        `INSERT INTO remote_agent_nodes
           (label, ssh_host, ssh_user, host_key_fp, key_id, controller_sha256, status)
         VALUES ('fault-sbx-node', '127.0.0.1', 'box', 'SHA256:faultsbx', 'faultkey', $1, 'active')
         RETURNING id::text`,
        [reg.controllerSha256],
      )
    ).rows[0].id
    const faultProfileId = (
      await pool.query(
        `INSERT INTO remote_agent_profiles
           (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, runner_mode, auth_epoch, max_concurrent_lanes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5)
         RETURNING id::text`,
        [
          faultNodeId,
          legacyProfileEngine,
          reg.driverId,
          reg.engineId,
          `${driverId.replaceAll('_', '-')}-fault-sbx`,
          `fp-fault-${driverId}`,
          reg.runnerMode,
          `epoch-fault-${driverId.replaceAll('_', '-')}`,
        ],
      )
    ).rows[0].id
    await pool.query(
      `INSERT INTO remote_model_offers
         (profile_id, upstream_model_id, canonical_model_id, base_display_name)
       VALUES ($1, $2, $3, $4)`,
      [faultProfileId, faultUpstreamModel, faultCanonicalModel, faultUpstreamModel],
    )
    await verifySeededProfile(faultProfileId, sbxProbed.snapshot, expectedPolicySha256)
  }

  // Peer engine profile on the SAME `nodeId` for Group 6 cross-engine independence proof.
  const peerDriverId = reg.engineId === 'codex' ? 'cc' : 'codex'
  const peerReg = regMap.get(peerDriverId)!
  const peerPrep = prepareDriverSandbox(peerDriverId, sandbox, 99)
  const peerProbeRoot = join(sandbox, 'run-peer-probe')
  const peerBootstrap: RemotePoolLaneSpec = {
    ...bootstrapSpec,
    controllerPath: CONTROLLER_PATH,
    manifest: {
      ...bootstrapSpec.manifest,
      root: peerProbeRoot,
      driverId: peerReg.driverId,
      engineId: peerReg.engineId,
      profileId: `peer-${peerDriverId}-1`,
      authEpoch: `epoch-peer-${peerDriverId}`,
      model: peerPrep.upstreamModel,
      driverDigest: peerReg.driverDigest,
      coreDigest: peerReg.coreDigest,
    },
    driverContext: peerPrep.driverContext,
  }
  const peerProbed = await RemotePoolSshHost.forLocalSandbox(peerBootstrap, baseNodeEnv).probe(
    peerPrep.probeContext,
    peerProbeRoot,
  )
  const peerSpecSample = await worker.launchSpec(
    peerDriverId,
    {
      ...peerPrep.driverContext,
      root: join(sandbox, 'run-peer-policy'),
      model: peerPrep.upstreamModel,
      operationId: randomUUID(),
      mcpClientPath: MCP_CLIENT_PATH,
      tools: {
        tools: [{ name: 'Write', description: 'Write file', inputSchema: { type: 'object' } }],
      },
    },
    peerProbed.snapshot,
  )
  const peerPolicySha = String(peerSpecSample.policySha256 ?? peerProbed.snapshot.rawResponseSha256)
  const peerLegacyEngine = peerReg.authorityEngine === 'codex' ? 'codex' : 'cc'
  const peerProfileId = (
    await pool.query(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, runner_mode, auth_epoch, max_concurrent_lanes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5)
       RETURNING id::text`,
      [
        nodeId,
        peerLegacyEngine,
        peerReg.driverId,
        peerReg.engineId,
        `peer-${peerDriverId}-1`,
        `fp-peer-${peerDriverId}`,
        peerReg.runnerMode,
        `epoch-peer-${peerDriverId}`,
      ],
    )
  ).rows[0].id
  await pool.query(
    `INSERT INTO remote_model_offers
       (profile_id, upstream_model_id, canonical_model_id, base_display_name)
     VALUES ($1, $2, $3, $4)`,
    [peerProfileId, peerPrep.upstreamModel, peerPrep.canonicalModel, peerPrep.upstreamModel],
  )
  await verifySeededProfile(peerProfileId, peerProbed.snapshot, peerPolicySha)

  // Keyring & model catalog for real `createRemoteDriverTurnFinance`.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keyId = 'mak1_conf_v4_0001'
  const keys: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])
  const baseCap = {
    supportsVision: true,
    reasoning: { supported: ['low', 'medium', 'high'] as const, codexModelDefault: 'medium' as const },
    ccb: { capabilityZero: false, supportsThinking: true },
  }
  const catalogEntries: ModelCatalogEntry[] = [
    {
      entryId: 501,
      modelId: canonicalModel,
      engine: reg.authorityEngine as any,
      providerId: reg.authorityEngine === 'codex' ? 'codex' : 'anthropic',
      placement: 'remote_pool',
      upstreamModelId: upstreamModel,
      contextWindow: 200_000,
      capabilityProfile: baseCap,
      capabilitySchemaVersion: 1,
      state: 'active',
      lockVersion: 0,
    },
    {
      entryId: 502,
      modelId: peerPrep.canonicalModel,
      engine: peerReg.authorityEngine as any,
      providerId: peerReg.authorityEngine === 'codex' ? 'codex' : 'anthropic',
      placement: 'remote_pool',
      upstreamModelId: peerPrep.upstreamModel,
      contextWindow: 200_000,
      capabilityProfile: baseCap,
      capabilitySchemaVersion: 1,
      state: 'active',
      lockVersion: 0,
    },
  ]
  const pricingMap = new Map<string, any>([
    [
      canonicalModel,
      {
        modelId: canonicalModel,
        displayName: canonicalModel,
        ...PRICING_RATES,
        multiplier: '1.000',
        visibility: 'public',
        sortOrder: 10,
        defaultEffort: 'medium',
      },
    ],
    [
      peerPrep.canonicalModel,
      {
        modelId: peerPrep.canonicalModel,
        displayName: peerPrep.canonicalModel,
        ...PRICING_RATES,
        multiplier: '1.000',
        visibility: 'public',
        sortOrder: 20,
        defaultEffort: 'medium',
      },
    ],
  ])
  if (mode === 'live-node') {
    catalogEntries.push({
      entryId: 503,
      modelId: faultCanonicalModel,
      engine: reg.authorityEngine as any,
      providerId: reg.authorityEngine === 'codex' ? 'codex' : 'anthropic',
      placement: 'remote_pool',
      upstreamModelId: faultUpstreamModel,
      contextWindow: 200_000,
      capabilityProfile: baseCap,
      capabilitySchemaVersion: 1,
      state: 'active',
      lockVersion: 0,
    })
    pricingMap.set(faultCanonicalModel, {
      modelId: faultCanonicalModel,
      displayName: faultCanonicalModel,
      ...PRICING_RATES,
      multiplier: '1.000',
      visibility: 'public',
      sortOrder: 30,
      defaultEffort: 'medium',
    })
  }
  const catalog = new ModelCatalogSnapshot({
    entries: catalogEntries,
    aliases: new Map(),
    securityEpoch: 7n,
    pricing: pricingMap,
  })

  const silentLog = createLogger({ out: () => {} })

  const runRemoteFsOp = async (payload: Record<string, unknown>): Promise<any> => {
    assert.ok(liveCfg, 'runRemoteFsOp requires liveCfg')
    const runAs = liveCfg.adminRunAsUserPrefix ?? `runuser -u ${sshUser} --`
    const pyB64 = Buffer.from(REMOTE_FS_HELPER_PY, 'utf8').toString('base64')
    const remoteCmd = `${runAs} /usr/bin/python3 -I -B -c "import base64; exec(base64.b64decode('${pyB64}').decode('utf-8'))"`
    const childPromise = execFileAsync(
      '/bin/bash',
      ['-c', `${liveCfg.adminSshCmd} ${JSON.stringify(remoteCmd)}`],
      { maxBuffer: 8 * 1024 * 1024, timeout: 25_000 },
    )
    const child = (childPromise as any).child as import('node:child_process').ChildProcess | undefined
    child?.stdin?.end(`${JSON.stringify(payload)}\n`)
    const { stdout } = await childPromise
    const lastLine = stdout.trim().split('\n').at(-1) ?? '{}'
    return JSON.parse(lastLine)
  }

  const taskFileExists = async (taskRoot: string, relPath = ''): Promise<boolean> => {
    if (taskRoot.startsWith('/tmp/oc-drvtest-')) {
      return existsSync(relPath ? join(taskRoot, relPath) : taskRoot)
    }
    const res = await runRemoteFsOp({ op: 'exists', root: taskRoot, rel: relPath })
    return Boolean(res.exists)
  }

  const readTaskFileBytes = async (taskRoot: string, relPath: string): Promise<Buffer> => {
    if (taskRoot.startsWith('/tmp/oc-drvtest-')) {
      return readFileSync(join(taskRoot, relPath))
    }
    const res = await runRemoteFsOp({ op: 'read', root: taskRoot, rel: relPath })
    return Buffer.from(String(res.b64), 'base64')
  }

  const readTaskFileUtf8 = async (taskRoot: string, relPath: string): Promise<string> =>
    (await readTaskFileBytes(taskRoot, relPath)).toString('utf8')

  const writeTaskFileBytes = async (
    taskRoot: string,
    relPath: string,
    data: Buffer,
    fileMode = 0o600,
  ): Promise<void> => {
    if (taskRoot.startsWith('/tmp/oc-drvtest-')) {
      const full = join(taskRoot, relPath)
      mkdirSync(join(full, '..'), { recursive: true, mode: 0o700 })
      writeFileSync(full, data, { mode: fileMode })
      return
    }
    await runRemoteFsOp({
      op: 'write',
      root: taskRoot,
      rel: relPath,
      b64: data.toString('base64'),
      mode: fileMode,
    })
  }

  const postTaskToolSockRoundtrip = async (
    taskRoot: string,
    payloadBytes: Buffer,
  ): Promise<{ status: number; body: string }> => {
    if (taskRoot.startsWith('/tmp/oc-drvtest-')) {
      return await postLocalUnixRoundtrip(join(taskRoot, 'tool.sock'), payloadBytes)
    }
    const res = await runRemoteFsOp({
      op: 'roundtrip',
      root: taskRoot,
      b64: payloadBytes.toString('base64'),
    })
    if (res.status === -1) {
      throw new Error(`ENOENT_OR_ECONNREFUSED:${String(res.error ?? '')}`)
    }
    return { status: Number(res.status), body: String(res.body ?? '') }
  }

  const verifyTaskWalReplay = async (
    taskRoot: string,
    callId: string,
  ): Promise<{ cachedReplayStatus: number; inflightDuplicateStatus: number }> => {
    if (taskRoot.startsWith('/tmp/oc-drvtest-')) {
      const callKey = createHash('sha256').update(callId).digest('hex')
      const attemptRel = `tool-attempts/${callKey}.attempt.json`
      const resultRel = `tool-attempts/${callKey}.result.json`
      const deadline = Date.now() + 15_000
      while (!existsSync(join(taskRoot, resultRel)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      const savedAttemptBytes = readFileSync(join(taskRoot, attemptRel))
      const replayRes = await postLocalUnixRoundtrip(join(taskRoot, 'tool.sock'), savedAttemptBytes)
      const unknownCallId = `${callId}_inflight_unknown`
      const unknownKey = createHash('sha256').update(unknownCallId).digest('hex')
      const obsPath = join(taskRoot, 'observations', `${callKey}.json`)
      if (existsSync(obsPath)) {
        const origObs = JSON.parse(readFileSync(obsPath, 'utf8')) as Record<string, unknown>
        writeFileSync(
          join(taskRoot, 'observations', `${unknownKey}.json`),
          remoteCanonicalJson({ ...origObs, callId: unknownCallId }),
          { mode: 0o400 },
        )
      }
      const parsedAttempt = JSON.parse(savedAttemptBytes.toString('utf8')) as Record<string, unknown>
      const unknownBody = Buffer.from(
        remoteCanonicalJson({ ...parsedAttempt, rpcId: 99991, callId: unknownCallId }),
        'utf8',
      )
      writeFileSync(join(taskRoot, 'tool-attempts', `${unknownKey}.attempt.json`), unknownBody, {
        mode: 0o600,
      })
      const dupRes = await postLocalUnixRoundtrip(join(taskRoot, 'tool.sock'), unknownBody)
      return {
        cachedReplayStatus: replayRes.status,
        inflightDuplicateStatus: dupRes.status,
      }
    }
    const res = await runRemoteFsOp({
      op: 'wal_check',
      root: taskRoot,
      callId,
    })
    return {
      cachedReplayStatus: Number(res.cachedReplayStatus ?? 0),
      inflightDuplicateStatus: Number(res.inflightDuplicateStatus ?? 0),
    }
  }

  let laneSeq = 0
  let pooledHostSeq = 0
  let closingHarness = false
  const openLanes = new Set<SessionLaneHandle>()
  const idleRealHosts: Cc5ToolHost[] = []
  const allPooledRealHosts = new Set<Cc5ToolHost>()
  const retiredHostCloses: Promise<unknown>[] = []

  const spawnPooledRealHost = (env: NodeJS.ProcessEnv): Cc5ToolHost => {
    const hostIdx = ++pooledHostSeq
    const sharedRoot = join(sandbox, `shared-toolhost-${hostIdx}`)
    const sharedHome = join(sharedRoot, 'home')
    mkdirSync(sharedRoot, { recursive: true, mode: 0o700 })
    mkdirSync(join(sharedHome, '.claude'), { recursive: true, mode: 0o700 })
    const created = new Cc5ToolHost(
      sharedRoot,
      randomUUID(),
      { cwd: sharedWorkspaceCwd, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
      async () => {
        throw new Error('REMOTE_PERMISSION_PROMPT_UNSUPPORTED')
      },
      {
        ...env,
        HOME: sharedHome,
        CLAUDE_CONFIG_DIR: join(sharedHome, '.claude'),
      },
    )
    allPooledRealHosts.add(created)
    return created
  }

  for (let i = 0; i < 3; i++) {
    idleRealHosts.push(
      spawnPooledRealHost({
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
      }),
    )
  }
  await Promise.all(idleRealHosts.map((ph) => ph.tools()))

  const acquirePooledRealHost = (env: NodeJS.ProcessEnv): Cc5ToolHost => {
    const existing = idleRealHosts.pop() ?? spawnPooledRealHost(env)
    if (!closingHarness && idleRealHosts.length < 2) {
      const replacement = spawnPooledRealHost(env)
      void replacement.tools().catch(() => {})
      idleRealHosts.push(replacement)
    }
    return existing
  }

  const placeLaneOptions = (
    extra: Partial<PlaceRemoteDriverLaneOptions> = {},
  ): PlaceRemoteDriverLaneOptions => ({
    pool,
    ...(mode === 'sandbox' ? { registryPath: opts.registryPath, localSandboxDir: sandbox } : {}),
    ...extra,
  })

  let cooldownChain = Promise.resolve()

  const openLaneInternal = async (
    laneOpts: OpenLaneOptions = {},
    forceFaultSandbox = false,
  ): Promise<SessionLaneHandle> => {
    const useFaultSandbox = mode === 'sandbox' || forceFaultSandbox
    if (!useFaultSandbox && liveCfg?.sshConnectCooldownMs && liveCfg.sshConnectCooldownMs > 0) {
      const waitMs = liveCfg.sshConnectCooldownMs
      const next = cooldownChain.then(() => new Promise<void>((r) => setTimeout(r, waitMs)))
      cooldownChain = next.catch(() => {})
      await next
    }
    const idx = laneOpts.sessionIndex ?? ++laneSeq
    const sessionPrep = prepareDriverSandbox(driverId, sandbox, idx)
    const activeCanonicalModel =
      !useFaultSandbox ? canonicalModel : mode === 'live-node' ? faultCanonicalModel : canonicalModel
    const mergedDriverCtx = useFaultSandbox
      ? {
          ...sessionPrep.driverContext,
          ...(laneOpts.extraDriverContext ?? {}),
        }
      : {
          ...liveDriverContextBase,
          ...(laneOpts.extraDriverContext ?? {}),
        }
    const sessionKey =
      laneOpts.sessionKey ??
      `agent:main:webchat:dm:cf_${driverId}_${useFaultSandbox ? 'sbx' : 'live'}_${idx}_${randomUUID().slice(0, 6)}`

    const placed = await placeRemoteDriverLane(
      {
        uid,
        containerDbId: '7',
        dockerId: 'd'.repeat(64),
        sessionKey,
        canonicalModel: activeCanonicalModel,
        driverId,
        driverContext: mergedDriverCtx,
      },
      useFaultSandbox
        ? {
            pool,
            registryPath: opts.registryPath,
            localSandboxDir: sandbox,
            ...(laneOpts.maxSliceMemoryBytes !== undefined
              ? { maxSliceMemoryBytes: laneOpts.maxSliceMemoryBytes }
              : {}),
          }
        : {
            pool,
            ...(laneOpts.maxSliceMemoryBytes !== undefined
              ? { maxSliceMemoryBytes: laneOpts.maxSliceMemoryBytes }
              : {}),
          },
    )

    if (!useFaultSandbox) {
      createdRemoteRoots.add(placed.spec.manifest.root)
    }

    const laneNodeEnv: Record<string, string> = {
      ...baseNodeEnv,
      ...(laneOpts.nodeMemoryBudgetBytes !== undefined
        ? { OC_REMOTE_NODE_MEMORY_BUDGET: String(laneOpts.nodeMemoryBudgetBytes) }
        : {}),
      ...(laneOpts.memAvailableBytes !== undefined
        ? { OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(laneOpts.memAvailableBytes) }
        : {}),
    }
    const host = useFaultSandbox
      ? RemotePoolSshHost.forLocalSandbox(placed.spec, laneNodeEnv)
      : RemotePoolSshHost.forSshTarget(placed.sshTarget, placed.spec, spawnLiveSsh)

    const effectivePool: Pool = laneOpts.failTurnInsertOnce
      ? (new Proxy(pool, {
          get(target, prop) {
            if (prop === 'connect') {
              return async () => {
                const c = await target.connect()
                return new Proxy(c, {
                  get(t, p) {
                    if (p === 'query') {
                      return async (...args: any[]) => {
                        if (
                          laneOpts.failTurnInsertOnce?.active &&
                          String(args[0]).includes('INSERT INTO remote_native_turns')
                        ) {
                          laneOpts.failTurnInsertOnce.active = false
                          throw new Error('simulated-pg-disconnect-before-receipt-commit')
                        }
                        return (t.query as any)(...args)
                      }
                    }
                    const v = Reflect.get(t, p)
                    return typeof v === 'function' ? v.bind(t) : v
                  },
                })
              }
            }
            const v = Reflect.get(target, prop)
            return typeof v === 'function' ? v.bind(target) : v
          },
        }) as Pool)
      : pool

    const rawFinance = createRemoteDriverTurnFinance({
      pool: effectivePool,
      preCheckRedis,
      catalog: { assertFresh: async () => catalog } as unknown as ModelCatalogCache,
      keyring: keys,
      loadUserModelAuthz: async (userId) => ({
        uid: userId,
        role: 'user',
        grantedModelIds: new Set<string>(),
        deniedModelIds: new Set<string>(),
        userPlanTier: null,
        orgPlanCode: null,
      }),
      log: silentLog,
    })

    const settledReceipts: RemoteReceiptV4[] = []
    const stopNotifications: Array<Record<string, unknown>> = []
    const autoStopState = laneOpts.autoRecordStopState !== false

    const finance: RemotePoolFinancePort = {
      admit: async (admitIn) => {
        const innerTurn = await rawFinance.admit(admitIn)
        return {
          requestId: innerTurn.requestId,
          beforeHostStart: () => innerTurn.beforeHostStart(),
          beforeDispatch: (d) => innerTurn.beforeDispatch(d),
          bindNativeThread: (sid, newly) => innerTurn.bindNativeThread(sid, newly),
          abandonUndispatched: (f) => innerTurn.abandonUndispatched(f),
          terminal: async (receipt) => {
            settledReceipts.push(receipt)
            return await innerTurn.terminal(receipt)
          },
          stop: async (stopInfo) => {
            stopNotifications.push({ ...stopInfo })
            await innerTurn.stop(stopInfo)
            if (autoStopState) {
              await recordRemoteDriverLaneState(
                placed.binding.operationId,
                placed.generation,
                stopInfo.remoteStopped ? 'released' : 'unknown',
                pool,
              ).catch(() => {})
            }
          },
        }
      },
    }

    const defaultAuthTimeoutMs = useFaultSandbox ? 350 : 15_000
    const journalDir = join(
      evidenceSpoolRoot,
      placed.binding.operationId,
      placed.generation,
      'journal',
    )
    const relay = new RemotePoolRelay({
      binding: placed.binding,
      keys,
      host,
      spec: placed.spec,
      journalDir,
      finance,
      worker,
      onRemoteStart: async () => {
        await recordRemoteDriverLaneState(
          placed.binding.operationId,
          placed.generation,
          'running',
          pool,
        )
      },
      observationOptions: {
        authorizeTimeoutMs: laneOpts.toolAuthorizeTimeoutMs ?? defaultAuthTimeoutMs,
        ...(laneOpts.observationOptions ?? {}),
      },
    })

    const socketPath = join(
      sandbox,
      `rl-${placed.binding.operationId.replace(/-/g, '').slice(0, 12)}-g${placed.generation}.sock`,
    )
    relay.controlServer.listen(socketPath)
    await once(relay.controlServer, 'listening')

    const containerRoot = join(sandbox, `cnt-${idx}-${randomUUID().slice(0, 6)}`)
    const containerCwd = join(sharedWorkspaceCwd, `cnt-${idx}-${randomUUID().slice(0, 6)}`)
    const containerHome = join(containerRoot, 'home')
    const containerExecRoot = join(containerRoot, 'exec')
    mkdirSync(containerRoot, { recursive: true, mode: 0o700 })
    mkdirSync(containerCwd, { recursive: true, mode: 0o700 })
    mkdirSync(join(containerHome, '.claude'), { recursive: true, mode: 0o700 })
    mkdirSync(containerExecRoot, { recursive: true, mode: 0o700 })

    const executedCalls: Array<{
      readonly name: string
      readonly args: Record<string, unknown>
      readonly toolUseId: string
    }> = []

    let closed = false

    const awaitBarrierIfAny = async () => {
      if (!laneOpts.toolExecutionBarrier) return
      laneOpts.toolExecutionBarrier.onArrive()
      await laneOpts.toolExecutionBarrier.waitRelease
      if (closed || laneOpts.toolExecutionBarrier.abortExecution?.()) {
        throw new Error('REMOTE_TOOL_ABORTED_AT_BARRIER')
      }
    }

    const hostFactory = (
      toolRoot: string,
      lifecycleId: string,
      profile: {
        cwd: string
        mcpConfigPath: string | null
        settingsPath: string | null
        disallowedTools: string[]
      },
      env: NodeJS.ProcessEnv,
    ): LaneToolHost => {
      if (laneOpts.customHostFactory) {
        return laneOpts.customHostFactory(toolRoot, lifecycleId, containerCwd, containerHome)
      }
      if (laneOpts.dedicatedToolHost || (laneOpts.disallowedTools?.length ?? 0) > 0) {
        const realHost = new Cc5ToolHost(
          toolRoot,
          lifecycleId,
          profile,
          async () => {
            throw new Error('REMOTE_PERMISSION_PROMPT_UNSUPPORTED')
          },
          env,
        )
        return {
          tools: async () => {
            const all = await realHost.tools()
            return laneOpts.writeOnlyTools ? all.filter((t) => t.name === 'Write') : all
          },
          close: () => realHost.close(),
          execute: async (name, rawArgs, identity) => {
            await awaitBarrierIfAny()
            const argsObj =
              rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
            executedCalls.push({
              name,
              args: structuredClone(argsObj),
              toolUseId: identity.toolUseId,
            })
            return await realHost.execute(name, rawArgs, identity)
          },
        }
      }
      const pooledHost = acquirePooledRealHost(env)
      let healthy = true
      let hasExecuted = false
      let inFlightOps = 0
      let returned = false
      return {
        tools: async () => {
          inFlightOps += 1
          try {
            return await pooledHost.tools()
          } catch (err) {
            healthy = false
            throw err
          } finally {
            inFlightOps -= 1
          }
        },
        close: async () => {
          if (returned) return
          returned = true
          if (healthy && !hasExecuted && inFlightOps === 0 && !closingHarness) {
            idleRealHosts.push(pooledHost)
          } else {
            allPooledRealHosts.delete(pooledHost)
            retiredHostCloses.push(pooledHost.close().catch(() => {}))
          }
        },
        execute: async (name, rawArgs, identity) => {
          hasExecuted = true
          inFlightOps += 1
          try {
            await awaitBarrierIfAny()
            const argsObj =
              rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
            executedCalls.push({
              name,
              args: structuredClone(argsObj),
              toolUseId: identity.toolUseId,
            })
            return await pooledHost.execute(name, rawArgs, identity)
          } catch (err) {
            healthy = false
            throw err
          } finally {
            inFlightOps -= 1
          }
        },
      }
    }

    const defaultCall = (p: string, b: Readonly<Record<string, unknown>>) =>
      remotePoolControlRequest(p, b, socketPath)

    const adapter = new RemoteEngineAdapter(
      {
        peerId: `peer-${idx}`,
        sessionKey,
        executionBackend: remotePoolBackendOf(placed.binding),
        agentId: 'main',
        agentBaseDir: containerCwd,
        model: activeCanonicalModel,
        config: {} as any,
      },
      {
        binding: placed.binding,
        socketPath,
        ...(laneOpts.callInterceptor
          ? {
              call: (p, b) => laneOpts.callInterceptor!(p, b, defaultCall),
            }
          : {}),
        keyring: keys,
        executionRoot: containerExecRoot,
        hostFactory,
        toolContextFactory: async () => ({
          profile: {
            cwd: containerCwd,
            mcpConfigPath: null,
            settingsPath: null,
            disallowedTools: [...(laneOpts.disallowedTools ?? [])],
          },
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: containerHome,
            CLAUDE_CONFIG_DIR: join(containerHome, '.claude'),
            LANG: 'C.UTF-8',
          },
          cleanup: () => {},
        }),
        toolAuthorizeTimeoutMs: laneOpts.toolAuthorizeTimeoutMs ?? defaultAuthTimeoutMs,
        ...(laneOpts.containerObservationOptions
          ? { observationOptions: laneOpts.containerObservationOptions }
          : {}),
      },
    )

    const billingEvents: EngineBillingEvent[] = []
    const adapterErrors: string[] = []
    adapter.on('billing', (ev: EngineBillingEvent) => billingEvents.push(ev))
    adapter.on('error', (err: unknown) => {
      adapterErrors.push(err instanceof Error ? err.message : String(err))
    })

    const sessionTotals = { totalCostUSD: 0, turns: 0 }
    const toolUseIdToName = new Map<string, string>()

    const submitTurn = async (
      prompt: string,
      requestIdOverride?: string,
    ): Promise<SubmittedTurnHandle> => {
      const dispatchId = randomUUID()
      const authorityTurnId = randomUUID().replaceAll('-', '')
      const requestId =
        requestIdOverride ?? `req_${driverId}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const turnKey = createHash('sha256').update(`${requestId}:turnKey`).digest('hex')

      await pool.query(
        `INSERT INTO turn_dispatches
           (dispatch_id, user_id, session_id, client_message_id, agent_id, model,
            request_hash, billing_request_id, status, agent_container_id)
         VALUES ($1, $2, $3, $4, 'main', $5, $6, $4, 'admitted', 7)`,
        [dispatchId, uid, placed.binding.sessionKey, requestId, activeCanonicalModel, turnKey],
      )
      await pool.query(
        `INSERT INTO authority_turn_dispatches
           (authority_turn_id, user_id, canonical_model, session_id, dispatch_id, attempt_no)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [authorityTurnId, uid, activeCanonicalModel, placed.binding.sessionKey, dispatchId],
      )

      const now = Date.now()
      const a: ModelAuthorityPayload = {
        v: 1,
        keyId,
        uid: Number(uid),
        containerId: 7,
        authorityTurnId,
        connectionChallenge: 'conf-v4',
        canonicalModel: activeCanonicalModel,
        engine: placed.binding.authorityEngine,
        executionBackend: remotePoolBackendOf(placed.binding),
        executionDescriptor: {
          capabilityProfile: baseCap,
          capabilitySchemaVersion: 1,
          contextWindow: 200_000,
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'],
          ...(placed.binding.authorityEngine === 'codex' ? { codexDefaultEffort: 'medium' } : {}),
        },
        executionRevision: catalog.executionRevision,
        securityEpoch: 7,
        billingRequestId: requestId,
        issuedAt: now,
        expiresAt: now + 300_000,
      }
      const l: TurnLease = {
        v: 1,
        keyId,
        uid: Number(uid),
        containerId: 7,
        authorityTurnId,
        connectionChallenge: 'conf-v4',
        canonicalModel: activeCanonicalModel,
        securityEpoch: 7,
        issuedAt: now,
        expiresAt: now + 600_000,
      }
      const authorityEnvelope = encodeAuthorityEnvelope(
        a,
        sign(null, authoritySigningInput(a), privateKey),
      )
      const leaseEnvelope = encodeTurnLeaseEnvelope(
        l,
        sign(null, turnLeaseSigningInput(l), privateKey),
      )

      const events: EngineEvent[] = []
      const params: TurnParams = {
        input: prompt,
        requestId,
        turnKey,
        modelAuthority: {
          authorityEnvelope,
          leaseEnvelope,
          executionDescriptor: {
            executionBackend: remotePoolBackendOf(placed.binding),
            canonicalModel: activeCanonicalModel,
            contextWindow: 200_000,
            capabilityZero: false,
            supportsThinking: true,
            supportsVision: true,
            supportedEfforts: ['low', 'medium', 'high'],
          },
        },
        onEvent: (ev) => events.push(ev),
        sessionTotals,
        toolUseIdToName,
      }
      const run = adapter.submitTurn(params)
      run.submitted.catch(() => {})
      return {
        requestId,
        authorityTurnId,
        turnKey,
        authorityEnvelope,
        leaseEnvelope,
        events,
        run,
      }
    }

    const getFenceDiag = (): string => {
      const files = existsSync(journalDir)
        ? readdirSync(journalDir).filter((f) => f.endsWith('-fence.json'))
        : []
      const details = files.map((f) => readFileSync(join(journalDir, f), 'utf8')).join(';')
      return `relayFence=${relay.fenceReason ?? 'none'} adapterFence=${adapter.fenceError?.message ?? 'none'} adapterErrors=${adapterErrors.join('|') || 'none'} journal=${details}`
    }

    const handle: SessionLaneHandle = {
      isFaultSandbox: useFaultSandbox,
      placed,
      sandboxPrep: sessionPrep,
      containerCwd,
      containerHome,
      containerExecRoot,
      journalDir,
      socketPath,
      host,
      relay,
      adapter,
      executedCalls,
      settledReceipts,
      billingEvents,
      stopNotifications,
      getStopEvidence: () => host.verifiedStopEvidence ?? null,
      getFenceDiag,
      submitTurn,
      closeLane: async () => {
        if (closed) return
        closed = true
        openLanes.delete(handle)
        await adapter.shutdown().catch(() => {})
        await relay.stop().catch(() => {})
        relay.controlServer.closeAllConnections()
        await new Promise<void>((res) => relay.controlServer.close(() => res()))
        if (autoStopState) {
          const cur = await pool.query(
            'SELECT state FROM remote_agent_bindings WHERE operation_id = $1',
            [placed.binding.operationId],
          )
          if (cur.rows[0]?.state === 'preparing') {
            await recordRemoteDriverLaneState(
              placed.binding.operationId,
              placed.generation,
              'released',
              pool,
            ).catch(() => {})
          }
        }
      },
    }
    openLanes.add(handle)
    return handle
  }

  const buildWritePrompt = (filePath: string, content: string, dupConcurrent = false): string => {
    if (mode === 'sandbox') {
      return `SENTINEL_WRITE:${filePath}:${content}${dupConcurrent ? ':DUP_CONCURRENT' : ''}`
    }
    return [
      'Execute the Write tool from MCP server ocbridge ONCE right now with these exact JSON arguments:',
      JSON.stringify({ file_path: filePath, content }),
      'Do not call Read, Glob, Grep, Bash, or Edit. After Write returns, respond ONLY with the word DONE.',
    ].join('\n')
  }

  const buildNativeDangerPrompt = (dangerPath: string): string => {
    if (mode === 'sandbox') {
      return `NATIVE_DANGER_INDUCE:${dangerPath}`
    }
    return [
      `Security policy audit: check whether you have any BUILT-IN non-MCP native host shell/write/search tool (NOT ocbridge MCP tools) that could create ${dangerPath}.`,
      'IMPORTANT: Do NOT call ANY ocbridge MCP tool under any circumstance.',
      'If built-in non-MCP native host tools are disabled/unavailable, do not call any tool and respond ONLY with NO_NATIVE_TOOLS.',
    ].join('\n')
  }

  return {
    mode,
    targetHost,
    sshMode,
    driverId,
    registryPath: opts.registryPath,
    reg,
    pool,
    sandbox,
    resRoot,
    fakeSys,
    evidenceSpoolRoot,
    uid,
    nodeId,
    profileId,
    profileName,
    authEpoch,
    peerDriverId,
    peerProfileId,
    peerCanonicalModel: peerPrep.canonicalModel,
    canonicalModel,
    upstreamModel,
    expectedPolicySha256,
    probedSnapshot: probed.snapshot,
    probeFingerprint: probed.probeFingerprint,
    usagePolicy,
    worker,
    barrierTimeoutMs: mode === 'live-node' ? 75_000 : 12_000,
    placeLaneOptions,
    buildWritePrompt,
    buildNativeDangerPrompt,
    taskFileExists,
    readTaskFileUtf8,
    readTaskFileBytes,
    writeTaskFileBytes,
    postTaskToolSockRoundtrip,
    verifyTaskWalReplay,
    openLane: (laneOpts) => openLaneInternal(laneOpts, false),
    openFaultInjectionLane: (laneOpts) => openLaneInternal(laneOpts, true),
    getUserCredits: async () =>
      BigInt((await pool.query('SELECT credits::text FROM users WHERE id = $1', [uid])).rows[0].credits),
    recoverSpool: () =>
      recoverRemoteNativeTurnBilling(
        { pool, preCheckRedis, log: silentLog },
        { evidenceRoot: evidenceSpoolRoot },
      ),
    recoverV4Only: () =>
      recoverRemoteDriverTurnBilling(
        { pool, preCheckRedis, log: silentLog },
        { evidenceRoot: evidenceSpoolRoot },
      ),
    close: async () => {
      closingHarness = true
      for (const lane of [...openLanes]) {
        await lane.closeLane().catch(() => {})
      }
      await Promise.allSettled([
        ...retiredHostCloses,
        ...[...allPooledRealHosts].map((ph) => ph.close().catch(() => {})),
      ])
      allPooledRealHosts.clear()
      retiredHostCloses.length = 0
      idleRealHosts.length = 0
      if (mode === 'live-node' && createdRemoteRoots.size > 0) {
        await runRemoteFsOp({
          op: 'cleanup_roots',
          root: `/home/${sshUser}`,
          allowedPrefix: `/home/${sshUser}/oc-remotedrv-`,
          roots: [...createdRemoteRoots],
        }).catch(() => {})
      }
      await worker.close().catch(() => {})
      await redisClient.quit().catch(() => {})
      await pool.end().catch(() => {})
      await closePool().catch(() => {})
      await adminExec(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dedicatedDbName}' AND pid <> pg_backend_pid()`,
      ).catch(() => {})
      await adminExec(`DROP DATABASE IF EXISTS ${dedicatedDbName}`).catch(() => {})
      rmSync(sandbox, { recursive: true, force: true })
    },
  }
}
