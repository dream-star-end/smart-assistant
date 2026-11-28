/**
 * Provisioning saga steps for V3/V5 containers: local 409 NameConflict self-heal,
 * CC5 fresh lane preparation/release, Docker/remote createAndStart, Tx1 admission,
 * Tx2 commit, and failure compensation.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo`, zero dynamic SQL,
 * all functions <= 85L, CC <= 16, maxNesting <= 4.
 */
import type Docker from "dockerode"
import type { PoolClient } from "pg"
import type { Cc5PreparedContainer } from "@openclaude/gateway/cc5-container-runtime"
import { removeContainerSavingLogs } from "../../compute-pool/containerLogArchive.js"
import {
  RUNTIME_CHANNEL_LABEL_KEY,
  v3NetworkNameForChannel,
  type ContainerSpec,
} from "../../compute-pool/containerService.js"
import { dockerContainerOwnedByChannel, getRuntimeChannel } from "../../runtimeChannel.js"
import { buildContainerExtraHosts } from "../constants.js"
import {
  SYNTHETIC_EVAL_SCRATCH_TMPFS_OPTIONS,
  SYNTHETIC_EVAL_SCRATCH_TMPFS_TARGETS,
  type SyntheticEvalOverlayRuntime,
} from "../syntheticEvalOverlayRuntime.js"
import { SupervisorError } from "../types.js"
import { isNameConflict, isNotFound, wrapDockerError } from "./dockerErrorsAndImages.js"
import {
  acquireHostCapLock,
  acquireUserLifecycleLock,
  hashSecretToBuffer,
} from "./namingAndLocks.js"
import {
  V3_ADMIN_PIDS_LIMIT,
  V3_AGENT_USER,
  V3_CONFIG_TMPFS_PATH,
  V3_CONTAINER_PORT,
  V3_MANAGED_LABEL_KEY,
  V3_UID_LABEL_KEY,
  supervisorLog as log,
  type V3SupervisorDeps,
} from "./types.js"

const NAME_CONFLICT_REMOVABLE_STATES: ReadonlySet<string> = new Set([
  "created",
  "exited",
  "dead",
])

function checkRemovableOwnedConflict(
  uid: number,
  containerName: string,
  info: Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>,
): string | null {
  const labels = (info.Config?.Labels ?? {}) as Record<string, string>
  const state = info.State?.Status ?? "unknown"
  const conflictId = info.Id ?? containerName
  const managedOk = labels[V3_MANAGED_LABEL_KEY] === "1"
  const uidOk = labels[V3_UID_LABEL_KEY] === String(uid)
  const channelOk = dockerContainerOwnedByChannel(
    labels[RUNTIME_CHANNEL_LABEL_KEY],
    getRuntimeChannel(),
  )
  const stateRemovable = NAME_CONFLICT_REMOVABLE_STATES.has(state)

  if (managedOk && uidOk && channelOk && stateRemovable) {
    return conflictId
  }

  const reason = !managedOk
    ? "not-managed"
    : !uidOk
      ? "uid-mismatch"
      : !channelOk
        ? "channel-mismatch"
        : "alive"
  log.warn("[v3supervisor] name-conflict: refusing to remove conflicting container", {
    uid,
    containerName,
    conflictId,
    state,
    managedLabel: labels[V3_MANAGED_LABEL_KEY] ?? null,
    uidLabel: labels[V3_UID_LABEL_KEY] ?? null,
    channelLabel: labels[RUNTIME_CHANNEL_LABEL_KEY] ?? null,
    reason,
  })
  return null
}

async function retryCreateOnce(
  docker: Docker,
  uid: number,
  containerName: string,
  createOpts: Parameters<Docker["createContainer"]>[0],
): Promise<Awaited<ReturnType<Docker["createContainer"]>>> {
  try {
    return await docker.createContainer(createOpts)
  } catch (retryErr) {
    log.warn("[v3supervisor] name-conflict self-heal: retry create failed after rm", {
      uid,
      containerName,
      err: retryErr instanceof Error ? retryErr.message : String(retryErr),
    })
    throw wrapDockerError(retryErr)
  }
}

export async function createV3ContainerLocalWithSelfHeal(
  docker: Docker,
  uid: number,
  containerName: string,
  createOpts: Parameters<Docker["createContainer"]>[0],
): Promise<Awaited<ReturnType<Docker["createContainer"]>>> {
  let firstErr: unknown
  try {
    return await docker.createContainer(createOpts)
  } catch (err) {
    if (!isNameConflict(err)) throw wrapDockerError(err)
    firstErr = err
  }

  let info: Awaited<ReturnType<ReturnType<Docker["getContainer"]>["inspect"]>>
  try {
    info = await docker.getContainer(containerName).inspect()
  } catch (inspectErr) {
    if (isNotFound(inspectErr)) {
      log.info(
        "[v3supervisor] name-conflict self-heal: conflict vanished before inspect, retrying create",
        { uid, containerName },
      )
      return retryCreateOnce(docker, uid, containerName, createOpts)
    }
    log.warn(
      "[v3supervisor] name-conflict self-heal: inspect failed, not removing (preserving failure)",
      {
        uid,
        containerName,
        err: inspectErr instanceof Error ? inspectErr.message : String(inspectErr),
      },
    )
    throw wrapDockerError(firstErr)
  }

  const conflictId = checkRemovableOwnedConflict(uid, containerName, info)
  if (conflictId === null) throw wrapDockerError(firstErr)

  try {
    await removeContainerSavingLogs(docker.getContainer(conflictId), "name_conflict_heal")
  } catch (rmErr) {
    if (!isNotFound(rmErr)) {
      log.warn(
        "[v3supervisor] name-conflict self-heal: rm failed, aborting heal (preserving failure)",
        {
          uid,
          containerName,
          conflictId,
          err: rmErr instanceof Error ? rmErr.message : String(rmErr),
        },
      )
      throw wrapDockerError(firstErr)
    }
  }
  log.info(
    "[v3supervisor] name-conflict self-heal: removed stale conflicting container, retrying create",
    { uid, containerName, conflictId, state: info.State?.Status ?? "unknown" },
  )
  return retryCreateOnce(docker, uid, containerName, createOpts)
}

/** Revoke now, retain unknown on failure; never block existing Docker cleanup from running. */
export function beginCc5Release(
  deps: V3SupervisorDeps,
  rowId: number,
  dockerId?: string,
): Promise<void> {
  let release: Promise<void>
  try {
    release = deps.cc5?.release(String(rowId), dockerId || undefined) ?? Promise.resolve()
  } catch {
    release = Promise.reject(new Error("CC5_REMOTE_EXIT_UNPROVED"))
  }
  void release.catch((err) => {
    void err
  })
  return release
}

export async function compensateProvisionFailure(
  deps: V3SupervisorDeps,
  rowId: number,
  createdDockerId: string,
  useRemote: boolean,
  hostId: string | undefined,
): Promise<void> {
  const cc5Release = beginCc5Release(deps, rowId, createdDockerId).catch(() => {
    console.error("[v3supervisor] cc5 remote exit unproved; own operation retained")
  })
  try {
    await deps.pool.query(
      `UPDATE agent_containers
          SET state = 'vanished', updated_at = NOW()
        WHERE id = $1 AND runtime_channel = $2 AND runtime_kind = 'docker'`,
      [String(rowId), getRuntimeChannel()],
    )
  } catch (err) {
    console.warn(
      `[v3supervisor] compensate: mark row ${rowId} vanished failed: ${(err as Error)?.message ?? String(err)}`,
    )
  }
  if (createdDockerId) {
    try {
      if (useRemote) {
        await deps.containerService!.remove(hostId!, createdDockerId, { force: true })
      } else {
        await removeContainerSavingLogs(
          deps.docker.getContainer(createdDockerId),
          "provision_compensate",
        )
      }
    } catch (rmErr) {
      void rmErr
    }
  }
  await cc5Release
}

export async function prepareCc5ContainerBinding(
  deps: V3SupervisorDeps,
  uid: number,
  rowId: number,
  useRemote: boolean,
  cc5Eligible: boolean,
): Promise<{
  cc5Prepared: Cc5PreparedContainer | null
  cc5KeyringAssignment: string | undefined
}> {
  if (!cc5Eligible) {
    return { cc5Prepared: null, cc5KeyringAssignment: undefined }
  }
  if (getRuntimeChannel() !== "v5" || useRemote || !deps.cc5 || !deps.modelAuthority?.required) {
    console.error("[v3supervisor] cc5 fresh local binding is unavailable; degrading cc5 lane", {
      uid,
      containerId: rowId,
    })
    return { cc5Prepared: null, cc5KeyringAssignment: undefined }
  }
  const assignment = deps.modelAuthority.keyringEnvAssignment
  const candidateKeyring = typeof assignment === "function" ? assignment() : assignment
  const prefix = "OC_MODEL_AUTHORITY_KEYRING="
  if (!candidateKeyring.startsWith(prefix)) {
    console.error("[v3supervisor] cc5 public authority keyring is unavailable; degrading cc5 lane", {
      uid,
      containerId: rowId,
    })
    return { cc5Prepared: null, cc5KeyringAssignment: undefined }
  }
  try {
    const cc5Prepared = await deps.cc5.prepare({
      uid,
      containerDbId: String(rowId),
      local: true,
      publicKeyring: candidateKeyring.slice(prefix.length),
    })
    return { cc5Prepared, cc5KeyringAssignment: candidateKeyring }
  } catch (cc5Err) {
    await beginCc5Release(deps, rowId).catch((e) => {
      void e
    })
    console.error(
      "[v3supervisor] cc5 fresh binding prepare failed; degrading cc5 lane for container",
      {
        uid,
        containerId: rowId,
        errMsg: cc5Err instanceof Error ? cc5Err.message : String(cc5Err),
      },
    )
    return { cc5Prepared: null, cc5KeyringAssignment: candidateKeyring }
  }
}

export interface CreateAndStartContainerInput {
  deps: V3SupervisorDeps
  uid: number
  row: { id: number; boundIp: string }
  containerName: string
  useRemote: boolean
  hostId: string | undefined
  env: string[]
  binds: string[]
  runtimeLabels: Record<string, string>
  memoryBytes: number
  nanoCpus: number
  pidsLimit: number
  cc5Prepared: Cc5PreparedContainer | null
  hasSyntheticEvalOverlay: boolean
}

function buildRemoteContainerSpec(input: CreateAndStartContainerInput): ContainerSpec {
  const envMap: Record<string, string> = {}
  for (const e of input.env) {
    const i = e.indexOf("=")
    if (i > 0) envMap[e.slice(0, i)] = e.slice(i + 1)
  }
  const bindObjs = input.binds.map((b) => {
    const lastColon = b.lastIndexOf(":")
    const mid = b.lastIndexOf(":", lastColon - 1)
    const src = b.slice(0, mid)
    const target = b.slice(mid + 1, lastColon)
    const mode = b.slice(lastColon + 1)
    return { source: src, target, readonly: mode === "ro" }
  })
  return {
    containerDbId: input.row.id,
    boundIp: input.row.boundIp,
    image: input.deps.image,
    name: input.containerName,
    env: envMap,
    labels: { [V3_UID_LABEL_KEY]: String(input.uid), ...input.runtimeLabels },
    binds: bindObjs,
    memoryBytes: input.memoryBytes,
    nanoCpus: input.nanoCpus,
    pidsLimit: input.pidsLimit,
    internalPort: V3_CONTAINER_PORT,
  }
}

function buildLocalCreateOptions(
  input: CreateAndStartContainerInput,
): Parameters<Docker["createContainer"]>[0] {
  const netName = v3NetworkNameForChannel()
  return {
    name: input.containerName,
    Image: input.deps.image,
    Env: input.env,
    User: V3_AGENT_USER,
    Labels: {
      [V3_MANAGED_LABEL_KEY]: "1",
      [V3_UID_LABEL_KEY]: String(input.uid),
      [RUNTIME_CHANNEL_LABEL_KEY]: getRuntimeChannel(),
      ...input.runtimeLabels,
    },
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    NetworkingConfig: {
      EndpointsConfig: {
        [netName]: {
          IPAMConfig: { IPv4Address: input.row.boundIp },
        },
      },
    },
    HostConfig: {
      NetworkMode: netName,
      ExtraHosts: buildContainerExtraHosts(),
      Memory: input.memoryBytes,
      MemorySwap: input.memoryBytes,
      MemorySwappiness: 0,
      ...(input.memoryBytes === 0 && input.nanoCpus === 0 ? {} : { NanoCpus: input.nanoCpus }),
      PidsLimit: input.pidsLimit === 0 ? V3_ADMIN_PIDS_LIMIT : input.pidsLimit,
      CapDrop: ["NET_RAW", "NET_ADMIN"],
      CapAdd: [],
      Privileged: false,
      SecurityOpt: [],
      Tmpfs: {
        [V3_CONFIG_TMPFS_PATH]: "rw,nosuid,nodev,size=4m,mode=0700,uid=1000,gid=1000",
        ...(input.hasSyntheticEvalOverlay
          ? Object.fromEntries(
              SYNTHETIC_EVAL_SCRATCH_TMPFS_TARGETS.map((target) => [
                target,
                SYNTHETIC_EVAL_SCRATCH_TMPFS_OPTIONS,
              ]),
            )
          : {}),
      },
      Binds: input.binds,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      ShmSize: 64 * 1024 * 1024,
      UsernsMode: "",
    },
  }
}

export async function createAndStartProvisionedContainer(
  input: CreateAndStartContainerInput,
  onCreatedId: (id: string) => void,
): Promise<string> {
  if (input.useRemote) {
    const spec = buildRemoteContainerSpec(input)
    try {
      const r = await input.deps.containerService!.createAndStart(input.hostId!, spec)
      if (
        !r ||
        typeof r.containerInternalId !== "string" ||
        r.containerInternalId.trim().length === 0
      ) {
        throw new SupervisorError(
          "RemoteContractViolation",
          `node-agent createAndStart returned empty containerInternalId (host=${input.hostId})`,
        )
      }
      onCreatedId(r.containerInternalId)
      return r.containerInternalId
    } catch (err) {
      if (err instanceof SupervisorError) throw err
      throw wrapDockerError(err)
    }
  }

  const createOpts = buildLocalCreateOptions(input)
  const container = await createV3ContainerLocalWithSelfHeal(
    input.deps.docker,
    input.uid,
    input.containerName,
    createOpts,
  )
  onCreatedId(container.id)
  if (input.cc5Prepared) await input.deps.cc5!.bindCreated(input.cc5Prepared, container.id)

  try {
    await container.start()
  } catch (startErr) {
    try {
      await removeContainerSavingLogs(container, "start_failed")
    } catch (rmErr) {
      void rmErr
    }
    throw wrapDockerError(startErr)
  }
  return container.id
}

export async function runProvisionAdmissionTx1(
  deps: V3SupervisorDeps,
  uid: number,
  effectiveHostUuid: string,
  boundIp: string | undefined,
  pickIp: () => string,
  mintSecret: () => string,
  allocateRowFn: (
    client: PoolClient,
    uid: number,
    secretHash: Buffer,
    pickIp: () => string,
    hostUuid: string,
    image: string,
    fixedBoundIp?: string,
  ) => Promise<{ id: number; boundIp: string }>,
): Promise<{ row: { id: number; boundIp: string }; secret: string }> {
  const tx1Client = await deps.pool.connect()
  try {
    await tx1Client.query("BEGIN")
    await acquireUserLifecycleLock(tx1Client, uid)

    const dupQ = await tx1Client.query<{ id: string }>(
      `SELECT id::text AS id FROM agent_containers
        WHERE user_id = $1::bigint AND state = 'active' AND runtime_channel = $2
          AND runtime_kind = 'docker'
        LIMIT 1`,
      [String(uid), getRuntimeChannel()],
    )
    if (dupQ.rows.length > 0) {
      throw new SupervisorError(
        "NameConflict",
        `uid ${uid} already has active container (row ${dupQ.rows[0]!.id}; concurrent ensure)`,
      )
    }

    await acquireHostCapLock(tx1Client, effectiveHostUuid)

    const capQ = await tx1Client.query<{ active: string; max_containers: number | null }>(
      `SELECT
           (SELECT COUNT(*) FROM agent_containers
             WHERE state = 'active' AND host_uuid = $1::uuid AND runtime_channel = $2
               AND runtime_kind = 'docker')::text AS active,
           (SELECT max_containers FROM compute_hosts WHERE id = $1::uuid)
             AS max_containers`,
      [effectiveHostUuid, getRuntimeChannel()],
    )
    const capRow = capQ.rows[0]
    if (!capRow || capRow.max_containers == null) {
      throw new SupervisorError(
        "InvalidArgument",
        `host ${effectiveHostUuid} not found in compute_hosts`,
      )
    }
    const active = Number.parseInt(capRow.active ?? "0", 10)
    const maxContainers = capRow.max_containers
    if (active >= maxContainers) {
      log.info("v3 per-host cap hit", {
        hostId: effectiveHostUuid,
        active,
        max: maxContainers,
        uid,
      })
      throw new SupervisorError(
        "HostFull",
        `host ${effectiveHostUuid} at cap (${active}/${maxContainers})`,
      )
    }

    const secret = mintSecret()
    if (!/^[0-9a-f]{64}$/.test(secret)) {
      throw new SupervisorError(
        "InvalidArgument",
        "secret generator must return 64 lowercase hex chars (32 bytes)",
      )
    }
    const secretHash = hashSecretToBuffer(secret)
    const row = await allocateRowFn(
      tx1Client,
      uid,
      secretHash,
      pickIp,
      effectiveHostUuid,
      deps.image,
      boundIp,
    )
    await tx1Client.query("COMMIT")
    return { row, secret }
  } catch (err) {
    try {
      await tx1Client.query("ROLLBACK")
    } catch (rbErr) {
      void rbErr
    }
    throw err
  } finally {
    tx1Client.release()
  }
}

export async function commitProvisionTx2(
  deps: V3SupervisorDeps,
  rowId: number,
  createdDockerId: string,
  boundCodexAccountId: bigint | null,
  useRemote: boolean,
  hostId: string | undefined,
  cc5Prepared: Cc5PreparedContainer | null,
  syntheticEvalOverlay: ReturnType<SyntheticEvalOverlayRuntime["resolvePrepared"]>,
): Promise<void> {
  try {
    const upd = await deps.pool.query(
      `UPDATE agent_containers
          SET container_internal_id = $2,
              codex_account_id = $3,
              updated_at = NOW()
        WHERE id = $1 AND state = 'active' AND runtime_channel = $4
          AND runtime_kind = 'docker'`,
      [
        String(rowId),
        createdDockerId,
        boundCodexAccountId === null ? null : String(boundCodexAccountId),
        getRuntimeChannel(),
      ],
    )
    if ((upd.rowCount ?? 0) === 0) {
      throw new SupervisorError(
        "NameConflict",
        `provision row ${rowId} vanished before Tx2 commit (concurrent lifecycle action); retry`,
      )
    }
    if (cc5Prepared) await deps.cc5!.activate(cc5Prepared, createdDockerId)
    if (syntheticEvalOverlay) {
      deps.syntheticEvalOverlay!.activatePrepared(syntheticEvalOverlay, createdDockerId)
    }
  } catch (err) {
    await compensateProvisionFailure(deps, rowId, createdDockerId, useRemote, hostId)
    throw err
  }
}
