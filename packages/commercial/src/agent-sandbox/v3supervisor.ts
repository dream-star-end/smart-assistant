/**
 * V3/V5 per-user openclaude-runtime container supervisor facade & saga orchestrator.
 *
 * Modularized into `./v3supervisor/{types,namingAndLocks,dockerErrorsAndImages,containerEnv,mountsAndVolumes,dockerLifecycle}.ts`
 * (OCV5-928) while preserving 100% of public exports, container env contracts, and host authority boundaries.
 */
import { createHmac } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import type { Cc5PreparedContainer } from "@openclaude/gateway/cc5-container-runtime";
import { canUseCc5TestModel, serverFeatureContainerEnv } from "@openclaude/protocol";
import { computeInboundNonce } from "../bridgeSecret.js";
import { DEFAULT_V3_CODEX_CONTAINER_DIR } from "../codex-auth/constants.js";
import { boxGptWebContainerEnv, isCursorCredentialMember } from "../cursor/access.js";
import {
  buildCodexRelayLocalBaseUrl,
  readCodexUpstreamBaseUrl,
} from "../http/internalCodexRelay.js";
import { isPromptQueueV1Enabled } from "../http/internalPromptQueue.js";
import { skillShadowContainerEnv } from "../http/internalSkillShadow.js";
import { selectOpenAiPlatformKey } from "../openai/openAiPlatformKey.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { capsuleRuntimeContainerEnv } from "./artifactCasEnv.js";
import { appendCoreMemoryEmbeddingEnv } from "./coreMemoryEmbeddingEnv.js";
import { localSwarmConcurrencyContainerEnv } from "./localSwarmConcurrencyEnv.js";
import { taskboardContainerEnv } from "./taskboardEnv.js";
import { SupervisorError } from "./types.js";
import type { V3RuntimeTuple } from "./v3RuntimeTupleTypes.js";
import {
  advisorOpenEnginesEnv,
  appendModelAuthorityContainerEnv,
  appendPlatformTupleAndOverlayEnv,
  buildCodexRelayContainerEnvWithDeps,
  buildDelegateKnobContainerEnvFromEnv,
  isCodexLocalRelayEnabledFromEnv,
  resolveUserTimeZoneEnv,
  resolveV5LocalCcbTransportEnv,
} from "./v3supervisor/containerEnv.js";
import {
  parseV3ImageGuardMode,
  preheatV3Image,
  validateProvisionPreflightAndHost,
  wrapDockerError,
  type V3ImageGuardMode,
} from "./v3supervisor/dockerErrorsAndImages.js";
import {
  cleanupV3ContainerDockerWithCodexDir,
  getV3ContainerStatus,
  markV3ContainerActivity,
} from "./v3supervisor/dockerLifecycle.js";
import {
  commitProvisionTx2,
  compensateProvisionFailure,
  createAndStartProvisionedContainer,
  prepareCc5ContainerBinding,
  runProvisionAdmissionTx1,
} from "./v3supervisor/provisionContainerSaga.js";
import {
  assembleProvisionContainerBinds,
  bindCodexAccountAndResolveMount,
  ensureProvisionVolumes,
  ensureSshUserRunDir,
  removeV3Volume,
  resolveCcbBaselineMountsWithFs,
  resolveProvisionBaselineMounts,
  resolveV5CursorAuthMountWithFs,
  resolveV5RuntimeTupleMountsAndLabels,
} from "./v3supervisor/mountsAndVolumes.js";
import {
  acquireHostCapLock,
  acquireUserLifecycleLock,
  defaultPickRandomIp,
  defaultRandomSecret,
  gatewayIpFromV3Cidr,
  lookupContainerUserRole,
  ocGatewayIpForChannel,
  ocInternalProxyPortForChannel,
  resolveHostGatewayIp,
  resolveV3ResourceLimitsFromEnv,
  tryAcquireUserLifecycleLock,
  v3CodexVolumeNameFor,
  v3ContainerNameFor,
  v3ProjectsVolumeNameFor,
  v3UserConfigVolumeNameFor,
  v3UserLocalVolumeNameFor,
  v3VolumeNameFor,
  volumeNameForChannel,
} from "./v3supervisor/namingAndLocks.js";
import {
  DEFAULT_V3_CCB_BASELINE_DIR,
  DEFAULT_V3_CPUS,
  DEFAULT_V3_MEMORY_MB,
  DEFAULT_V3_PIDS_LIMIT,
  DELEGATE_KNOB_CONTAINER_ENV_KEYS,
  HOST_CAP_LOCK_NS,
  PROVISION_INFLIGHT_GRACE_MS,
  USER_LIFECYCLE_LOCK_NS,
  V3_ADMIN_PIDS_LIMIT,
  V3_CCB_BASELINE_AGENTS_ADMIN_MD_REL,
  V3_CCB_BASELINE_AGENTS_MD_REL,
  V3_CCB_BASELINE_CLAUDE_ADMIN_MD_REL,
  V3_CCB_BASELINE_CLAUDE_MD_REL,
  V3_CCB_BASELINE_SKILLS_DIR_REL,
  V3_CODEX_AUTH_RO_MOUNT,
  V3_CODEX_HOME_MOUNT,
  V3_CODEX_LOCAL_RELAY_ORIGIN,
  V3_CONFIG_TMPFS_PATH,
  V3_CONTAINER_PORT,
  V3_GATEWAY_IP,
  V3_INTERNAL_PROXY_URL,
  V3_IP_ALLOC_MAX_ATTEMPTS,
  V3_MANAGED_LABEL_KEY,
  V3_NETWORK_NAME,
  V3_PROJECTS_MOUNT,
  V3_SUBNET_CIDR,
  V3_UID_LABEL_KEY,
  V3_USER_CONFIG_MOUNT,
  V3_USER_LOCAL_MOUNT,
  V3_VOLUME_MOUNT,
  V3_VOLUME_ROLES,
  V5_CURSOR_AUTH_RO_MOUNT,
  type CcbBaselineMountOpts,
  type ProvisionedV3Container,
  type SyncHostFsPort,
  type V3ContainerStatus,
  type V3ImagePreheatResult,
  type V3SupervisorDeps,
  type V3VolumeBundle,
  type V3VolumeRole,
  type V5CursorAuthMountOptions,
  type V5LocalCcbTransportEnvInput,
} from "./v3supervisor/types.js";

export { DEFAULT_V3_CODEX_CONTAINER_DIR };
export type { V3RuntimeTuple };
export {
  DEFAULT_V3_CCB_BASELINE_DIR, DEFAULT_V3_CPUS, DEFAULT_V3_MEMORY_MB, DEFAULT_V3_PIDS_LIMIT,
  DELEGATE_KNOB_CONTAINER_ENV_KEYS, HOST_CAP_LOCK_NS, PROVISION_INFLIGHT_GRACE_MS,
  USER_LIFECYCLE_LOCK_NS, V3_ADMIN_PIDS_LIMIT, V3_CCB_BASELINE_AGENTS_ADMIN_MD_REL,
  V3_CCB_BASELINE_AGENTS_MD_REL, V3_CCB_BASELINE_CLAUDE_ADMIN_MD_REL, V3_CCB_BASELINE_CLAUDE_MD_REL,
  V3_CCB_BASELINE_SKILLS_DIR_REL, V3_CODEX_AUTH_RO_MOUNT, V3_CODEX_HOME_MOUNT,
  V3_CODEX_LOCAL_RELAY_ORIGIN, V3_CONFIG_TMPFS_PATH, V3_CONTAINER_PORT, V3_GATEWAY_IP,
  V3_INTERNAL_PROXY_URL, V3_MANAGED_LABEL_KEY, V3_NETWORK_NAME, V3_PROJECTS_MOUNT, V3_SUBNET_CIDR,
  V3_UID_LABEL_KEY, V3_USER_CONFIG_MOUNT, V3_USER_LOCAL_MOUNT, V3_VOLUME_MOUNT, V3_VOLUME_ROLES,
  V5_CURSOR_AUTH_RO_MOUNT, acquireHostCapLock, acquireUserLifecycleLock, advisorOpenEnginesEnv,
  gatewayIpFromV3Cidr, getV3ContainerStatus, lookupContainerUserRole, markV3ContainerActivity,
  ocGatewayIpForChannel, ocInternalProxyPortForChannel, preheatV3Image, removeV3Volume,
  resolveUserTimeZoneEnv, resolveV5LocalCcbTransportEnv, tryAcquireUserLifecycleLock,
  v3CodexVolumeNameFor, v3ContainerNameFor, v3ProjectsVolumeNameFor, v3UserConfigVolumeNameFor,
  v3UserLocalVolumeNameFor, v3VolumeNameFor, volumeNameForChannel, wrapDockerError,
};
export type {
  CcbBaselineMountOpts, ProvisionedV3Container, V3ContainerStatus, V3ImagePreheatResult,
  V3SupervisorDeps, V3VolumeBundle, V3VolumeRole, V5CursorAuthMountOptions, V5LocalCcbTransportEnvInput,
};

/** Keep in lock-step with EXPECTED_SKILLS in scripts/v5-baseline-security.sh. */
export const V3_CCB_BASELINE_SKILL_NAMES = [
  "system-info", "memory-management", "platform-capabilities",
  "scheduled-tasks", "wechat-notify", "skill-management",
  "skill-search", "scansci-pdf", "web-context",
  "browser", "document-writing", "minimax-media",
  "muse-media", "market", "oc-lit",
  "oc-cite", "oc-ingest", "oc-litrag",
  "research-report", "scientific-writing", "scientific-figures",
  "research-slides", "research-tournament", "multi-model-review",
  "research-experiment-loop", "research-writing-style", "office-spreadsheet",
  "office-pdf", "office-suite", "coding-suite",
  "cursor-cli", "code-review", "debugging",
  "testing", "skill-authoring", "app-connectors",
  "connector-authoring", "manage-taskboard", "ssh",
  "ths", "blog-writer", "site-publishing", "scientific-deep-audit",
] as const;

const HOST_SYNC_FS: SyncHostFsPort = {
  lstat: (targetPath) => lstatSync(targetPath),
  readdir: (dirPath) => readdirSync(dirPath),
  realpath: (targetPath) => realpathSync(targetPath),
  readUtf8: (filePath) => readFileSync(filePath, "utf8"),
};

function readCodexContainerDirFromEnv(): string {
  const raw = process.env.OC_V3_CODEX_CONTAINER_DIR;
  if (raw == null || raw.trim() === "") return DEFAULT_V3_CODEX_CONTAINER_DIR;
  return raw.trim();
}

export function isCodexLocalRelayEnabled(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return isCodexLocalRelayEnabledFromEnv(sourceEnv);
}

export function buildCodexRelayContainerEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return buildCodexRelayContainerEnvWithDeps(sourceEnv, (origin, env) =>
    buildCodexRelayLocalBaseUrl(origin, readCodexUpstreamBaseUrl(env)),
  );
}

export function buildDelegateKnobContainerEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return buildDelegateKnobContainerEnvFromEnv(sourceEnv);
}

function readCcbBaselineDirFromEnv(): string {
  const raw = process.env.OC_V3_CCB_BASELINE_DIR;
  if (raw == null || raw.trim() === "") return DEFAULT_V3_CCB_BASELINE_DIR;
  return raw.trim();
}

function readCcbBaselineOptionalFromEnv(): boolean {
  const raw = process.env.OC_V3_CCB_BASELINE_OPTIONAL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveV3ResourceLimits(opts?: { unlimited?: boolean }): {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
} {
  return resolveV3ResourceLimitsFromEnv(
    {
      memoryMb: process.env.OC_V3_MEMORY_MB,
      cpus: process.env.OC_V3_CPUS,
      pidsLimit: process.env.OC_V3_PIDS_LIMIT,
    },
    opts,
  );
}

export function readPlatformBundleOptionalFromEnv(): boolean {
  return process.env.OC_PLATFORM_BUNDLE_OPTIONAL?.trim() === "1";
}

function readV3ImageGuardMode(): V3ImageGuardMode {
  return parseV3ImageGuardMode(process.env.OC_V3_IMAGE_GUARD);
}

export function resolveV5CursorAuthMount(options: V5CursorAuthMountOptions): string | null {
  return resolveV5CursorAuthMountWithFs(HOST_SYNC_FS, options);
}

export function resolveCcbBaselineMounts(
  baselineDir: string,
  opts?: CcbBaselineMountOpts,
): { agentsMdHostPath: string; claudeMdHostPath: string; skillsDirHostPath: string } | null {
  return resolveCcbBaselineMountsWithFs(
    HOST_SYNC_FS,
    baselineDir,
    V3_CCB_BASELINE_SKILL_NAMES,
    opts,
  );
}

function buildCoreBaseContainerEnv(
  internalProxyUrl: string,
  token: string,
  userRole: "user" | "admin",
  hostGatewayIp: string,
): string[] {
  return [
    `ANTHROPIC_BASE_URL=${internalProxyUrl}`,
    `ANTHROPIC_AUTH_TOKEN=${token}`,
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1",
    "CLAUDE_CODE_MAX_RETRIES=2",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    `CLAUDE_CONFIG_DIR=${V3_CONFIG_TMPFS_PATH}`,
    `OC_USER_ROLE=${userRole}`,
    `OPENCLAUDE_TRUST_BRIDGE_IP=${hostGatewayIp}`,
    `OPENCLAUDE_BASELINE_SKILLS_DIR=${V3_CONFIG_TMPFS_PATH}/skills`,
    "OPENCLAUDE_USER_SKILLS_DIR=/home/agent/.openclaude/skills",
    "USE_BUILTIN_RIPGREP=0",
    `OPENCLAUDE_V3_MASTER_BASE_URL=${internalProxyUrl}`,
    `OPENCLAUDE_V3_CONTAINER_TOKEN=${token}`,
    "OC_SEED_DEFAULT_CRON=0",
    ...taskboardContainerEnv(),
    "OC_V3_TRUSTED_FILE_SERVE=1",
  ];
}

function appendMasterFeatureAndObservabilityEnv(env: string[]): void {
  if (process.env.OC_TOOL_FAILURE_AUDIT === "1") {
    env.push("OC_TOOL_FAILURE_AUDIT=1");
  }
  if (process.env.OC_PROJECT_CONTEXT === "1") {
    env.push("OC_PROJECT_CONTEXT=1");
  }
  if (
    ["1", "true", "yes", "on"].includes(
      (process.env.OC_P5_PROJECT_SEARCH ?? "").trim().toLowerCase(),
    )
  ) {
    env.push("OC_P5_PROJECT_SEARCH=1");
  }
  if (process.env.OC_RESEARCH_WORKSPACE === "1") {
    env.push("OC_RESEARCH_WORKSPACE=1");
  }
  env.push(...serverFeatureContainerEnv(process.env));
  for (const key of [
    "OC_LOCAL_OBSERVABILITY_RETENTION",
    "OC_LOCAL_EVENT_RETENTION_DAYS",
    "OC_LOCAL_USAGE_RETENTION_DAYS",
    "OC_REDACT_TOOL_EVENT_PREVIEWS",
  ] as const) {
    const value = process.env[key];
    if (value && /^[0-9]+$/.test(value)) env.push(`${key}=${value}`);
  }
  const supervisorEnv = process.env;
  env.push(
    ...buildDelegateKnobContainerEnv(supervisorEnv),
    ...localSwarmConcurrencyContainerEnv({ env: supervisorEnv }),
    ...capsuleRuntimeContainerEnv({ env: supervisorEnv }),
    process.env.OC_MARKET_SKILL_USAGE === "0"
      ? "OC_MARKET_SKILL_USAGE=0"
      : "OC_MARKET_SKILL_USAGE=1",
    ...skillShadowContainerEnv(process.env),
  );
}

async function assembleMasterContainerEnv(opts: {
  deps: V3SupervisorDeps;
  uid: number;
  rowId: number;
  token: string;
  userRole: "user" | "admin";
  useRemote: boolean;
  hostGatewayIp: string;
  internalProxyUrl: string;
  cc5Prepared: Cc5PreparedContainer | null;
  cc5KeyringAssignment: string | undefined;
}): Promise<string[]> {
  const { uid } = opts;
  const runtimeChannel = getRuntimeChannel();
  const env = buildCoreBaseContainerEnv(
    opts.internalProxyUrl,
    opts.token,
    opts.userRole,
    opts.hostGatewayIp,
  );
  env.push(
    ...resolveV5LocalCcbTransportEnv({
      runtimeChannel,
      useRemote: opts.useRemote,
      hostGatewayIp: opts.hostGatewayIp,
      proxyUrl: process.env.OC_CLAUDE_CODE_HTTPS_PROXY,
      noProxy: process.env.NO_PROXY,
    }),
    ...resolveUserTimeZoneEnv(process.env.OC_USER_TZ),
  );
  env.push(boxGptWebContainerEnv(uid));

  const promptQueueEnabled = runtimeChannel === "v5" && isPromptQueueV1Enabled();
  if (promptQueueEnabled) {
    env.push("OC_PROMPT_QUEUE_V1=1", `OC_USER_ID=${String(uid)}`);
  }
  if (runtimeChannel === "v5") {
    env.push("OC_CONTAINER_PREVIEW_ENABLED=1");
    const runtimeBatching = process.env.LOSSLESS_TURN_TAPE_RUNTIME_BATCHING?.trim().toLowerCase();
    if (runtimeBatching === "1" || runtimeBatching === "true" || runtimeBatching === "on") {
      env.push("LOSSLESS_TURN_TAPE_RUNTIME_BATCHING=1");
    }
  }
  env.push(...buildCodexRelayContainerEnv(process.env));
  const openAiApiKey = await selectOpenAiPlatformKey("core-memory-embed");
  appendCoreMemoryEmbeddingEnv(env, { openAiApiKey });
  appendMasterFeatureAndObservabilityEnv(env);

  if (opts.deps.bridgeSecret) {
    env.push(
      `OC_CONTAINER_ID=${String(opts.rowId)}`,
      `OC_BRIDGE_NONCE=${createHmac("sha256", opts.deps.bridgeSecret)
        .update(String(opts.rowId))
        .digest("hex")}`,
      `OPENCLAUDE_INBOUND_NONCE=${computeInboundNonce(opts.deps.bridgeSecret, opts.rowId)}`,
    );
  }
  if (opts.deps.modelAuthority) {
    appendModelAuthorityContainerEnv(env, {
      modelAuthority: opts.deps.modelAuthority,
      uid: opts.uid,
      promptQueueEnabled,
      cc5Prepared: opts.cc5Prepared,
      cc5KeyringAssignment: opts.cc5KeyringAssignment,
      selfhostEngineLocalTurns: process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS,
      advisorOpenEnginesRaw: process.env.OC_ADVISOR_OPEN_ENGINES,
    });
  }
  return env;
}

function resolveCursorMountFromEnv(uid: number, useRemote: boolean): string | null {
  const runtimeChannel = getRuntimeChannel();
  const cursorAuthMount = resolveV5CursorAuthMount({
    uid,
    runtimeChannel,
    useRemote,
    credentialUids: process.env.OC_V5_CURSOR_CREDENTIAL_UIDS,
    ownerUid: process.env.OC_V5_CURSOR_OWNER_UID,
    authDir: process.env.OC_V5_CURSOR_AUTH_DIR,
  });
  if (
    cursorAuthMount === null &&
    runtimeChannel === "v5" &&
    !useRemote &&
    isCursorCredentialMember(
      uid,
      process.env.OC_V5_CURSOR_CREDENTIAL_UIDS?.trim()
        ? process.env.OC_V5_CURSOR_CREDENTIAL_UIDS
        : process.env.OC_V5_CURSOR_OWNER_UID,
    )
  ) {
    console.error(
      `[v3supervisor] WARN: v5 Cursor auth mount rejected for uid ${uid}; Cursor CLI disabled`,
    );
  }
  return cursorAuthMount;
}

function isIpUniqueConflictError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== "23505") return false;
  if (e.constraint === "uniq_ac_bound_ip_active" || e.constraint === "idx_ac_host_bound_ip_active") {
    return true;
  }
  return /uniq_ac_bound_ip_active|idx_ac_host_bound_ip_active/i.test(String((err as Error).message));
}

async function allocateBoundIpAndInsertRow(
  client: PoolClient,
  uid: number,
  secretHash: Buffer,
  pickIp: () => string,
  hostUuid: string,
  image: string,
  fixedBoundIp?: string,
): Promise<{ id: number; boundIp: string }> {
  const insertSql = `INSERT INTO agent_containers
       (user_id, host_uuid, bound_ip, secret_hash, state, port, image, runtime_channel, runtime_kind, last_ws_activity, created_at, updated_at)
     VALUES
       ($1::bigint, $2::uuid, $3::inet, $4::bytea, 'active', $5::int, $6::text, $7::text, 'docker', NOW(), NOW(), NOW())
     RETURNING id`;

  if (fixedBoundIp !== undefined) {
    try {
      const r = await client.query<{ id: string }>(insertSql, [
        String(uid),
        hostUuid,
        fixedBoundIp,
        secretHash,
        V3_CONTAINER_PORT,
        image,
        getRuntimeChannel(),
      ]);
      return { id: Number.parseInt(r.rows[0]!.id, 10), boundIp: fixedBoundIp };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new SupervisorError(
          "NameConflict",
          `bound_ip ${fixedBoundIp} already taken (scheduler race)`,
        );
      }
      throw err;
    }
  }

  for (let attempt = 0; attempt < V3_IP_ALLOC_MAX_ATTEMPTS; attempt++) {
    const candidate = pickIp();
    await client.query("SAVEPOINT oc_v3_ip_alloc_attempt");
    try {
      const r = await client.query<{ id: string }>(insertSql, [
        String(uid),
        hostUuid,
        candidate,
        secretHash,
        V3_CONTAINER_PORT,
        image,
        getRuntimeChannel(),
      ]);
      await client.query("RELEASE SAVEPOINT oc_v3_ip_alloc_attempt");
      return { id: Number.parseInt(r.rows[0]!.id, 10), boundIp: candidate };
    } catch (err) {
      if (isIpUniqueConflictError(err)) {
        await client.query("ROLLBACK TO SAVEPOINT oc_v3_ip_alloc_attempt");
        await client.query("RELEASE SAVEPOINT oc_v3_ip_alloc_attempt");
        continue;
      }
      throw err;
    }
  }
  throw new SupervisorError(
    "InvalidArgument",
    `failed to allocate bound_ip after ${V3_IP_ALLOC_MAX_ATTEMPTS} attempts; subnet ${V3_SUBNET_CIDR} likely exhausted`,
  );
}

export async function provisionV3Container(
  deps: V3SupervisorDeps,
  uid: number,
  hostId?: string,
  boundIp?: string,
  bridgeCidr?: string | null,
): Promise<ProvisionedV3Container> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  if (typeof deps.image !== "string" || deps.image.trim() === "") {
    throw new SupervisorError("InvalidArgument", "deps.image (OC_RUNTIME_IMAGE) is required");
  }

  const userRole = await lookupContainerUserRole(deps.pool, uid);
  const { effectiveHostUuid, useRemote } = await validateProvisionPreflightAndHost(
    deps,
    uid,
    hostId,
    readV3ImageGuardMode(),
  );
  const containerName = v3ContainerNameFor(uid);
  const { row, secret } = await runProvisionAdmissionTx1(
    deps,
    uid,
    effectiveHostUuid,
    boundIp,
    deps.randomIp ?? defaultPickRandomIp,
    deps.randomSecret ?? defaultRandomSecret,
    allocateBoundIpAndInsertRow,
  );

  const token = `oc-v3.${row.id}.${secret}`;
  let createdDockerId = "";
  let boundCodexAccountId: bigint | null = null;
  let appliedBundleRev: string | undefined;
  let cc5Prepared: Cc5PreparedContainer | null = null;
  const syntheticEvalOverlay =
    getRuntimeChannel() === "v5" && !useRemote
      ? (deps.syntheticEvalOverlay?.resolvePrepared(uid) ?? null)
      : null;

  try {
    const volumeNames = await ensureProvisionVolumes(deps, uid, useRemote, hostId);
    const cc5Bind = await prepareCc5ContainerBinding(
      deps,
      uid,
      row.id,
      useRemote,
      canUseCc5TestModel(uid, process.env),
    );
    cc5Prepared = cc5Bind.cc5Prepared;

    const hostGatewayIp = resolveHostGatewayIp(bridgeCidr, useRemote, hostId);
    const internalProxyUrl = `http://${hostGatewayIp}:${ocInternalProxyPortForChannel()}`;
    const env = await assembleMasterContainerEnv({
      deps,
      uid,
      rowId: row.id,
      token,
      userRole,
      useRemote,
      hostGatewayIp,
      internalProxyUrl,
      cc5Prepared,
      cc5KeyringAssignment: cc5Bind.cc5KeyringAssignment,
    });

    const baselineMounts = await resolveProvisionBaselineMounts(
      deps,
      HOST_SYNC_FS,
      V3_CCB_BASELINE_SKILL_NAMES,
      {
        uid,
        useRemote,
        hostId,
        userRole,
        fallbackBaselineDir: readCcbBaselineDirFromEnv(),
        baselineOptional: readCcbBaselineOptionalFromEnv(),
        overlayBaselineHostPath: syntheticEvalOverlay?.baselineHostPath,
      },
    );
    const tupleState = resolveV5RuntimeTupleMountsAndLabels(
      HOST_SYNC_FS,
      deps.runtimeTuple,
      uid,
      readPlatformBundleOptionalFromEnv(),
    );
    appliedBundleRev = tupleState.appliedBundleRev;
    appendPlatformTupleAndOverlayEnv(env, {
      injectPlatformEnv: tupleState.injectPlatformEnv,
      injectedBundleRev: tupleState.injectedBundleRev,
      hasSyntheticEvalOverlay: Boolean(syntheticEvalOverlay),
      injectReleaseEnv: tupleState.injectReleaseEnv,
    });

    const sshUserRunDir = useRemote ? null : await ensureSshUserRunDir(uid);
    const cursorAuthMount = resolveCursorMountFromEnv(uid, useRemote);
    const codexBind = await bindCodexAccountAndResolveMount(
      deps,
      uid,
      row.id,
      useRemote,
      hostId,
      readCodexContainerDirFromEnv(),
    );
    boundCodexAccountId = codexBind.boundCodexAccountId;
    const binds = assembleProvisionContainerBinds({
      volumeNames,
      cc5Prepared,
      cursorAuthMount,
      codexMountSource: codexBind.codexMountSource,
      sshUserRunDir,
      baselineMounts,
      platformBinds: tupleState.platformBinds,
      syntheticEvalOverlay,
      syntheticEvalOverlayRuntime: deps.syntheticEvalOverlay,
      runtimeLabels: tupleState.runtimeLabels,
    });
    const limits = resolveV3ResourceLimits({ unlimited: userRole === "admin" });
    createdDockerId = await createAndStartProvisionedContainer(
      {
        deps,
        uid,
        row,
        containerName,
        useRemote,
        hostId,
        env,
        binds,
        runtimeLabels: tupleState.runtimeLabels,
        memoryBytes: limits.memoryBytes,
        nanoCpus: limits.nanoCpus,
        pidsLimit: limits.pidsLimit,
        cc5Prepared,
        hasSyntheticEvalOverlay: Boolean(syntheticEvalOverlay),
      },
      (id) => {
        createdDockerId = id;
      },
    );
  } catch (err) {
    await compensateProvisionFailure(deps, row.id, createdDockerId, useRemote, hostId);
    throw err;
  }

  await commitProvisionTx2(
    deps,
    row.id,
    createdDockerId,
    boundCodexAccountId,
    useRemote,
    hostId,
    cc5Prepared,
    syntheticEvalOverlay,
  );
  return {
    containerId: row.id,
    userId: uid,
    boundIp: row.boundIp,
    port: V3_CONTAINER_PORT,
    dockerContainerId: createdDockerId,
    token,
    hostId: effectiveHostUuid,
    ...(appliedBundleRev ? { bundleRev: appliedBundleRev } : {}),
  };
}

export async function markV3ContainerVanished(
  client: Pool | PoolClient,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  options?: { requireNoOpenMigration?: boolean; requireIdleCutoffMin?: number },
): Promise<{ hit: boolean; hostUuid: string | null }> {
  const guardSql =
    options?.requireNoOpenMigration === true
      ? ` AND NOT EXISTS (
          SELECT 1 FROM agent_migrations m
           WHERE m.agent_container_id = agent_containers.id
             AND m.phase NOT IN ('committed', 'rolled_back')
        )`
      : "";
  const idleCutoffMin = options?.requireIdleCutoffMin;
  const updateParams: unknown[] = [
    String(containerRow.id),
    getRuntimeChannel(),
    containerRow.container_internal_id ?? null,
  ];
  let idleSql = "";
  if (typeof idleCutoffMin === "number" && Number.isFinite(idleCutoffMin)) {
    updateParams.push(idleCutoffMin);
    idleSql = ` AND last_ws_activity IS NOT NULL
        AND last_ws_activity < NOW() - ($${updateParams.length}::int * interval '1 minute')`;
  }
  const updateResult = await client.query<{ host_uuid: string | null }>(
    `UPDATE agent_containers
        SET state='vanished',
            updated_at=NOW()
      WHERE id = $1 AND runtime_channel = $2 AND runtime_kind = 'docker'
        AND container_internal_id IS NOT DISTINCT FROM $3${guardSql}${idleSql}
      RETURNING host_uuid`,
    updateParams,
  );
  const hit = (updateResult.rowCount ?? 0) > 0;
  return { hit, hostUuid: hit ? (updateResult.rows[0]?.host_uuid ?? null) : null };
}

export async function cleanupV3ContainerDocker(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  timeoutSec: number,
  dbHostUuid: string | null,
): Promise<void> {
  return cleanupV3ContainerDockerWithCodexDir(
    deps,
    containerRow,
    timeoutSec,
    dbHostUuid,
    readCodexContainerDirFromEnv(),
  );
}

export async function stopAndRemoveV3Container(
  deps: V3SupervisorDeps,
  containerRow: { id: number; container_internal_id?: string | null; host_uuid?: string | null },
  timeoutSec = 5,
  options?: { requireNoOpenMigration?: boolean; requireIdleCutoffMin?: number },
): Promise<boolean> {
  const vanished = await markV3ContainerVanished(deps.pool, containerRow, options);
  if (!vanished.hit) {
    const hasIdleGuard =
      typeof options?.requireIdleCutoffMin === "number" &&
      Number.isFinite(options.requireIdleCutoffMin);
    if (options?.requireNoOpenMigration !== true && !hasIdleGuard) {
      console.warn(
        `[v3supervisor.stopAndRemove] rowCount=0 for container ${containerRow.id} ` +
          `(channel=${getRuntimeChannel()}): row gone or wrong channel ` +
          `— skipping docker cleanup, deferring to orphanReconcile`,
      );
    }
    return false;
  }
  await cleanupV3ContainerDocker(deps, containerRow, timeoutSec, vanished.hostUuid);
  return true;
}
