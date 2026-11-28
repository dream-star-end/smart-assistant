/**
 * Docker container teardown (stop/remove + CC5 release + Codex auth cleanup),
 * WebSocket activity heartbeat, and active container status inspection.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo`, zero dynamic SQL,
 * all functions <= 85L, CC <= 16, maxNesting <= 4.
 */
import { removeCodexContainerAuthDir } from "../../codex-auth/codexAuthFile.js"
import { removeContainerSavingLogs } from "../../compute-pool/containerLogArchive.js"
import {
  readDockerRuntimeInspection,
  readWireRuntimeInspection,
  type RuntimeInspection,
} from "../../compute-pool/dockerInspection.js"
import { getRuntimeChannel } from "../../runtimeChannel.js"
import { SupervisorError } from "../types.js"
import {
  aggregatePartialV3Cleanup,
  isNotFound,
  isNotModified,
  wrapDockerError,
} from "./dockerErrorsAndImages.js"
import { beginCc5Release } from "./provisionContainerSaga.js"
import {
  PROVISION_INFLIGHT_GRACE_MS,
  V3_CONTAINER_PORT,
  type V3ContainerStatus,
  type V3SupervisorDeps,
} from "./types.js"

function resolveDockerCleanupRoute(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  dbHostUuid: string | null,
): { cid: string; useRemote: boolean; effectiveHostUuid: string | null } | null {
  const callerHostUuid: string | null = containerRow.host_uuid ?? null
  if (callerHostUuid !== null && dbHostUuid !== null && callerHostUuid !== dbHostUuid) {
    console.warn("[v3supervisor.stopAndRemove] caller host_uuid != db host_uuid", {
      containerId: containerRow.id,
      callerHostUuid,
      dbHostUuid,
    })
  }
  const effectiveHostUuid: string | null = callerHostUuid ?? dbHostUuid
  if (!containerRow.container_internal_id) return null
  const cid = containerRow.container_internal_id

  const isMultiHost =
    typeof deps.selfHostId === "string" && deps.containerService !== undefined
  if (effectiveHostUuid === null && isMultiHost) {
    console.warn(
      "[v3supervisor.stopAndRemove] host_uuid unknown in multi-host system, skipping docker cleanup",
      { containerId: containerRow.id, cid, rowFound: true },
    )
    return null
  }

  const isRemote =
    typeof effectiveHostUuid === "string" &&
    typeof deps.selfHostId === "string" &&
    effectiveHostUuid !== deps.selfHostId
  if (isRemote && deps.containerService === undefined) {
    console.warn(
      "[v3supervisor.stopAndRemove] cross-host row but containerService missing, skipping docker cleanup",
      { containerId: containerRow.id, cid, hostUuid: effectiveHostUuid },
    )
    return null
  }
  return { cid, useRemote: isRemote, effectiveHostUuid }
}

async function cleanupCodexAuthBestEffort(
  deps: V3SupervisorDeps,
  containerId: number,
  useRemote: boolean,
  effectiveHostUuid: string | null,
  localCodexContainerDir: string,
): Promise<void> {
  if (!useRemote) {
    try {
      await removeCodexContainerAuthDir(localCodexContainerDir, String(containerId))
    } catch (err) {
      void err
    }
    return
  }
  if (deps.deleteRemoteCodexAuth) {
    try {
      await deps.deleteRemoteCodexAuth(effectiveHostUuid!, String(containerId))
    } catch (err) {
      void err
    }
  }
}

export async function cleanupV3DockerEffects(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  timeoutSec: number,
  dbHostUuid: string | null,
  localCodexContainerDir: string,
): Promise<void> {
  const route = resolveDockerCleanupRoute(deps, containerRow, dbHostUuid)
  if (!route) return

  const failures: Array<{ stage: "stop" | "remove"; err: SupervisorError }> = []
  try {
    if (route.useRemote) {
      await deps.containerService!.stop(route.effectiveHostUuid!, route.cid, { timeoutSec })
    } else {
      await deps.docker.getContainer(route.cid).stop({ t: timeoutSec })
    }
  } catch (err) {
    if (!isNotFound(err) && !isNotModified(err)) {
      failures.push({ stage: "stop", err: wrapDockerError(err) })
    }
  }

  let containerCleared = false
  try {
    if (route.useRemote) {
      await deps.containerService!.remove(route.effectiveHostUuid!, route.cid, { force: true })
    } else {
      await removeContainerSavingLogs(deps.docker.getContainer(route.cid), "stop_and_remove")
    }
    containerCleared = true
  } catch (err) {
    if (isNotFound(err)) {
      containerCleared = true
    } else {
      failures.push({ stage: "remove", err: wrapDockerError(err) })
    }
  }

  await cleanupCodexAuthBestEffort(
    deps,
    containerRow.id,
    route.useRemote,
    route.effectiveHostUuid,
    localCodexContainerDir,
  )
  if (containerCleared && failures.every((f) => f.stage === "stop")) return
  if (failures.length > 0) throw aggregatePartialV3Cleanup(failures)
}

export async function cleanupV3ContainerDockerWithCodexDir(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  timeoutSec: number,
  dbHostUuid: string | null,
  localCodexContainerDir: string,
): Promise<void> {
  const cc5Release = beginCc5Release(
    deps,
    containerRow.id,
    containerRow.container_internal_id ?? undefined,
  )
  let dockerFailed = false
  let dockerError: unknown
  try {
    await cleanupV3DockerEffects(deps, containerRow, timeoutSec, dbHostUuid, localCodexContainerDir)
  } catch (error) {
    dockerFailed = true
    dockerError = error
  }
  let remoteFailed = false
  try {
    await cc5Release
  } catch {
    remoteFailed = true
    console.error("[v3supervisor] cc5 remote exit unproved; own operation retained")
  }
  if (dockerFailed) throw dockerError
  if (remoteFailed) {
    throw new SupervisorError("PartialV3Cleanup", "cc5 remote exit remains unproved")
  }
}

export async function markV3ContainerActivity(
  deps: V3SupervisorDeps,
  agentContainerId: number,
): Promise<void> {
  if (!Number.isInteger(agentContainerId) || agentContainerId <= 0) return
  try {
    // lint-agent-containers-kind: allow — 按 id 刷心跳;desktop 隧道复用同一函数,不得加 kind
    await deps.pool.query(
      `UPDATE agent_containers
          SET last_ws_activity = NOW(),
              updated_at = NOW()
        WHERE id = $1::bigint AND state = 'active'`,
      [String(agentContainerId)],
    )
  } catch (err) {
    void err
  }
}

interface InspectedContainerFields {
  state: V3ContainerStatus["state"]
  runtimeInspection?: RuntimeInspection
  image?: string
  imageId?: string
  labels?: Record<string, string>
}

async function inspectActiveContainerFields(
  deps: V3SupervisorDeps,
  hostUuid: string | null,
  cid: string,
): Promise<InspectedContainerFields> {
  const useRemote =
    typeof hostUuid === "string" &&
    typeof deps.selfHostId === "string" &&
    hostUuid !== deps.selfHostId &&
    deps.containerService !== undefined

  try {
    if (useRemote) {
      const info = await deps.containerService!.inspect(hostUuid!, cid)
      const rinfo = info as { image?: unknown; imageId?: unknown; labels?: unknown }
      return {
        state: info.state === "running" ? "running" : "stopped",
        runtimeInspection: readWireRuntimeInspection(info.runtimeInspection, info.id, cid),
        image: typeof rinfo.image === "string" ? rinfo.image : undefined,
        imageId: typeof rinfo.imageId === "string" ? rinfo.imageId : undefined,
        labels:
          rinfo.labels && typeof rinfo.labels === "object"
            ? (rinfo.labels as Record<string, string>)
            : undefined,
      }
    }

    const info = await deps.docker.getContainer(cid).inspect()
    const rawLabels = (info.Config as { Labels?: unknown } | undefined)?.Labels
    return {
      state: info.State?.Running ? "running" : "stopped",
      runtimeInspection: readDockerRuntimeInspection(info, cid),
      image: info.Config?.Image,
      imageId:
        typeof (info as { Image?: unknown }).Image === "string"
          ? (info as { Image: string }).Image
          : undefined,
      labels:
        rawLabels && typeof rawLabels === "object"
          ? (rawLabels as Record<string, string>)
          : undefined,
    }
  } catch (err) {
    if (isNotFound(err)) return { state: "missing" }
    throw wrapDockerError(err)
  }
}

export async function getV3ContainerStatus(
  deps: V3SupervisorDeps,
  uid: number,
): Promise<V3ContainerStatus | null> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`)
  }
  const r = await deps.pool.query<{
    id: string
    user_id: string
    bound_ip: string
    port: number
    container_internal_id: string | null
    host_uuid: string | null
    created_at: Date
    last_ws_activity: Date | null
  }>(
    `SELECT id, user_id, host(bound_ip) AS bound_ip, port, container_internal_id, host_uuid,
            created_at, last_ws_activity
       FROM agent_containers
      WHERE user_id = $1::bigint AND state='active' AND runtime_channel = $2::text
        AND runtime_kind = 'docker'
        AND NOT EXISTS (
          SELECT 1 FROM agent_migrations m
           WHERE m.agent_container_id = agent_containers.id
             AND m.phase NOT IN ('committed', 'rolled_back')
        )
      LIMIT 1`,
    [String(uid), getRuntimeChannel()],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0]!
  if (!row.container_internal_id) {
    const ageMs = Date.now() - new Date(row.created_at).getTime()
    return {
      containerId: Number.parseInt(row.id, 10),
      userId: Number.parseInt(row.user_id, 10),
      boundIp: row.bound_ip,
      port: row.port ?? V3_CONTAINER_PORT,
      dockerContainerId: "",
      state: ageMs < PROVISION_INFLIGHT_GRACE_MS ? "provisioning" : "missing",
      hostId: row.host_uuid,
      lastWsActivity: row.last_ws_activity,
    }
  }

  const inspected = await inspectActiveContainerFields(
    deps,
    row.host_uuid,
    row.container_internal_id,
  )
  return {
    containerId: Number.parseInt(row.id, 10),
    userId: Number.parseInt(row.user_id, 10),
    boundIp: row.bound_ip,
    port: row.port ?? V3_CONTAINER_PORT,
    dockerContainerId: row.container_internal_id,
    state: inspected.state,
    hostId: row.host_uuid,
    lastWsActivity: row.last_ws_activity,
    ...(inspected.runtimeInspection ? { runtimeInspection: inspected.runtimeInspection } : {}),
    ...(inspected.image ? { image: inspected.image } : {}),
    ...(inspected.imageId ? { imageId: inspected.imageId } : {}),
    ...(inspected.labels ? { labels: inspected.labels } : {}),
  }
}
