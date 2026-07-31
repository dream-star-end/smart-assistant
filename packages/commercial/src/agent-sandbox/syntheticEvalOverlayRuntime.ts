import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  activateSyntheticEvalRecord,
  classifySyntheticEvalContainer,
  isSyntheticEvalUid,
  parseSyntheticEvalManifest,
  parseSyntheticEvalRecord,
  SYNTHETIC_EVAL_PROMPT_SLOTS_TARGET,
  SYNTHETIC_EVAL_PROMPTS_TARGET,
  syntheticEvalOverlayLabels,
  type SyntheticEvalContainerState,
  type SyntheticEvalManifest,
  type SyntheticEvalOverlaySpec,
  type SyntheticEvalRecord,
} from "./syntheticEvalOverlay.js";

export const DEFAULT_SYNTHETIC_EVAL_RECORD_PATH =
  "/run/openclaude-v5/synthetic-eval-overlay-active.json";
export const DEFAULT_SYNTHETIC_EVAL_RECORD_LOCK_PATH =
  "/run/openclaude-v5/synthetic-eval-overlay.lock";
export const DEFAULT_SYNTHETIC_EVAL_RECORD_REAPER_PATH =
  "/run/openclaude-v5/synthetic-eval-overlay.lock.reaper";
export const DEFAULT_SYNTHETIC_EVAL_STAGING_ROOT =
  "/var/lib/openclaude-v5/synthetic-eval-overlay";

const PROMPTS_REL =
  "packages/commercial/agent-sandbox/platform-runtime/prompts";
const PROMPT_SLOTS_REL = "packages/gateway/src/promptSlots.ts";
const BASELINE_REL = "packages/commercial/agent-sandbox/ccb-baseline";
const AGENTS_REL = `${BASELINE_REL}/AGENTS.md`;
const CLAUDE_REL = `${BASELINE_REL}/CLAUDE.md`;
const SKILLS_REL = `${BASELINE_REL}/skills`;
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
const LOCK_NONCE_RE = /^[0-9a-f]{32}$/;
const RECORD_LOCK_MAX_AGE_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export interface SyntheticEvalOverlayRuntime {
  resolvePrepared(uid: number): SyntheticEvalOverlaySpec | null;
  activatePrepared(spec: SyntheticEvalOverlaySpec, containerId: string): void;
  classifyContainer(
    uid: number,
    labels: Record<string, string> | undefined,
    containerId?: string,
  ): SyntheticEvalContainerState;
  labels(spec: SyntheticEvalOverlaySpec): Record<string, string>;
}

export interface SyntheticEvalOverlayRuntimeOptions {
  activeRecordPath?: string;
  recordLockPath?: string;
  recordReaperPath?: string;
  stagingRoot?: string;
  expectedBaseCommit?: string;
  now?: () => number;
  warn?: (message: string, detail?: unknown) => void;
}

function assertAbsoluteConfiguredPath(path: string, name: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return path;
}

function assertRootOwnedSafe(path: string, kind: "file" | "dir"): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${path} must not be a symlink`);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`${path} has the wrong type`);
  }
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${path} must be root-owned and not group/other writable`);
  }
}

function assertWithin(path: string, ancestor: string): string {
  const real = realpathSync(path);
  const rel = relative(ancestor, real);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${path} escapes synthetic eval staging root`);
  }
  return real;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Stable full-tree digest over sorted `<file-sha>  <relative-path>\n` rows.
 * Every traversed node separately repeats the ownership/mode/symlink gate.
 */
export function sha256SyntheticEvalTree(root: string): string {
  const rootReal = realpathSync(root);
  assertRootOwnedSafe(root, "dir");
  const hash = createHash("sha256");
  const walk = (dir: string, relDir: string): void => {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const path = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`${path} must not be a symlink`);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        throw new Error(`${path} must be root-owned and not group/other writable`);
      }
      assertWithin(path, rootReal);
      if (stat.isDirectory()) {
        walk(path, rel);
      } else if (stat.isFile()) {
        hash.update(`${sha256File(path)}  ${rel}\n`);
      } else {
        throw new Error(`${path} must be a regular file or directory`);
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

export function readSyntheticEvalReleaseSourceCommit(
  applicationReleasePath: string | undefined,
): string | undefined {
  if (!applicationReleasePath) return undefined;
  const releasePath = assertAbsoluteConfiguredPath(
    applicationReleasePath,
    "synthetic eval application release path",
  );
  assertRootOwnedSafe(releasePath, "dir");
  const markerPath = join(releasePath, ".complete");
  const marker = readJsonFile(markerPath);
  if (
    typeof marker !== "object"
    || marker === null
    || !("sourceCommit" in marker)
    || typeof marker.sourceCommit !== "string"
    || !GIT_COMMIT_RE.test(marker.sourceCommit)
  ) {
    throw new Error("synthetic eval application release sourceCommit is invalid");
  }
  return marker.sourceCommit;
}

function readJsonFile(path: string, exactMode0600 = false): unknown {
  assertRootOwnedSafe(path, "file");
  const stat = lstatSync(path);
  if (exactMode0600 && (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${path} must have mode 0600`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function verifyManifestFiles(
  manifest: SyntheticEvalManifest,
  candidateTreePath: string,
): {
  promptsHostPath: string;
  promptSlotsHostPath: string;
  baselineHostPath: string;
} {
  const treeReal = realpathSync(candidateTreePath);
  assertRootOwnedSafe(candidateTreePath, "dir");
  const promptsHostPath = join(candidateTreePath, PROMPTS_REL);
  const promptSlotsHostPath = join(candidateTreePath, PROMPT_SLOTS_REL);
  const baselineHostPath = join(candidateTreePath, BASELINE_REL);
  const agentsPath = join(candidateTreePath, AGENTS_REL);
  const claudePath = join(candidateTreePath, CLAUDE_REL);
  const skillsPath = join(candidateTreePath, SKILLS_REL);

  for (const path of [promptsHostPath, baselineHostPath, skillsPath]) {
    assertRootOwnedSafe(path, "dir");
    assertWithin(path, treeReal);
  }
  for (const path of [promptSlotsHostPath, agentsPath, claudePath]) {
    assertRootOwnedSafe(path, "file");
    assertWithin(path, treeReal);
  }
  const actual = {
    promptsTree: sha256SyntheticEvalTree(promptsHostPath),
    promptSlots: sha256File(promptSlotsHostPath),
    agents: sha256File(agentsPath),
    claude: sha256File(claudePath),
    skillsTree: sha256SyntheticEvalTree(skillsPath),
  };
  for (const [name, digest] of Object.entries(actual)) {
    if (manifest.files[name as keyof typeof actual] !== digest) {
      throw new Error(`synthetic eval staged digest mismatch: ${name}`);
    }
  }
  return { promptsHostPath, promptSlotsHostPath, baselineHostPath };
}

function atomicWriteRecord(path: string, record: SyntheticEvalRecord): void {
  const parent = dirname(path);
  assertRootOwnedSafe(parent, "dir");
  const temp = join(
    parent,
    `.synthetic-eval-overlay.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    closeSync(fd);
    fd = null;
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // rename succeeded or temp was never created
    }
  }
}

interface SyntheticEvalRecordLockOwner {
  schemaVersion: 1;
  pid: number;
  processStartTime: string;
  bootId: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}

function readProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch {
    return null;
  }
}

function readBootId(): string {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f-]{36}$/.test(bootId)) {
    throw new Error("synthetic eval record lock boot id is invalid");
  }
  return bootId;
}

function parseRecordLockOwner(value: unknown): SyntheticEvalRecordLockOwner {
  if (!isRecord(value) || !exactKeys(value, [
    "bootId",
    "createdAt",
    "expiresAt",
    "nonce",
    "pid",
    "processStartTime",
    "schemaVersion",
  ])) {
    throw new Error("synthetic eval record lock owner shape is invalid");
  }
  const createdAt = Date.parse(value.createdAt as string);
  const expiresAt = Date.parse(value.expiresAt as string);
  if (
    value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.processStartTime !== "string"
    || !/^\d+$/.test(value.processStartTime)
    || typeof value.bootId !== "string"
    || !/^[0-9a-f-]{36}$/.test(value.bootId)
    || typeof value.nonce !== "string"
    || !LOCK_NONCE_RE.test(value.nonce)
    || !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= createdAt
    || expiresAt - createdAt > RECORD_LOCK_MAX_AGE_MS
  ) {
    throw new Error("synthetic eval record lock owner is invalid");
  }
  return value as unknown as SyntheticEvalRecordLockOwner;
}

export function createSyntheticEvalOverlayRuntime(
  options: SyntheticEvalOverlayRuntimeOptions = {},
): SyntheticEvalOverlayRuntime {
  const activeRecordPath = assertAbsoluteConfiguredPath(
    options.activeRecordPath ?? DEFAULT_SYNTHETIC_EVAL_RECORD_PATH,
    "synthetic eval active record path",
  );
  const recordLockPath = assertAbsoluteConfiguredPath(
    options.recordLockPath
      ?? (options.activeRecordPath
        ? `${activeRecordPath}.lock`
        : DEFAULT_SYNTHETIC_EVAL_RECORD_LOCK_PATH),
    "synthetic eval record lock path",
  );
  const recordReaperPath = assertAbsoluteConfiguredPath(
    options.recordReaperPath
      ?? (options.recordLockPath
        ? `${recordLockPath}.reaper`
        : DEFAULT_SYNTHETIC_EVAL_RECORD_REAPER_PATH),
    "synthetic eval record reaper path",
  );
  const stagingRoot = assertAbsoluteConfiguredPath(
    options.stagingRoot ?? DEFAULT_SYNTHETIC_EVAL_STAGING_ROOT,
    "synthetic eval staging root",
  );
  const expectedBaseCommit = options.expectedBaseCommit;
  if (
    expectedBaseCommit !== undefined
    && !GIT_COMMIT_RE.test(expectedBaseCommit)
  ) {
    throw new Error("synthetic eval expected base commit is invalid");
  }
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string, detail?: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(message, detail);
  });
  const withRecordLock = <T>(operation: (assertHeld: () => void) => T): T => {
    const parent = dirname(recordLockPath);
    assertRootOwnedSafe(parent, "dir");
    if (lstatExists(recordReaperPath)) {
      throw new Error("synthetic eval record lock is fenced by the official reaper");
    }
    const bootId = readBootId();
    const processStartTime = readProcessStartTime(process.pid);
    if (!processStartTime) {
      throw new Error("synthetic eval record lock cannot identify this process");
    }
    const createdAtMs = now();
    const owner: SyntheticEvalRecordLockOwner = {
      schemaVersion: 1,
      pid: process.pid,
      processStartTime,
      bootId,
      nonce: randomBytes(16).toString("hex"),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + RECORD_LOCK_MAX_AGE_MS).toISOString(),
    };
    const ownerBytes = `${JSON.stringify(owner)}\n`;
    const temporary = `${recordLockPath}.candidate.${process.pid}.${owner.nonce}`;
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      let fd: number | null = null;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, ownerBytes, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        chmodSync(temporary, 0o600);
        linkSync(temporary, recordLockPath);
        if (lstatExists(recordReaperPath)) {
          if (readFileSync(recordLockPath, "utf8") === ownerBytes) {
            unlinkSync(recordLockPath);
          }
          throw new Error("synthetic eval record lock is fenced by the official reaper");
        }
        acquired = true;
      } catch (error) {
        if (fd !== null) closeSync(fd);
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const stat = lstatSync(recordLockPath);
          if (stat.isFile() && !stat.isSymbolicLink()) {
            const current = parseRecordLockOwner(readJsonFile(recordLockPath, true));
            const stale =
              current.bootId !== bootId
              || readProcessStartTime(current.pid) !== current.processStartTime
              || now() >= Date.parse(current.expiresAt);
            throw new Error(
              stale
                ? "synthetic eval stale record lock requires official recovery"
                : "synthetic eval record lock is held by a live owner",
            );
          } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
            throw new Error(
              now() - stat.mtimeMs >= RECORD_LOCK_MAX_AGE_MS
                ? "synthetic eval stale record lock requires official recovery"
                : "synthetic eval record lock is held by a live owner",
            );
          } else {
            throw new Error("synthetic eval record lock has an unsafe type");
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw readError;
        }
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // link publication owns the remaining inode, or creation failed
        }
      }
    }
    if (!acquired) {
      throw new Error("synthetic eval record lock acquisition did not converge");
    }
    const assertHeld = (): void => {
      assertRootOwnedSafe(recordLockPath, "file");
      if (readFileSync(recordLockPath, "utf8") !== ownerBytes) {
        throw new Error("synthetic eval record lock ownership was lost");
      }
      if (
        readProcessStartTime(process.pid) !== processStartTime
        || now() >= Date.parse(owner.expiresAt)
      ) {
        throw new Error("synthetic eval record lock owner expired");
      }
    };
    try {
      assertHeld();
      return operation(assertHeld);
    } finally {
      assertHeld();
      unlinkSync(recordLockPath);
    }
  };

  const load = (): {
    record: SyntheticEvalRecord;
    manifest: SyntheticEvalManifest;
    spec: SyntheticEvalOverlaySpec;
  } | null => {
    try {
      const record = parseSyntheticEvalRecord(
        readJsonFile(activeRecordPath, true),
        now(),
      );
      const manifestDir = join(stagingRoot, record.manifestSha);
      const manifestPath = join(manifestDir, "manifest.json");
      assertRootOwnedSafe(stagingRoot, "dir");
      assertRootOwnedSafe(manifestDir, "dir");
      assertRootOwnedSafe(manifestPath, "file");
      const stagingReal = realpathSync(stagingRoot);
      assertWithin(manifestDir, stagingReal);
      assertWithin(manifestPath, stagingReal);
      const manifestBytes = readFileSync(manifestPath);
      if (createHash("sha256").update(manifestBytes).digest("hex") !== record.manifestSha) {
        throw new Error("synthetic eval manifest SHA does not match active record");
      }
      const manifest = parseSyntheticEvalManifest(
        JSON.parse(manifestBytes.toString("utf8")) as unknown,
      );
      if (
        expectedBaseCommit === undefined
        || manifest.baseCommit !== expectedBaseCommit
      ) {
        throw new Error("synthetic eval manifest baseCommit is not the running release");
      }
      const candidateTreePath = join(manifestDir, "tree");
      const verified = verifyManifestFiles(manifest, candidateTreePath);
      return {
        record,
        manifest,
        spec: {
          uid: record.uid,
          nonce: record.nonce,
          manifestSha: record.manifestSha,
          candidateTreePath,
          ...verified,
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn("[synthetic-eval-overlay] ignored invalid overlay state", {
          error: (error as Error).message,
        });
      }
      return null;
    }
  };

  return {
    resolvePrepared(uid) {
      if (!isSyntheticEvalUid(uid)) return null;
      const loaded = load();
      return loaded?.record.state === "prepared" && loaded.record.uid === uid
        ? loaded.spec
        : null;
    },
    activatePrepared(spec, containerId) {
      withRecordLock((assertHeld) => {
        const loaded = load();
        if (
          !loaded
          || loaded.record.state !== "prepared"
          || loaded.record.uid !== spec.uid
          || loaded.record.nonce !== spec.nonce
          || loaded.record.manifestSha !== spec.manifestSha
        ) {
          throw new Error("synthetic eval prepared record changed before activation");
        }
        assertHeld();
        atomicWriteRecord(
          activeRecordPath,
          activateSyntheticEvalRecord(loaded.record, containerId),
        );
      });
    },
    classifyContainer(uid, labels, containerId) {
      if (!isSyntheticEvalUid(uid)) {
        return classifySyntheticEvalContainer(uid, labels, null, containerId);
      }
      return classifySyntheticEvalContainer(
        uid,
        labels,
        load()?.record ?? null,
        containerId,
      );
    },
    labels: syntheticEvalOverlayLabels,
  };
}

export const SYNTHETIC_EVAL_PROMPTS_BIND_TARGET =
  SYNTHETIC_EVAL_PROMPTS_TARGET;
export const SYNTHETIC_EVAL_PROMPT_SLOTS_BIND_TARGET =
  SYNTHETIC_EVAL_PROMPT_SLOTS_TARGET;
