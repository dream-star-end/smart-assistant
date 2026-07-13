#!/usr/bin/env node

import Docker from "dockerode";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import {
  runModelAuthorityContainerRollback,
  type ModelAuthorityRollbackTarget,
} from "../packages/commercial/src/agent-sandbox/modelAuthorityRollback.js";
import {
  PROVISION_INFLIGHT_GRACE_MS,
  V3_CONTAINER_PORT,
  V3_MANAGED_LABEL_KEY,
  V3_UID_LABEL_KEY,
  stopAndRemoveV3Container,
  type V3ContainerStatus,
  type V3SupervisorDeps,
} from "../packages/commercial/src/agent-sandbox/v3supervisor.js";
import { requestRuntimeRecycleDrain } from "../packages/commercial/src/agent-sandbox/v3ensureRunning.js";
import { loadOrCreateBridgeSecret } from "../packages/commercial/src/bridgeSecret.js";
import {
  RUNTIME_CHANNEL_LABEL_KEY,
} from "../packages/commercial/src/compute-pool/containerService.js";
import { getSelfHost } from "../packages/commercial/src/compute-pool/queries.js";
import { closePool, getPool } from "../packages/commercial/src/db/index.js";

interface ActiveRow {
  id: string;
  user_id: string;
  bound_ip: string;
  port: number | null;
  container_internal_id: string | null;
  host_uuid: string | null;
  created_at: Date;
  last_ws_activity: Date | null;
}

interface KnownDocker {
  kind: "known";
  dockerId: string;
  env: readonly string[];
  labels: Readonly<Record<string, string>>;
  running: boolean;
  boundIp: string | null;
}

type DockerObservation = KnownDocker | { kind: "missing" } | { kind: "unknown" };
const V5_NETWORK_NAME = "openclaude-v5-net";

interface ClassifiedTarget extends ModelAuthorityRollbackTarget {
  row?: ActiveRow;
  status?: V3ContainerStatus;
  dockerId?: string;
  cleanupMode: "db" | "docker" | "none";
}

function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  return e?.statusCode === 404 || e?.status === 404;
}

function isNotModified(err: unknown): boolean {
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  return e?.statusCode === 304 || e?.status === 304;
}

function exactEnvValue(env: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  const values = env.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
  return values.length === 1 ? values[0]! : null;
}

/**
 * Docker inspect 的安全归一化边界。缺 Env / Running / ownership label 均为 unknown，
 * 绝不把「看不清」降级成 unflagged/stopped 后删除。
 */
export function classifyDockerInspect(
  requestedId: string,
  info: {
    Id?: string;
    Config?: { Env?: string[] | null; Labels?: Record<string, string> | null } | null;
    State?: { Running?: boolean } | null;
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string } | null> | null } | null;
  },
): DockerObservation {
  if (
    !info.Config
    || !Array.isArray(info.Config.Env)
    || !info.Config.Env.every((entry) => typeof entry === "string")
    || !info.State
    || typeof info.State.Running !== "boolean"
    || !info.Config.Labels
    || typeof info.Config.Labels !== "object"
  ) {
    return { kind: "unknown" };
  }
  const labels = info.Config.Labels;
  if (
    labels[V3_MANAGED_LABEL_KEY] !== "1"
    || labels[RUNTIME_CHANNEL_LABEL_KEY] !== "v5"
  ) {
    return { kind: "unknown" };
  }
  const network = info.NetworkSettings?.Networks?.[V5_NETWORK_NAME];
  const boundIp = typeof network?.IPAddress === "string" && network.IPAddress !== ""
    ? network.IPAddress
    : null;
  return {
    kind: "known",
    dockerId: typeof info.Id === "string" && info.Id !== "" ? info.Id : requestedId,
    env: info.Config.Env,
    labels,
    running: info.State.Running,
    boundIp,
  };
}

/** Docker-only target stays visible after its DB row has already become vanished. */
export function classifyDockerOrphan(observation: KnownDocker): ClassifiedTarget {
  const id = `docker:${observation.dockerId}`;
  const flagged = observation.env.some((entry) => entry === "OC_MODEL_AUTHORITY=1");
  if (!flagged) return { id, state: "unflagged", dockerId: observation.dockerId, cleanupMode: "none" };
  if (!observation.running) {
    return {
      id,
      state: "flagged_stopped",
      dockerId: observation.dockerId,
      cleanupMode: "docker",
    };
  }

  const rawContainerId = exactEnvValue(observation.env, "OC_CONTAINER_ID");
  const rawAuthorityUserId = exactEnvValue(observation.env, "OC_USER_ID");
  const rawUserId = observation.labels[V3_UID_LABEL_KEY] ?? null;
  const containerId = rawContainerId && /^\d+$/.test(rawContainerId)
    ? Number.parseInt(rawContainerId, 10)
    : 0;
  const userId = rawUserId && /^\d+$/.test(rawUserId) ? Number.parseInt(rawUserId, 10) : 0;
  if (
    !Number.isSafeInteger(containerId)
    || containerId <= 0
    || !Number.isSafeInteger(userId)
    || userId <= 0
    || rawAuthorityUserId !== rawUserId
    || observation.boundIp === null
  ) {
    return { id, state: "unknown", dockerId: observation.dockerId, cleanupMode: "none" };
  }
  return {
    id,
    state: "flagged_running",
    dockerId: observation.dockerId,
    cleanupMode: "docker",
    status: {
      containerId,
      userId,
      boundIp: observation.boundIp,
      port: V3_CONTAINER_PORT,
      dockerContainerId: observation.dockerId,
      state: "running",
      hostId: null,
      lastWsActivity: null,
    },
  };
}

function parseTimeoutMs(argv: string[]): number {
  let seconds = 45 * 60;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--timeout-seconds") {
      const raw = argv[i + 1];
      if (!raw || !/^\d+$/.test(raw)) throw new Error("--timeout-seconds requires a positive integer");
      seconds = Number.parseInt(raw, 10);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("timeout must be positive");
  return seconds * 1_000;
}

async function removeDockerOrphan(docker: Docker, dockerId: string): Promise<void> {
  const handle = docker.getContainer(dockerId);
  try {
    await handle.stop({ t: 5 });
  } catch (err) {
    if (!isNotFound(err) && !isNotModified(err)) throw err;
  }
  try {
    await handle.remove({ force: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function main(): Promise<void> {
  if (process.env.OC_RUNTIME_CHANNEL !== "v5") {
    throw new Error("OC_RUNTIME_CHANNEL=v5 is required");
  }
  const image = process.env.OC_RUNTIME_IMAGE?.trim();
  if (!image) throw new Error("OC_RUNTIME_IMAGE is required");

  const timeoutMs = parseTimeoutMs(process.argv.slice(2));
  const pool = getPool();
  const docker = process.env.AGENT_DOCKER_SOCKET
    ? new Docker({ socketPath: process.env.AGENT_DOCKER_SOCKET })
    : new Docker();
  const selfHost = await getSelfHost();
  const supervisorDeps: V3SupervisorDeps = {
    docker,
    pool,
    image,
    bridgeSecret: loadOrCreateBridgeSecret(),
    selfHostId: selfHost.id,
  };
  const classified = new Map<number | string, ClassifiedTarget>();

  const result = await runModelAuthorityContainerRollback(
    {
      async scan() {
        classified.clear();
        const query = await pool.query<ActiveRow>(
          `SELECT id, user_id, host(bound_ip) AS bound_ip, port, container_internal_id,
                  host_uuid, created_at, last_ws_activity
             FROM agent_containers
            WHERE state='active' AND runtime_channel='v5'
            ORDER BY id ASC`,
        );

        // DB-first cleanup 会先把 row 翻 vanished，再尝试 Docker remove。故 census 必须
        // 同时从 Docker all=true 反向枚举 managed v5 容器，不能只跟 active DB 行走。
        const listed = await docker.listContainers({
          all: true,
          filters: {
            label: [
              `${V3_MANAGED_LABEL_KEY}=1`,
              `${RUNTIME_CHANNEL_LABEL_KEY}=v5`,
            ],
          },
        });
        const listedIds = new Set<string>();
        let listedShapeUnknown = false;
        for (const item of listed) {
          const labels = item.Labels ?? {};
          if (
            typeof item.Id === "string"
            && item.Id !== ""
            && labels[V3_MANAGED_LABEL_KEY] === "1"
            && labels[RUNTIME_CHANNEL_LABEL_KEY] === "v5"
          ) {
            listedIds.add(item.Id);
          } else {
            // daemon filter 命中却不给可验证 ownership/ID，不能静默从 census 消失。
            listedShapeUnknown = true;
          }
        }

        const inspectIds = new Set(listedIds);
        for (const row of query.rows) {
          if (
            row.container_internal_id
            && (row.host_uuid === null || row.host_uuid === selfHost.id)
          ) {
            inspectIds.add(row.container_internal_id);
          }
        }
        const observations = new Map<string, DockerObservation>();
        for (const dockerId of inspectIds) {
          try {
            const info = await docker.getContainer(dockerId).inspect();
            observations.set(dockerId, classifyDockerInspect(dockerId, info));
          } catch (err) {
            observations.set(dockerId, isNotFound(err) ? { kind: "missing" } : { kind: "unknown" });
          }
        }

        const activeCids = new Set<string>();
        for (const row of query.rows) {
          const id = Number.parseInt(row.id, 10);
          let target: ClassifiedTarget;
          if (!row.container_internal_id) {
            const ageMs = Date.now() - new Date(row.created_at).getTime();
            target = {
              id,
              state: ageMs < PROVISION_INFLIGHT_GRACE_MS ? "provisioning" : "missing",
              row,
              cleanupMode: ageMs < PROVISION_INFLIGHT_GRACE_MS ? "none" : "db",
            };
          } else if (row.host_uuid !== null && row.host_uuid !== selfHost.id) {
            target = { id, state: "unknown", row, cleanupMode: "none" };
          } else {
            activeCids.add(row.container_internal_id);
            const observation = observations.get(row.container_internal_id) ?? { kind: "unknown" };
            if (observation.kind === "missing") {
              target = { id, state: "missing", row, cleanupMode: "db" };
            } else if (observation.kind === "unknown") {
              target = { id, state: "unknown", row, cleanupMode: "none" };
            } else {
              const flagged = observation.env.some((entry) => entry === "OC_MODEL_AUTHORITY=1");
              const identityMatches = exactEnvValue(observation.env, "OC_CONTAINER_ID") === row.id
                && exactEnvValue(observation.env, "OC_USER_ID") === row.user_id;
              if (flagged && observation.running && !identityMatches) {
                target = { id, state: "unknown", row, cleanupMode: "none" };
              } else {
                const status: V3ContainerStatus = {
                  containerId: id,
                  userId: Number.parseInt(row.user_id, 10),
                  boundIp: row.bound_ip,
                  port: row.port ?? V3_CONTAINER_PORT,
                  dockerContainerId: row.container_internal_id,
                  state: observation.running ? "running" : "stopped",
                  hostId: row.host_uuid,
                  lastWsActivity: row.last_ws_activity,
                };
                target = {
                  id,
                  state: flagged
                    ? (observation.running ? "flagged_running" : "flagged_stopped")
                    : "unflagged",
                  row,
                  status,
                  cleanupMode: flagged ? "db" : "none",
                };
              }
            }
          }
          classified.set(target.id, target);
        }

        // Docker-only orphans remain first-class census members. A failed DB-first cleanup can no
        // longer disappear from the next scan and falsely start the quiet window.
        for (const dockerId of listedIds) {
          if (activeCids.has(dockerId)) continue;
          const observation = observations.get(dockerId);
          const target = observation?.kind === "known"
            ? classifyDockerOrphan(observation)
            : observation?.kind === "unknown"
              ? {
                  id: `docker:${dockerId}`,
                  state: "unknown" as const,
                  dockerId,
                  cleanupMode: "none" as const,
                }
              : null;
          if (target) classified.set(target.id, target);
        }
        if (listedShapeUnknown) {
          classified.set("docker:list-shape-unknown", {
            id: "docker:list-shape-unknown",
            state: "unknown",
            cleanupMode: "none",
          });
        }
        return [...classified.values()];
      },
      async drain(target) {
        const current = classified.get(target.id);
        if (!current?.status || current.state !== "flagged_running") return "failed";
        return requestRuntimeRecycleDrain(supervisorDeps, current.status);
      },
      async cleanup(target) {
        const current = classified.get(target.id);
        if (!current) throw new Error(`container ${String(target.id)} disappeared from current scan`);
        if (current.cleanupMode === "docker" && current.dockerId) {
          await removeDockerOrphan(docker, current.dockerId);
          return;
        }
        if (current.cleanupMode === "db" && current.row) {
          await stopAndRemoveV3Container(supervisorDeps, {
            id: Number.parseInt(current.row.id, 10),
            container_internal_id: current.row.container_internal_id,
            host_uuid: current.row.host_uuid,
          });
          return;
        }
        throw new Error(`container ${String(target.id)} is not safely removable`);
      },
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.log(message),
    },
    { timeoutMs, quietMs: 20_000, pollMs: 1_000 },
  );
  console.log(
    `[model-authority-rollback] converged after ${Math.round(result.elapsedMs)}ms (${result.scans} scans)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(`[model-authority-rollback] FATAL: ${(err as Error)?.message ?? String(err)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => undefined);
    });
}
