/**
 * CCB platform baseline validation, V5 Cursor auth mount resolution, V5 runtime
 * tuple mount/label assembly, per-user volumes, SSH mux dir, and Codex auth binding.
 *
 * Layer: app-container (L4). Zero `process.env`, zero `syncIo` (sync FS injected via
 * `SyncHostFsPort`), all functions <= 85L, CC <= 16, maxNesting <= 4.
 */
import type Docker from "dockerode"
import { chmod as fsChmod, chown as fsChown, mkdir as fsMkdir } from "node:fs/promises"
import {
  basename as pathBasename,
  isAbsolute as pathIsAbsolute,
  join as pathJoin,
  normalize as pathNormalize,
} from "node:path"
import type { Cc5PreparedContainer } from "@openclaude/gateway/cc5-container-runtime"
import { pickCodexAccountForBinding } from "../../account-pool/scheduler.js"
import { getCodexTokenSnapshot } from "../../account-pool/store.js"
import { DEFAULT_V3_CODEX_CONTAINER_DIR } from "../../codex-auth/constants.js"
import { writeCodexContainerAuthFile } from "../../codex-auth/codexAuthFile.js"
import { RUNTIME_CHANNEL_LABEL_KEY } from "../../compute-pool/containerService.js"
import { listAllHosts as defaultListAllHosts } from "../../compute-pool/queries.js"
import { zeroBuffer } from "../../crypto/keys.js"
import { isCursorCredentialMember } from "../../cursor/access.js"
import { codexBindingAffinityKey, getRuntimeChannel } from "../../runtimeChannel.js"
import { V3_AGENT_GID, V3_AGENT_UID } from "../constants.js"
import {
  DEFAULT_PLATFORM_ROOT,
  PLATFORM_MOUNT_TARGET,
  RELEASE_MOUNT_TARGET,
  RUNTIME_BOOT_HASH_LABEL_KEY,
  RUNTIME_BUNDLE_REV_LABEL_KEY,
  RUNTIME_IMAGE_ID_LABEL_KEY,
  RUNTIME_RELEASE_LABEL_KEY,
  assertBaselineLeaf,
  assertCurrentMatches,
} from "../platformBundle.js"
import {
  SYNTHETIC_EVAL_PROMPT_SLOTS_BIND_TARGET,
  SYNTHETIC_EVAL_PROMPTS_BIND_TARGET,
  type SyntheticEvalOverlayRuntime,
} from "../syntheticEvalOverlayRuntime.js"
import { SupervisorError } from "../types.js"
import { isNotFound, wrapDockerError } from "./dockerErrorsAndImages.js"
import {
  v3CodexVolumeNameFor,
  v3ProjectsVolumeNameFor,
  v3UserConfigVolumeNameFor,
  v3UserLocalVolumeNameFor,
  v3VolumeNameFor,
} from "./namingAndLocks.js"
import {
  V3_CCB_BASELINE_AGENTS_ADMIN_MD_REL,
  V3_CCB_BASELINE_AGENTS_MD_REL,
  V3_CCB_BASELINE_CLAUDE_ADMIN_MD_REL,
  V3_CCB_BASELINE_CLAUDE_MD_REL,
  V3_CCB_BASELINE_SKILLS_DIR_REL,
  V3_CODEX_AUTH_RO_MOUNT,
  V3_CODEX_HOME_MOUNT,
  V3_CONFIG_TMPFS_PATH,
  V3_MANAGED_LABEL_KEY,
  V3_PROJECTS_MOUNT,
  V3_SSH_RUN_CONTAINER_MOUNT,
  V3_SSH_RUN_ROOT_HOST,
  V3_UID_LABEL_KEY,
  V3_USER_CONFIG_MOUNT,
  V3_USER_LOCAL_MOUNT,
  V3_VOLUME_MOUNT,
  V5_CURSOR_AUTH_RO_MOUNT,
  supervisorLog as log,
  type CcbBaselineMountOpts,
  type ResolvedCcbBaselineMounts,
  type SyncHostFsPort,
  type V3SupervisorDeps,
  type V3VolumeBundle,
  type V5CursorAuthMountOptions,
} from "./types.js"

function isSafeRootOwnedDir(fs: SyncHostFsPort, normalized: string): boolean {
  const dirStat = fs.lstat(normalized);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return false;
  if (dirStat.uid !== 0 || (dirStat.mode & 0o077) !== 0) return false;
  return fs.realpath(normalized) === normalized;
}

function isValidEmptyPoolMarker(fs: SyncHostFsPort, normalized: string): boolean {
  const markerPath = pathJoin(normalized, ".account-pool-owned");
  const markerStat = fs.lstat(markerPath);
  const markerMode = markerStat.mode & 0o777;
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== 0) return false;
  if (markerMode !== 0o400 && markerMode !== 0o600) return false;
  if (markerStat.size !== 2 || fs.realpath(markerPath) !== markerPath) return false;
  return fs.readUtf8(markerPath) === "1\n";
}

function isValidRootOwnedKeyFile(fs: SyncHostFsPort, keyPath: string): boolean {
  const keyStat = fs.lstat(keyPath);
  const keyMode = keyStat.mode & 0o777;
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.uid !== 0) return false;
  if (keyMode !== 0o400 && keyMode !== 0o600) return false;
  return fs.realpath(keyPath) === keyPath;
}

export function resolveV5CursorAuthMountWithFs(
  fs: SyncHostFsPort,
  options: V5CursorAuthMountOptions,
): string | null {
  if (options.runtimeChannel !== "v5" || options.useRemote) return null;

  const dirRaw = options.authDir?.trim() ?? "";
  const credentialUids = options.credentialUids?.trim()
    ? options.credentialUids
    : options.ownerUid;
  if (!dirRaw || !isCursorCredentialMember(options.uid, credentialUids)) return null;
  if (!pathIsAbsolute(dirRaw)) return null;

  const normalized = pathNormalize(dirRaw).replace(/(?<!^)\/+$/, "");
  try {
    if (!isSafeRootOwnedDir(fs, normalized)) return null;
    const keyPath = pathJoin(normalized, "api-key");
    try {
      return isValidRootOwnedKeyFile(fs, keyPath) ? normalized : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      return isValidEmptyPoolMarker(fs, normalized) ? normalized : null;
    }
  } catch {
    return null;
  }
}

function assertBaselineTreeWithFs(
  fs: SyncHostFsPort,
  dirPath: string,
  baselineRoot: string,
): void {
  assertBaselineLeaf(dirPath, "dir", baselineRoot);
  for (const name of fs.readdir(dirPath).sort()) {
    const child = pathJoin(dirPath, name);
    const st = fs.lstat(child);
    if (st.isDirectory()) {
      assertBaselineTreeWithFs(fs, child, baselineRoot);
    } else if (st.isFile()) {
      assertBaselineLeaf(child, "file", baselineRoot);
    } else {
      throw new Error(`baseline tree entry is neither file nor directory: ${child}`);
    }
  }
}

function assertSkillsTopLevelMatchesManifest(
  fs: SyncHostFsPort,
  skillsDirPath: string,
  manifestSkillNames: readonly string[],
): void {
  const manifestSet = new Set<string>(manifestSkillNames);
  const actualTop = new Set(fs.readdir(skillsDirPath));
  if (actualTop.size !== manifestSet.size) {
    throw new Error(
      `skills/ has ${actualTop.size} top-level entries, manifest declares ${manifestSet.size}`,
    );
  }
  for (const name of actualTop) {
    if (!manifestSet.has(name)) {
      throw new Error(`skills/ has undeclared top-level entry: ${name}`);
    }
  }
  for (const name of manifestSet) {
    if (!actualTop.has(name)) {
      throw new Error(`skills/ missing declared manifest entry: ${name}`);
    }
  }
}

function validateSingleSkillDirWithFs(
  fs: SyncHostFsPort,
  skillsDirPath: string,
  name: string,
  baselineRoot: string,
): void {
  const skillDir = pathJoin(skillsDirPath, name);
  assertBaselineLeaf(skillDir, "dir", baselineRoot);
  const skillEntries = fs.readdir(skillDir).sort();
  const allowed = new Set(["SKILL.md", "evals", "references", "scripts", "plugin.json"]);
  if (!skillEntries.includes("SKILL.md")) {
    throw new Error(`skill dir ${name} missing SKILL.md, got: ${JSON.stringify(skillEntries)}`);
  }
  for (const entry of skillEntries) {
    if (!allowed.has(entry)) {
      throw new Error(
        `skill dir ${name} has undeclared entry ${entry}; allowed: SKILL.md, plugin.json, evals/, references/, scripts/`,
      );
    }
  }
  assertBaselineLeaf(pathJoin(skillDir, "SKILL.md"), "file", baselineRoot);
  if (skillEntries.includes("evals")) {
    const evalsDir = pathJoin(skillDir, "evals");
    assertBaselineLeaf(evalsDir, "dir", baselineRoot);
    const evalEntries = fs.readdir(evalsDir);
    if (evalEntries.length !== 1 || evalEntries[0] !== "evals.json") {
      throw new Error(
        `skill dir ${name}/evals must contain exactly one entry (evals.json), got: ${JSON.stringify(evalEntries)}`,
      );
    }
    assertBaselineLeaf(pathJoin(evalsDir, "evals.json"), "file", baselineRoot);
  }
  if (skillEntries.includes("plugin.json")) {
    const manifestPath = pathJoin(skillDir, "plugin.json");
    assertBaselineLeaf(manifestPath, "file", baselineRoot);
    if (fs.lstat(manifestPath).size > 64 * 1024) {
      throw new Error(`skill dir ${name}/plugin.json is larger than 64KB`);
    }
  }
  if (skillEntries.includes("references")) {
    assertBaselineTreeWithFs(fs, pathJoin(skillDir, "references"), baselineRoot);
  }
  if (skillEntries.includes("scripts")) {
    assertBaselineTreeWithFs(fs, pathJoin(skillDir, "scripts"), baselineRoot);
  }
}

export function resolveCcbBaselineMountsWithFs(
  fs: SyncHostFsPort,
  baselineDir: string,
  manifestSkillNames: readonly string[],
  opts?: CcbBaselineMountOpts,
): ResolvedCcbBaselineMounts | null {
  if (typeof baselineDir !== "string" || baselineDir.trim() === "") return null;
  if (!pathIsAbsolute(baselineDir)) return null;
  const abs = pathNormalize(baselineDir).replace(/(?<!^)\/+$/, "");
  try {
    assertBaselineLeaf(abs, "dir", abs);
    const agentsReal = assertBaselineLeaf(pathJoin(abs, V3_CCB_BASELINE_AGENTS_MD_REL), "file", abs);
    const claudeReal = assertBaselineLeaf(pathJoin(abs, V3_CCB_BASELINE_CLAUDE_MD_REL), "file", abs);
    const agentsAdminReal = assertBaselineLeaf(
      pathJoin(abs, V3_CCB_BASELINE_AGENTS_ADMIN_MD_REL),
      "file",
      abs,
    );
    const claudeAdminReal = assertBaselineLeaf(
      pathJoin(abs, V3_CCB_BASELINE_CLAUDE_ADMIN_MD_REL),
      "file",
      abs,
    );
    const skillsDirPath = pathJoin(abs, V3_CCB_BASELINE_SKILLS_DIR_REL);
    const skillsDirReal = assertBaselineLeaf(skillsDirPath, "dir", abs);

    assertSkillsTopLevelMatchesManifest(fs, skillsDirPath, manifestSkillNames);
    for (const name of manifestSkillNames) {
      validateSingleSkillDirWithFs(fs, skillsDirPath, name, abs);
    }
    const admin = opts?.admin === true;
    return {
      agentsMdHostPath: admin ? agentsAdminReal : agentsReal,
      claudeMdHostPath: admin ? claudeAdminReal : claudeReal,
      skillsDirHostPath: skillsDirReal,
    };
  } catch (err) {
    log.warn("[v3supervisor] resolveCcbBaselineMounts failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function resolveProvisionBaselineMounts(
  deps: V3SupervisorDeps,
  fs: SyncHostFsPort,
  manifestSkillNames: readonly string[],
  opts: {
    uid: number;
    useRemote: boolean;
    hostId: string | undefined;
    userRole: "user" | "admin";
    fallbackBaselineDir: string;
    baselineOptional: boolean;
    overlayBaselineHostPath: string | undefined;
  },
): Promise<ResolvedCcbBaselineMounts | null> {
  let baselineMounts: ResolvedCcbBaselineMounts | null;
  let baselineDir: string;
  if (opts.useRemote) {
    const remotePaths = await deps.containerService!.resolveBaselinePaths(opts.hostId!);
    baselineMounts = remotePaths;
    baselineDir = remotePaths.skillsDirHostPath.replace(/\/skills$/, "");
  } else {
    baselineDir =
      opts.overlayBaselineHostPath ?? deps.ccbBaselineDir ?? opts.fallbackBaselineDir;
    baselineMounts = resolveCcbBaselineMountsWithFs(fs, baselineDir, manifestSkillNames, {
      admin: opts.userRole === "admin",
    });
  }
  if (opts.useRemote && opts.userRole === "admin" && baselineMounts) {
    const root = baselineMounts.skillsDirHostPath.replace(/\/skills$/, "");
    baselineMounts = {
      agentsMdHostPath: `${root}/${V3_CCB_BASELINE_AGENTS_ADMIN_MD_REL}`,
      claudeMdHostPath: `${root}/${V3_CCB_BASELINE_CLAUDE_ADMIN_MD_REL}`,
      skillsDirHostPath: baselineMounts.skillsDirHostPath,
    };
  }
  if (!baselineMounts) {
    if (opts.baselineOptional) {
      console.warn(
        "[v3supervisor] CCB baseline dir missing/incomplete (OPTIONAL=1); container will spawn WITHOUT platform guardrails",
        { baselineDir, uid: opts.uid },
      );
    } else {
      console.error(
        "[v3supervisor] CCB baseline dir missing/incomplete; refusing to spawn container (set OC_V3_CCB_BASELINE_OPTIONAL=1 to override in dev)",
        { baselineDir, uid: opts.uid },
      );
      throw new SupervisorError(
        "CcbBaselineMissing",
        `CCB baseline dir missing or failed validation: ${baselineDir}`,
      );
    }
  }
  return baselineMounts;
}

export interface ResolvedV5RuntimeTupleState {
  platformBinds: string[];
  runtimeLabels: Record<string, string>;
  injectPlatformEnv: boolean;
  injectedBundleRev: string;
  injectReleaseEnv: boolean;
  appliedBundleRev: string | undefined;
}

function resolveV5BundleAxis(
  fs: SyncHostFsPort,
  tuple: NonNullable<V3SupervisorDeps["runtimeTuple"]>,
  uid: number,
  bundleOptional: boolean,
  platformBinds: string[],
  runtimeLabels: Record<string, string>,
): { injectPlatformEnv: boolean; injectedBundleRev: string; appliedBundleRev: string | undefined } {
  let injectPlatformEnv = false;
  let injectedBundleRev = "";
  const bundleReady = Boolean(tuple.bundleResolvedPath && tuple.bundleRev && tuple.bootHash);
  if (!bundleReady) {
    if (bundleOptional) {
      console.warn(
        "[v3supervisor] OC_PLATFORM_BUNDLE failed startup validation (OPTIONAL=1); skipping platform bundle mount",
        { uid, bundlePath: tuple.bundlePath },
      );
    } else {
      console.error(
        "[v3supervisor] OC_PLATFORM_BUNDLE failed startup validation; refusing provision",
        { uid, bundlePath: tuple.bundlePath },
      );
      throw new SupervisorError(
        "PlatformBundleInvalid",
        `platform bundle not resolved at startup (bundlePath=${tuple.bundlePath}); check gateway boot logs`,
      );
    }
  } else {
    const platformRoot = tuple.platformRoot ?? DEFAULT_PLATFORM_ROOT;
    try {
      assertCurrentMatches(platformRoot, tuple.bundlePath!);
      const platformRootReal = fs.realpath(platformRoot);
      platformBinds.push(`${platformRootReal}:${PLATFORM_MOUNT_TARGET}:ro`);
      injectPlatformEnv = true;
      injectedBundleRev = tuple.bundleRev!;
    } catch (e) {
      if (bundleOptional) {
        console.warn(
          "[v3supervisor] platform current mid-state (OPTIONAL=1); skipping platform bundle mount",
          { uid, error: (e as Error).message },
        );
      } else {
        throw e instanceof SupervisorError
          ? e
          : new SupervisorError(
              "PlatformBundleInvalid",
              `platform stable root unresolvable during activation guard: ${(e as Error).message}`,
            );
      }
    }
  }
  runtimeLabels[RUNTIME_BUNDLE_REV_LABEL_KEY] = tuple.bundleRev ?? "";
  runtimeLabels[RUNTIME_BOOT_HASH_LABEL_KEY] = tuple.bootHash ?? "";
  const appliedBundleRev = runtimeLabels[RUNTIME_BUNDLE_REV_LABEL_KEY] || undefined;
  return { injectPlatformEnv, injectedBundleRev, appliedBundleRev };
}

export function resolveV5RuntimeTupleMountsAndLabels(
  fs: SyncHostFsPort,
  tuple: V3SupervisorDeps["runtimeTuple"],
  uid: number,
  bundleOptional: boolean,
): ResolvedV5RuntimeTupleState {
  const platformBinds: string[] = [];
  const runtimeLabels: Record<string, string> = {};
  let injectPlatformEnv = false;
  let injectedBundleRev = "";
  let injectReleaseEnv = false;
  let appliedBundleRev: string | undefined;

  if (getRuntimeChannel() === "v5" && tuple) {
    const bundleEnabled = Boolean(tuple.bundlePath && tuple.bundlePath.trim() !== "");
    const releaseEnabled = Boolean(tuple.releasePath && tuple.releasePath.trim() !== "");

    if (tuple.imageId && tuple.imageId.trim() !== "") {
      runtimeLabels[RUNTIME_IMAGE_ID_LABEL_KEY] = tuple.imageId;
    }
    if (bundleEnabled) {
      const b = resolveV5BundleAxis(fs, tuple, uid, bundleOptional, platformBinds, runtimeLabels);
      injectPlatformEnv = b.injectPlatformEnv;
      injectedBundleRev = b.injectedBundleRev;
      appliedBundleRev = b.appliedBundleRev;
    }
    if (releaseEnabled) {
      platformBinds.push(`${tuple.releaseResolvedPath}:${RELEASE_MOUNT_TARGET}:ro`);
      runtimeLabels[RUNTIME_RELEASE_LABEL_KEY] = pathBasename(tuple.releasePath!);
      injectReleaseEnv = true;
    }
  } else if (tuple?.bundlePath || tuple?.releasePath) {
    console.warn(
      "[v3supervisor] OC_PLATFORM_BUNDLE/OC_RUNTIME_RELEASE ignored on v3 channel (v5-only hot-config)",
      { uid },
    );
  }

  return {
    platformBinds,
    runtimeLabels,
    injectPlatformEnv,
    injectedBundleRev,
    injectReleaseEnv,
    appliedBundleRev,
  };
}

export async function ensureSshUserRunDir(uid: number): Promise<string> {
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new SupervisorError("InvalidArgument", `invalid uid: ${uid}`);
  }
  const dir = pathJoin(V3_SSH_RUN_ROOT_HOST, `u${uid}`);
  await fsMkdir(dir, { recursive: true, mode: 0o750 });
  await fsChmod(dir, 0o750);
  await fsChown(dir, 0, V3_AGENT_GID);
  return dir;
}

async function ensureSingleV3Volume(
  docker: Docker,
  uid: number,
  name: string,
  purpose: "data" | "projects" | "codex" | "userLocal" | "userConfig",
): Promise<void> {
  await docker.createVolume({
    Name: name,
    Driver: "local",
    Labels: {
      [V3_MANAGED_LABEL_KEY]: "1",
      [V3_UID_LABEL_KEY]: String(uid),
      [RUNTIME_CHANNEL_LABEL_KEY]: getRuntimeChannel(),
    },
  });
  const info = await docker.getVolume(name).inspect();
  if (info.Driver && info.Driver !== "local") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists with driver=${info.Driver}, expected local`,
    );
  }
  const labels = (info.Labels ?? {}) as Record<string, string>;
  if (labels[V3_MANAGED_LABEL_KEY] !== "1") {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists but is not managed by openclaude v3 (missing ${V3_MANAGED_LABEL_KEY})`,
    );
  }
  if (labels[V3_UID_LABEL_KEY] !== String(uid)) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists but belongs to uid=${labels[V3_UID_LABEL_KEY]}, expected ${uid}`,
    );
  }
  const opts = (info as { Options?: Record<string, string> | null }).Options;
  if (opts && typeof opts === "object" && Object.keys(opts).length > 0) {
    throw new SupervisorError(
      "InvalidArgument",
      `volume ${name} (${purpose}) exists with custom Options=${JSON.stringify(opts)}; refuse to adopt`,
    );
  }
}

export async function settleAllVolumesOrThrow(promises: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(promises);
  const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (firstRejected) throw firstRejected.reason;
}

export async function ensureProvisionVolumes(
  deps: V3SupervisorDeps,
  uid: number,
  useRemote: boolean,
  hostId: string | undefined,
): Promise<V3VolumeBundle> {
  const data = v3VolumeNameFor(uid);
  const projects = v3ProjectsVolumeNameFor(uid);
  const codex = v3CodexVolumeNameFor(uid);
  const userLocal = v3UserLocalVolumeNameFor(uid);
  const userConfig = v3UserConfigVolumeNameFor(uid);
  try {
    if (useRemote) {
      await settleAllVolumesOrThrow([
        deps.containerService!.ensureVolume(hostId!, data),
        deps.containerService!.ensureVolume(hostId!, projects),
        deps.containerService!.ensureVolume(hostId!, codex),
        deps.containerService!.ensureVolume(hostId!, userLocal),
        deps.containerService!.ensureVolume(hostId!, userConfig),
      ]);
    } else {
      await settleAllVolumesOrThrow([
        ensureSingleV3Volume(deps.docker, uid, data, "data"),
        ensureSingleV3Volume(deps.docker, uid, projects, "projects"),
        ensureSingleV3Volume(deps.docker, uid, codex, "codex"),
        ensureSingleV3Volume(deps.docker, uid, userLocal, "userLocal"),
        ensureSingleV3Volume(deps.docker, uid, userConfig, "userConfig"),
      ]);
    }
    return { data, projects, codex, userLocal, userConfig };
  } catch (err) {
    throw wrapDockerError(err);
  }
}

export async function removeV3Volume(deps: V3SupervisorDeps, uid: number): Promise<void> {
  const names = [
    v3VolumeNameFor(uid),
    v3ProjectsVolumeNameFor(uid),
    v3CodexVolumeNameFor(uid),
    v3UserLocalVolumeNameFor(uid),
    v3UserConfigVolumeNameFor(uid),
  ];

  if (!deps.containerService) {
    for (const name of names) {
      try {
        await deps.docker.getVolume(name).remove();
      } catch (err) {
        if (isNotFound(err)) continue;
        throw wrapDockerError(err);
      }
    }
    return;
  }

  const listFn = deps.listAllHosts ?? defaultListAllHosts;
  const hosts = await listFn();
  const targets = hosts.filter((h) => h.status === "ready" || h.status === "draining");
  const errors: Error[] = [];
  await Promise.all(
    targets.map(async (host) => {
      for (const name of names) {
        try {
          await deps.containerService!.removeVolume(host.id, name);
        } catch (err) {
          if (isNotFound(err)) continue;
          const detail = err instanceof Error ? err.message : String(err);
          errors.push(new Error(`host=${host.id}(${host.name}) volume=${name}: ${detail}`));
        }
      }
    }),
  );

  if (errors.length > 0) {
    throw new AggregateError(errors, `removeV3Volume failed for uid=${uid}`);
  }
}

async function tryMaterializeCodexBinding(
  deps: V3SupervisorDeps,
  uid: number,
  rowId: number,
  useRemote: boolean,
  hostId: string | undefined,
  codexContainerDir: string,
): Promise<bigint | null> {
  try {
    const picked = await pickCodexAccountForBinding(codexBindingAffinityKey(uid), {});
    if (!picked) return null;
    let snap: Awaited<ReturnType<typeof getCodexTokenSnapshot>> = null;
    try {
      snap = await getCodexTokenSnapshot(picked.account_id);
      if (!snap || !snap.token) return null;
      const accessToken = snap.token.toString("utf8");
      const lastRefreshIso = new Date().toISOString();
      if (useRemote) {
        if (!deps.putRemoteCodexAuth) {
          throw new Error("useRemote=true but deps.putRemoteCodexAuth not wired");
        }
        await deps.putRemoteCodexAuth(hostId!, String(rowId), accessToken, lastRefreshIso);
      } else {
        await writeCodexContainerAuthFile({
          rootDir: codexContainerDir,
          containerId: String(rowId),
          containerUid: V3_AGENT_UID,
          containerGid: V3_AGENT_GID,
          auth: { accessToken, lastRefreshIso },
        });
      }
      return picked.account_id;
    } finally {
      if (snap?.token) zeroBuffer(snap.token);
      if (snap?.refresh) zeroBuffer(snap.refresh);
    }
  } catch (codexErr) {
    console.error(
      `[v3supervisor] WARN: codex account binding failed (useRemote=${useRemote}); falling back: ${(codexErr as Error).message}`,
    );
    return null;
  }
}

export async function bindCodexAccountAndResolveMount(
  deps: V3SupervisorDeps,
  uid: number,
  rowId: number,
  useRemote: boolean,
  hostId: string | undefined,
  localCodexContainerDir: string,
): Promise<{ boundCodexAccountId: bigint | null; codexMountSource: string | null }> {
  const codexContainerDir = useRemote ? DEFAULT_V3_CODEX_CONTAINER_DIR : localCodexContainerDir;
  const boundCodexAccountId = await tryMaterializeCodexBinding(
    deps,
    uid,
    rowId,
    useRemote,
    hostId,
    codexContainerDir,
  );

  if (boundCodexAccountId !== null) {
    return {
      boundCodexAccountId,
      codexMountSource: pathJoin(codexContainerDir, String(rowId)),
    };
  }
  if (!useRemote && getRuntimeChannel() === "v5") {
    console.error(
      `[v3supervisor] WARN: v5 container ${String(rowId)} has no codex account binding; skipping legacy shared codex auth mount (fail-closed)`,
    );
    return { boundCodexAccountId: null, codexMountSource: null };
  }
  if (!useRemote) {
    try {
      await fsMkdir(codexContainerDir, { recursive: true, mode: 0o755 });
    } catch (mkErr) {
      console.error(
        `[v3supervisor] WARN: ensure codex container dir failed: ${(mkErr as Error).message}`,
      );
    }
    return { boundCodexAccountId: null, codexMountSource: codexContainerDir };
  }
  return { boundCodexAccountId: null, codexMountSource: null };
}

export interface AssembleContainerBindsInput {
  volumeNames: V3VolumeBundle;
  cc5Prepared: Cc5PreparedContainer | null;
  cursorAuthMount: string | null;
  codexMountSource: string | null;
  sshUserRunDir: string | null;
  baselineMounts: ResolvedCcbBaselineMounts | null;
  platformBinds: string[];
  syntheticEvalOverlay: ReturnType<SyntheticEvalOverlayRuntime["resolvePrepared"]>;
  syntheticEvalOverlayRuntime: SyntheticEvalOverlayRuntime | undefined;
  runtimeLabels: Record<string, string>;
}

export function assembleProvisionContainerBinds(input: AssembleContainerBindsInput): string[] {
  const binds: string[] = [
    `${input.volumeNames.data}:${V3_VOLUME_MOUNT}:rw`,
    `${input.volumeNames.projects}:${V3_PROJECTS_MOUNT}:rw`,
    `${input.volumeNames.codex}:${V3_CODEX_HOME_MOUNT}:rw`,
    `${input.volumeNames.userLocal}:${V3_USER_LOCAL_MOUNT}:rw`,
    `${input.volumeNames.userConfig}:${V3_USER_CONFIG_MOUNT}:rw`,
  ];
  if (input.cc5Prepared) {
    binds.push(`${input.cc5Prepared.mountSource}:/run/oc/cc5-remote-t1555u:ro`);
  }
  if (input.cursorAuthMount !== null) {
    binds.push(`${input.cursorAuthMount}:${V5_CURSOR_AUTH_RO_MOUNT}:ro`);
  }
  if (input.codexMountSource !== null) {
    binds.push(`${input.codexMountSource}:${V3_CODEX_AUTH_RO_MOUNT}:ro`);
  }
  if (input.sshUserRunDir) {
    binds.push(`${input.sshUserRunDir}:${V3_SSH_RUN_CONTAINER_MOUNT}:ro`);
  }
  if (input.baselineMounts) {
    binds.push(
      `${input.baselineMounts.agentsMdHostPath}:/opt/openclaude/AGENTS.md:ro`,
      `${input.baselineMounts.claudeMdHostPath}:${V3_CONFIG_TMPFS_PATH}/CLAUDE.md:ro`,
      `${input.baselineMounts.skillsDirHostPath}:${V3_CONFIG_TMPFS_PATH}/skills:ro`,
    );
  }
  if (input.platformBinds.length > 0) {
    binds.push(...input.platformBinds);
  }
  if (input.syntheticEvalOverlay) {
    binds.push(
      `${input.syntheticEvalOverlay.promptsHostPath}:${SYNTHETIC_EVAL_PROMPTS_BIND_TARGET}:ro`,
      `${input.syntheticEvalOverlay.promptSlotsHostPath}:${SYNTHETIC_EVAL_PROMPT_SLOTS_BIND_TARGET}:ro`,
    );
    Object.assign(
      input.runtimeLabels,
      input.syntheticEvalOverlayRuntime!.labels(input.syntheticEvalOverlay),
    );
  }
  return binds;
}
