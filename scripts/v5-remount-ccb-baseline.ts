#!/usr/bin/env node

/**
 * Gracefully converge running V5 user containers onto the mandatory CCB
 * baseline mounts.  The tool is intentionally idempotent and local-only:
 * it touches only active runtime_channel=v5 rows on the self compute host,
 * never forces an active turn, and preserves every named volume.
 */

import Docker from "dockerode";
import { readFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { PLATFORM_AUX_MODEL_IDS } from "../packages/commercial/src/billing/modelCatalog.js";
import {
  createContainerService,
  RUNTIME_CHANNEL_LABEL_KEY,
} from "../packages/commercial/src/compute-pool/containerService.js";
import { getSelfHost } from "../packages/commercial/src/compute-pool/queries.js";
import { closePool, getPool } from "../packages/commercial/src/db/index.js";
import {
  DEFAULT_PLATFORM_ROOT,
  DEFAULT_RUNTIME_RELEASES_ROOT,
  RUNTIME_BOOT_HASH_LABEL_KEY,
  RUNTIME_BUNDLE_REV_LABEL_KEY,
  RUNTIME_IMAGE_ID_LABEL_KEY,
  RUNTIME_RELEASE_LABEL_KEY,
  resolvePlatformBundleMount,
  resolveRuntimeReleaseMount,
} from "../packages/commercial/src/agent-sandbox/platformBundle.js";
import {
  getV3ContainerStatus,
  resolveCcbBaselineMounts,
  stopAndRemoveV3Container,
  V3_MANAGED_LABEL_KEY,
  V3_UID_LABEL_KEY,
  type V3RuntimeTuple,
  type V3SupervisorDeps,
} from "../packages/commercial/src/agent-sandbox/v3supervisor.js";
import {
  makeV3EnsureRunning,
  requestRuntimeRecycleDrain,
} from "../packages/commercial/src/agent-sandbox/v3ensureRunning.js";
import { DEFAULT_BRIDGE_SECRET_PATH } from "../packages/commercial/src/bridgeSecret.js";
import { AuthorityKeyringReader } from "../packages/commercial/src/ws/authoritySigner.js";
import {
  CCB_BASELINE_TARGETS,
  classifyBaselineMounts,
  type MountLike,
} from "./lib/v5BaselineMounts.js";

interface CliOptions {
  dryRun: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let timeoutSeconds = 45 * 60;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--timeout-seconds") {
      const raw = argv[i + 1];
      if (!raw || !/^\d+$/.test(raw)) {
        throw new Error("--timeout-seconds requires a positive integer");
      }
      timeoutSeconds = Number.parseInt(raw, 10);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("timeout must be a positive integer");
  }
  return { dryRun, timeoutMs: timeoutSeconds * 1_000 };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnabled(raw: string | undefined): boolean {
  return ["1", "true", "yes"].includes(raw?.trim().toLowerCase() ?? "");
}

export function loadBridgeSecretReadOnly(path = DEFAULT_BRIDGE_SECRET_PATH): string {
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("bridge secret is missing or malformed; remount refuses to rotate it");
  }
  return value;
}

function uidNumber(uid: bigint): number {
  if (uid <= 0n || uid > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("active V5 container has an invalid user id");
  }
  return Number(uid);
}

function buildRuntimeTuple(): V3RuntimeTuple | undefined {
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim();
  const bundlePath = process.env.OC_PLATFORM_BUNDLE?.trim();
  const releasePath = process.env.OC_RUNTIME_RELEASE?.trim();
  if (!imageId && !bundlePath && !releasePath) return undefined;

  const platformRoot = process.env.OC_PLATFORM_ROOT?.trim() || DEFAULT_PLATFORM_ROOT;
  const releasesRoot = process.env.OC_RUNTIME_RELEASES_ROOT?.trim() || DEFAULT_RUNTIME_RELEASES_ROOT;
  const tuple: V3RuntimeTuple = {
    imageId,
    bundlePath,
    releasePath,
    platformRoot,
    releasesRoot,
  };
  if (bundlePath) {
    const resolved = resolvePlatformBundleMount(bundlePath, {
      ancestorRoot: platformRoot,
      platformRoot,
    });
    tuple.bundleResolvedPath = resolved.resolvedPath;
    tuple.bundleRev = resolved.bundleRev;
    tuple.bootHash = resolved.bootHash;
  }
  if (releasePath) {
    tuple.releaseResolvedPath = resolveRuntimeReleaseMount(releasePath, releasesRoot);
  }
  return tuple;
}

function expectedRuntimeLabels(tuple: V3RuntimeTuple | undefined): Record<string, string> {
  const expected: Record<string, string> = {};
  if (tuple?.imageId) expected[RUNTIME_IMAGE_ID_LABEL_KEY] = tuple.imageId;
  if (tuple?.releasePath) {
    expected[RUNTIME_RELEASE_LABEL_KEY] = tuple.releasePath.replace(/\/+$/, "").split("/").pop()!;
  }
  if (tuple?.bundlePath) {
    expected[RUNTIME_BUNDLE_REV_LABEL_KEY] = tuple.bundleRev ?? "";
    expected[RUNTIME_BOOT_HASH_LABEL_KEY] = tuple.bootHash ?? "";
  }
  return expected;
}

export function namedVolumes(mounts: readonly MountLike[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const mount of mounts ?? []) {
    if (mount.Type === "volume" && mount.Destination && mount.Name) {
      out.set(mount.Destination, mount.Name);
    }
  }
  return out;
}

export function assertNamedVolumesPreserved(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): void {
  for (const [destination, name] of before) {
    if (after.get(destination) !== name) {
      throw new Error(`named volume changed at ${destination}`);
    }
  }
}

export function assertContainerLabels(
  labels: Readonly<Record<string, string>> | null | undefined,
  uid: bigint,
  runtimeLabels: Readonly<Record<string, string>>,
): void {
  const expected: Record<string, string> = {
    [V3_MANAGED_LABEL_KEY]: "1",
    [V3_UID_LABEL_KEY]: String(uid),
    [RUNTIME_CHANNEL_LABEL_KEY]: "v5",
    ...runtimeLabels,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (labels?.[key] !== value) {
      throw new Error(`container label mismatch after reprovision: ${key}`);
    }
  }
}

export async function verifyPlatformCliLinks(
  container: Pick<Docker.Container, "exec">,
): Promise<void> {
  const command = [
    "set -eu",
    "for name in oc-plugin oc-ocr oc-h3 oc-video oc-cursor; do",
    '  link="/home/agent/.local/bin/$name"',
    '  source="/run/oc/platform/current/bin/$name"',
    '  test -L "$link"',
    '  test "$(readlink "$link")" = "$source"',
    '  test -x "$source"',
    "done",
  ].join("\n");
  const runner = await container.exec({
    Cmd: ["/bin/sh", "-lc", command],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await runner.start({ Detach: false, Tty: false });
  stream.resume();
  await finished(stream);
  const result = await runner.inspect();
  if (result.ExitCode !== 0) {
    throw new Error("reprovisioned container platform CLI PATH links are incomplete");
  }
}

type ContainerStatus = NonNullable<Awaited<ReturnType<typeof getV3ContainerStatus>>>;
export interface SafeRemovalTarget {
  status: ContainerStatus;
  beforeVolumes: Map<string, string>;
}

export interface AcquireSafeRemovalOps {
  getStatus: () => Promise<Awaited<ReturnType<typeof getV3ContainerStatus>>>;
  inspect: (dockerId: string) => Promise<{
    Mounts?: readonly MountLike[];
    Config?: { Labels?: Record<string, string> | null } | null;
  }>;
  requestDrain: (status: ContainerStatus) => Promise<Awaited<ReturnType<typeof requestRuntimeRecycleDrain>>>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function hasExpectedRuntimeLabels(
  labels: Readonly<Record<string, string>> | null | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([key, value]) => labels?.[key] === value);
}

export async function acquireSafeRemovalTarget(
  deps: V3SupervisorDeps,
  docker: Docker,
  uid: bigint,
  expectedSources: Readonly<Record<string, string>>,
  expectedRuntimeLabels: Readonly<Record<string, string>>,
  deadlineMs: number,
  ops: AcquireSafeRemovalOps = {
    getStatus: () => getV3ContainerStatus(deps, uidNumber(uid)),
    inspect: (dockerId) => inspectContainer(docker, dockerId),
    requestDrain: (status) => requestRuntimeRecycleDrain(deps, status),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<SafeRemovalTarget | null> {
  for (;;) {
    if (ops.now() >= deadlineMs) {
      throw new Error("global remount timeout reached");
    }
    const status = await ops.getStatus();
    if (!status || status.state === "provisioning") {
      if (ops.now() >= deadlineMs) {
        throw new Error("container census did not settle before the deadline");
      }
      await ops.sleep(5_000);
      continue;
    }
    if (typeof deps.selfHostId === "string") {
      assertLocalCensusHost(status.hostId, deps.selfHostId);
    }
    if (status.state === "missing") {
      return { status, beforeVolumes: new Map() };
    }

    // Re-inspect immediately before every drain attempt.  The initial census
    // may be minutes old by the time a later container is processed; using
    // its row/docker id after an independent recycle would be both noisy and
    // unnecessary.  A container already converged by another actor is a clean
    // idempotent skip and is never put into the temporary drain gate.
    const info = await ops.inspect(status.dockerContainerId);
    const classification = classifyBaselineMounts(info.Mounts, expectedSources);
    if (classification.complete && hasExpectedRuntimeLabels(info.Config?.Labels, expectedRuntimeLabels)) {
      return null;
    }
    const beforeVolumes = namedVolumes(info.Mounts);
    if (status.state !== "running") return { status, beforeVolumes };

    if (ops.now() >= deadlineMs) {
      throw new Error("global remount timeout reached");
    }
    const result = await ops.requestDrain(status);
    if (result === "accepted") return { status, beforeVolumes };
    if (ops.now() >= deadlineMs) {
      throw new Error(`authenticated drain did not converge (${result})`);
    }
    await ops.sleep(5_000);
  }
}

export interface RemountExecutionOps {
  acquire: (uid: bigint, deadlineMs: number) => Promise<SafeRemovalTarget | null>;
  remove: (target: SafeRemovalTarget) => Promise<boolean>;
  ensure: (uid: bigint) => Promise<void>;
  verify: (uid: bigint, target: SafeRemovalTarget) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  progress: (completed: number, total: number) => void;
}

export function assertLocalCensusHost(hostUuid: string | null, selfHostId: string): void {
  // In multi-host mode stopAndRemoveV3Container treats a null host as
  // "vanished" after changing DB state and skips Docker cleanup. Remount must
  // never enter that path: both legacy/null and foreign ownership are unsafe.
  if (hostUuid !== selfHostId) {
    throw new Error("V5 local-only census found an active container without exact local host ownership");
  }
}

export async function remountTargets(
  targets: readonly bigint[],
  deadlineMs: number,
  ops: RemountExecutionOps,
): Promise<number> {
  let remounted = 0;
  for (const uid of targets) {
    if (ops.now() >= deadlineMs) throw new Error("global remount timeout reached");
    const target = await ops.acquire(uid, deadlineMs);
    if (!target) continue;
    if (ops.now() >= deadlineMs) throw new Error("global remount timeout reached");
    if (!await ops.remove(target)) {
      throw new Error("container became ineligible for safe removal");
    }

    let ensured = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await ops.ensure(uid);
        ensured = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await ops.sleep(3_000);
      }
    }
    if (!ensured) {
      throw lastError instanceof Error ? lastError : new Error("reprovision failed");
    }

    await ops.verify(uid, target);
    remounted += 1;
    ops.progress(remounted, targets.length);
  }
  return remounted;
}

async function inspectContainer(docker: Docker, dockerId: string) {
  return docker.getContainer(dockerId).inspect();
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun && process.env.OC_V5_DEPLOY_LOCK_HELD !== "1") {
    throw new Error("destructive remount must run through deploy-v5.sh --remount-ccb-baseline");
  }
  if (process.env.OC_RUNTIME_CHANNEL !== "v5") {
    throw new Error("OC_RUNTIME_CHANNEL=v5 is required");
  }
  if (optionalEnabled(process.env.OC_V3_CCB_BASELINE_OPTIONAL)) {
    throw new Error("OC_V3_CCB_BASELINE_OPTIONAL must be absent/false");
  }

  const baselineDir = requiredEnv("OC_V3_CCB_BASELINE_DIR");
  const baseline = resolveCcbBaselineMounts(baselineDir);
  if (!baseline) throw new Error(`baseline failed strict validation: ${baselineDir}`);
  const expectedSources: Record<string, string> = {
    [CCB_BASELINE_TARGETS[0]]: baseline.agentsMdHostPath,
    [CCB_BASELINE_TARGETS[1]]: baseline.claudeMdHostPath,
    [CCB_BASELINE_TARGETS[2]]: baseline.skillsDirHostPath,
  };

  const pool = getPool();
  const deployState = await pool.query<{
    phase: string;
    active_slot: string;
    candidate_slot: string | null;
  }>(
    `SELECT phase, active_slot, candidate_slot
       FROM deploy_state
      WHERE singleton=true`,
  );
  const state = deployState.rows[0];
  if (
    deployState.rowCount !== 1
    || !state
    || state.phase !== "stable"
    || state.candidate_slot !== null
    || (state.active_slot !== "A" && state.active_slot !== "B")
  ) {
    throw new Error("deploy_state must be stable with exactly one active slot");
  }
  const activeSlotBaseline = state.active_slot === "A"
    ? "/opt/openclaude/openclaude-v5/packages/commercial/agent-sandbox/ccb-baseline"
    : "/opt/openclaude/openclaude-v5-b/packages/commercial/agent-sandbox/ccb-baseline";
  if (baselineDir.replace(/\/+$/, "") !== activeSlotBaseline) {
    throw new Error("OC_V3_CCB_BASELINE_DIR does not belong to the active V5 slot");
  }

  const docker = process.env.AGENT_DOCKER_SOCKET
    ? new Docker({ socketPath: process.env.AGENT_DOCKER_SOCKET })
    : new Docker();
  const selfHost = await getSelfHost();
  const runtimeTuple = buildRuntimeTuple();
  const keyringReader = process.env.OC_MODEL_AUTHORITY === "1"
    ? AuthorityKeyringReader.open()
    : undefined;
  if (keyringReader && keyringReader.keyIds().length === 0) {
    throw new Error("model-authority public keyring is empty");
  }
  const deps: V3SupervisorDeps = {
    docker,
    pool,
    image: requiredEnv("OC_RUNTIME_IMAGE"),
    bridgeSecret: loadBridgeSecretReadOnly(),
    ccbBaselineDir: baselineDir,
    selfHostId: selfHost.id,
    containerService: createContainerService(docker),
    ...(runtimeTuple ? { runtimeTuple } : {}),
    ...(keyringReader
      ? {
          modelAuthority: {
            keyringEnvAssignment: () => keyringReader.publicKeyringEnvAssignment(),
            required: process.env.OC_MODEL_AUTHORITY_PROVISION_REQUIRED !== "0",
            auxModels: PLATFORM_AUX_MODEL_IDS,
          },
        }
      : {}),
  };
  const ensureRunning = makeV3EnsureRunning(deps);
  const runtimeLabels = expectedRuntimeLabels(runtimeTuple);
  const deadlineMs = Date.now() + options.timeoutMs;

  const rows = await pool.query<{ user_id: string; host_uuid: string | null }>(
    `SELECT user_id, host_uuid
       FROM agent_containers
      WHERE state='active' AND runtime_channel='v5'
      ORDER BY id ASC`,
  );
  for (const row of rows.rows) {
    assertLocalCensusHost(row.host_uuid, selfHost.id);
  }

  const targets: bigint[] = [];
  for (const row of rows.rows) {
    const uid = BigInt(row.user_id);
    const status = await getV3ContainerStatus(deps, uidNumber(uid));
    if (!status || status.state === "provisioning") {
      throw new Error("container census changed while classifying baseline mounts");
    }
    assertLocalCensusHost(status.hostId, selfHost.id);
    if (status.state === "missing") {
      targets.push(uid);
      continue;
    }
    const info = await inspectContainer(docker, status.dockerContainerId);
    const classification = classifyBaselineMounts(info.Mounts, expectedSources);
    if (!classification.complete || !hasExpectedRuntimeLabels(info.Config?.Labels, runtimeLabels)) {
      targets.push(uid);
    }
  }

  console.log(JSON.stringify({ phase: "census", active: rows.rowCount ?? rows.rows.length, targets: targets.length, dryRun: options.dryRun }));
  if (options.dryRun) return;

  const remounted = await remountTargets(targets, deadlineMs, {
    acquire: async (uid, deadline) => {
      const target = await acquireSafeRemovalTarget(
        deps,
        docker,
        uid,
        expectedSources,
        runtimeLabels,
        deadline,
      );
      if (target) assertLocalCensusHost(target.status.hostId, selfHost.id);
      return target;
    },
    remove: (target) => stopAndRemoveV3Container(
      deps,
      {
        id: target.status.containerId,
        container_internal_id: target.status.dockerContainerId,
        host_uuid: target.status.hostId,
      },
      5,
      { requireNoOpenMigration: true },
    ),
    ensure: async (uid) => {
      await ensureRunning(uid);
    },
    verify: async (uid, target) => {
      const newStatus = await getV3ContainerStatus(deps, uidNumber(uid));
      if (!newStatus || newStatus.state !== "running") {
        throw new Error("reprovisioned container is not running");
      }
      assertLocalCensusHost(newStatus.hostId, selfHost.id);
      const info = await inspectContainer(docker, newStatus.dockerContainerId);
      const classification = classifyBaselineMounts(info.Mounts, expectedSources);
      if (!classification.complete) {
        throw new Error("reprovisioned container still lacks mandatory baseline mounts");
      }
      assertNamedVolumesPreserved(target.beforeVolumes, namedVolumes(info.Mounts));
      assertContainerLabels(info.Config.Labels, uid, runtimeLabels);
      await verifyPlatformCliLinks(docker.getContainer(newStatus.dockerContainerId));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    progress: (completed, total) => {
      console.log(JSON.stringify({ phase: "remounted", completed, total }));
    },
  });

  console.log(JSON.stringify({ phase: "complete", remounted, targets: targets.length }));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => undefined);
    });
}
