/** One-shot, uid3-only selfhost runtime convergence through the production
 * V5 ensureRunning stale-release + authenticated turn-drain path. No raw
 * docker rm, no force flag, no model call, no migration. Busy -> exit 3. */
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import Docker from "dockerode";
import { PLATFORM_AUX_MODEL_IDS } from
  "../../packages/commercial/src/billing/modelCatalog.js";
import { createContainerService } from
  "../../packages/commercial/src/compute-pool/containerService.js";
import { getSelfHost } from
  "../../packages/commercial/src/compute-pool/queries.js";
import { getPool, closePool } from
  "../../packages/commercial/src/db/index.js";
import { makeV3EnsureRunning } from
  "../../packages/commercial/src/agent-sandbox/v3ensureRunning.js";
import { getV3ContainerStatus,
  resolveCcbBaselineMounts, type V3RuntimeTuple, type V3SupervisorDeps } from
  "../../packages/commercial/src/agent-sandbox/v3supervisor.js";
import { DEFAULT_PLATFORM_ROOT, DEFAULT_RUNTIME_RELEASES_ROOT,
  resolvePlatformBundleMount, resolveRuntimeReleaseMount } from
  "../../packages/commercial/src/agent-sandbox/platformBundle.js";
import { DEFAULT_BRIDGE_SECRET_PATH } from
  "../../packages/commercial/src/bridgeSecret.js";
import { AuthorityKeyringReader } from
  "../../packages/commercial/src/ws/authoritySigner.js";
import { getRuntimeChannel } from
  "../../packages/commercial/src/runtimeChannel.js";

const UID = 3n;
const LIVE = "/opt/openclaude/openclaude-v5-selfhost-live";
const RELEASE_LABEL = "com.openclaude.runtime.release";
function assertion(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function tuple(): V3RuntimeTuple {
  const imageId = process.env.OC_RUNTIME_IMAGE_ID?.trim();
  const bundlePath = process.env.OC_PLATFORM_BUNDLE?.trim();
  const releasePath = process.env.OC_RUNTIME_RELEASE?.trim();
  assertion(!!imageId && /^sha256:[a-f0-9]{64}$/.test(imageId)
    && !!bundlePath && !!releasePath, "BOX_RUNTIME_TUPLE_INVALID");
  const platformRoot = process.env.OC_PLATFORM_ROOT?.trim() || DEFAULT_PLATFORM_ROOT;
  const releasesRoot = process.env.OC_RUNTIME_RELEASES_ROOT?.trim()
    || DEFAULT_RUNTIME_RELEASES_ROOT;
  const bundle = resolvePlatformBundleMount(bundlePath, {
    ancestorRoot: platformRoot, platformRoot });
  const releaseResolvedPath = resolveRuntimeReleaseMount(releasePath, releasesRoot);
  return { imageId, bundlePath, releasePath, platformRoot, releasesRoot,
    bundleResolvedPath: bundle.resolvedPath, bundleRev: bundle.bundleRev,
    bootHash: bundle.bootHash, releaseResolvedPath };
}
function namedVolumes(info: Awaited<ReturnType<Docker.Container["inspect"]>>): Map<string, string> {
  return new Map((info.Mounts ?? []).filter((m) => m.Type === "volume"
    && typeof m.Name === "string" && typeof m.Destination === "string")
    .map((m) => [m.Destination!, m.Name!]));
}
function sameVolumes(before: Map<string, string>, after: Map<string, string>): boolean {
  return [...before].every(([path, name]) => after.get(path) === name);
}
async function main(): Promise<number> {
  const mode = process.argv[2] ?? "plan";
  assertion(mode === "plan" || mode === "run", "BOX_RUNTIME_MODE_INVALID");
  assertion(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OCV5_289_ACK_UID === "3",
  "BOX_RUNTIME_SELFHOST_BOUNDARY_INVALID");
  if (mode === "run") assertion(process.env.OCV5_289_RUNTIME_REFRESH_ACK === "1"
    && process.env.OC_V5_FORCE_STALE_IMAGE_RECYCLE !== "1",
  "BOX_RUNTIME_FORCE_FORBIDDEN");
  const expected = process.env.OCV5_289_EXPECT_LIVE_SHA ?? "";
  assertion(/^[a-f0-9]{40}$/.test(expected), "BOX_RUNTIME_SHA_ACK_REQUIRED");
  const live = realpathSync(LIVE);
  assertion(live.startsWith("/opt/openclaude/openclaude-v5-selfhost-releases/rel-")
    && (JSON.parse(readFileSync(`${live}/.complete`, "utf8")) as
      { sourceCommit?: unknown }).sourceCommit === expected,
  "BOX_RUNTIME_LIVE_SOURCE_INVALID");
  const url = new URL(process.env.DATABASE_URL ?? "");
  assertion(["postgres:", "postgresql:"].includes(url.protocol)
    && url.hostname === "127.0.0.1" && url.port === "5432"
    && url.pathname === "/openclaude_v5_selfhost" && url.search === "",
  "BOX_RUNTIME_DATABASE_ENDPOINT_INVALID");
  const baselineDir = process.env.OC_V3_CCB_BASELINE_DIR?.trim()
    || `${live}/packages/commercial/agent-sandbox/ccb-baseline`;
  assertion(realpathSync(baselineDir)
    === realpathSync(`${live}/packages/commercial/agent-sandbox/ccb-baseline`),
  "BOX_RUNTIME_BASELINE_PATH_INVALID");
  assertion(!!resolveCcbBaselineMounts(baselineDir), "BOX_RUNTIME_BASELINE_NOT_READY");
  const secret = readFileSync(DEFAULT_BRIDGE_SECRET_PATH, "utf8").trim();
  assertion(/^[a-f0-9]{64}$/.test(secret), "BOX_RUNTIME_BRIDGE_SECRET_INVALID");
  const desired = tuple();
  const desiredRelease = basename(desired.releasePath!);
  const pool = getPool();
  try {
    const db = await pool.query<{ name: string }>("SELECT current_database() AS name");
    assertion(db.rows[0]?.name === "openclaude_v5_selfhost", "BOX_RUNTIME_DATABASE_INVALID");
    const docker = new Docker();
    const host = await getSelfHost();
    const keyring = process.env.OC_MODEL_AUTHORITY === "1"
      ? AuthorityKeyringReader.open() : null;
    assertion(!keyring || keyring.keyIds().length > 0,
      "BOX_RUNTIME_KEYRING_EMPTY");
    const deps: V3SupervisorDeps = { docker, pool,
      image: process.env.OC_RUNTIME_IMAGE ?? "",
      bridgeSecret: secret, ccbBaselineDir: baselineDir,
      selfHostId: host.id, containerService: createContainerService(docker),
      runtimeTuple: desired,
      ...(keyring ? { modelAuthority: {
        keyringEnvAssignment: () => keyring.publicKeyringEnvAssignment(),
        required: process.env.OC_MODEL_AUTHORITY_PROVISION_REQUIRED !== "0",
        auxModels: PLATFORM_AUX_MODEL_IDS,
      } } : {}) };
    assertion(deps.image.startsWith("openclaude/openclaude-runtime:"),
      "BOX_RUNTIME_IMAGE_INVALID");
    const before = await getV3ContainerStatus(deps, Number(UID));
    assertion(before?.state === "running" && before.hostId === host.id
      && typeof before.dockerContainerId === "string",
    "BOX_RUNTIME_CONTAINER_NOT_LOCAL_RUNNING");
    const beforeInfo = await docker.getContainer(before.dockerContainerId).inspect();
    const beforeVolumes = namedVolumes(beforeInfo);
    assertion(beforeVolumes.get("/home/agent/.openclaude") !== undefined,
      "BOX_RUNTIME_PERSISTENT_VOLUME_MISSING");
    if (mode === "run" && before.labels?.[RELEASE_LABEL] !== desiredRelease) {
      // The production function performs the authenticated v5 turn-drain and
      // defers rather than removing if ingress/session/durable fences are busy.
      await makeV3EnsureRunning(deps)(UID);
    }
    const after = await getV3ContainerStatus(deps, Number(UID));
    assertion(after?.state === "running" && after.hostId === host.id
      && typeof after.dockerContainerId === "string",
    "BOX_RUNTIME_AFTER_STATUS_INVALID");
    const fresh = after.labels?.[RELEASE_LABEL] === desiredRelease;
    if (mode === "run" && fresh) {
      const afterInfo = await docker.getContainer(after.dockerContainerId).inspect();
      assertion(sameVolumes(beforeVolumes, namedVolumes(afterInfo)),
        "BOX_RUNTIME_VOLUME_CHANGED");
    }
    process.stdout.write(JSON.stringify({ mode, uid: String(UID),
      beforeRelease: before.labels?.[RELEASE_LABEL] ?? null,
      desiredRelease, afterRelease: after.labels?.[RELEASE_LABEL] ?? null,
      result: fresh ? "converged" : mode === "plan" ? "stale" : "deferred",
      forced: false, migrationRun: false }) + "\n");
    return mode === "plan" || fresh ? 0 : 3;
  } finally { await closePool(); }
}
void main().then((code) => process.exit(code), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)
    ? error.message : "BOX_RUNTIME_REFRESH_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
