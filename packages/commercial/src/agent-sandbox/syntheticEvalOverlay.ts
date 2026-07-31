/**
 * V5 exact-prompt evaluation overlay.
 *
 * This module is deliberately pure. The production filesystem adapter lives in
 * syntheticEvalOverlayRuntime.ts; keeping parsing/state transitions here makes
 * the fail-closed contract independently testable.
 */

export const SYNTHETIC_EVAL_UIDS = [247, 626] as const;
export const SYNTHETIC_EVAL_SCHEMA_VERSION = 1;
export const SYNTHETIC_EVAL_MAX_LIFETIME_MS = 1_500_000;

export const SYNTHETIC_EVAL_MANIFEST_LABEL =
  "openclaude.synthetic-eval.manifest-sha";
export const SYNTHETIC_EVAL_NONCE_LABEL =
  "openclaude.synthetic-eval.nonce";
export const SYNTHETIC_EVAL_UID_LABEL =
  "openclaude.synthetic-eval.uid";

export const SYNTHETIC_EVAL_PROMPTS_TARGET =
  "/run/oc/synthetic-eval/prompts";
export const SYNTHETIC_EVAL_PROMPT_SLOTS_TARGET =
  "/opt/openclaude/packages/gateway/src/promptSlots.ts";

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

export interface SyntheticEvalManifest {
  schemaVersion: 1;
  baseCommit: string;
  candidateCommit: string;
  files: {
    promptsTree: string;
    promptSlots: string;
    agents: string;
    claude: string;
    skillsTree: string;
  };
}

export interface SyntheticEvalRecord {
  schemaVersion: 1;
  state: "prepared" | "active";
  uid: (typeof SYNTHETIC_EVAL_UIDS)[number];
  nonce: string;
  manifestSha: string;
  preparedAt: string;
  expiresAt: string;
  containerId?: string;
}

export interface SyntheticEvalOverlaySpec {
  uid: (typeof SYNTHETIC_EVAL_UIDS)[number];
  nonce: string;
  manifestSha: string;
  candidateTreePath: string;
  promptsHostPath: string;
  promptSlotsHostPath: string;
  baselineHostPath: string;
}

export type SyntheticEvalContainerState =
  | { mode: "standard" }
  | { mode: "valid"; record: SyntheticEvalRecord }
  | { mode: "stale"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

export function isSyntheticEvalUid(
  uid: number,
): uid is (typeof SYNTHETIC_EVAL_UIDS)[number] {
  return SYNTHETIC_EVAL_UIDS.includes(uid as (typeof SYNTHETIC_EVAL_UIDS)[number]);
}

export function parseSyntheticEvalManifest(value: unknown): SyntheticEvalManifest {
  if (!isRecord(value) || !exactKeys(value, [
    "baseCommit",
    "candidateCommit",
    "files",
    "schemaVersion",
  ])) {
    throw new Error("synthetic eval manifest shape is invalid");
  }
  if (value.schemaVersion !== SYNTHETIC_EVAL_SCHEMA_VERSION) {
    throw new Error("synthetic eval manifest schemaVersion is invalid");
  }
  if (
    typeof value.baseCommit !== "string"
    || !GIT_COMMIT_RE.test(value.baseCommit)
    || typeof value.candidateCommit !== "string"
    || !GIT_COMMIT_RE.test(value.candidateCommit)
  ) {
    throw new Error("synthetic eval manifest commits are invalid");
  }
  if (!isRecord(value.files) || !exactKeys(value.files, [
    "agents",
    "claude",
    "promptSlots",
    "promptsTree",
    "skillsTree",
  ])) {
    throw new Error("synthetic eval manifest files are invalid");
  }
  for (const [name, digest] of Object.entries(value.files)) {
    if (typeof digest !== "string" || !SHA256_RE.test(digest)) {
      throw new Error(`synthetic eval manifest digest ${name} is invalid`);
    }
  }
  return value as unknown as SyntheticEvalManifest;
}

export function parseSyntheticEvalRecord(
  value: unknown,
  nowMs = Date.now(),
): SyntheticEvalRecord {
  if (!isRecord(value)) throw new Error("synthetic eval active record is invalid");
  const required = [
    "expiresAt",
    "manifestSha",
    "nonce",
    "preparedAt",
    "schemaVersion",
    "state",
    "uid",
  ];
  const expected = value.state === "active" ? [...required, "containerId"] : required;
  if (!exactKeys(value, expected)) {
    throw new Error("synthetic eval active record shape is invalid");
  }
  if (value.schemaVersion !== SYNTHETIC_EVAL_SCHEMA_VERSION) {
    throw new Error("synthetic eval active record schemaVersion is invalid");
  }
  if (
    typeof value.uid !== "number"
    || !isSyntheticEvalUid(value.uid)
    || typeof value.nonce !== "string"
    || !NONCE_RE.test(value.nonce)
    || typeof value.manifestSha !== "string"
    || !SHA256_RE.test(value.manifestSha)
  ) {
    throw new Error("synthetic eval active record identity is invalid");
  }
  if (value.state !== "prepared" && value.state !== "active") {
    throw new Error("synthetic eval active record state is invalid");
  }
  if (
    value.state === "active"
    && (typeof value.containerId !== "string" || !/^[0-9a-f]{64}$/.test(value.containerId))
  ) {
    throw new Error("synthetic eval active record containerId is invalid");
  }
  const preparedAt = Date.parse(value.preparedAt as string);
  const expiresAt = Date.parse(value.expiresAt as string);
  if (
    !Number.isFinite(preparedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= preparedAt
    || expiresAt - preparedAt > SYNTHETIC_EVAL_MAX_LIFETIME_MS
    || nowMs < preparedAt - 60_000
    || nowMs >= expiresAt
  ) {
    throw new Error("synthetic eval active record time window is invalid");
  }
  return value as unknown as SyntheticEvalRecord;
}

export function activateSyntheticEvalRecord(
  record: SyntheticEvalRecord,
  containerId: string,
): SyntheticEvalRecord {
  if (record.state !== "prepared") {
    throw new Error("synthetic eval record is not prepared");
  }
  if (!/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error("synthetic eval containerId is invalid");
  }
  return { ...record, state: "active", containerId };
}

function overlayLabels(
  labels: Record<string, string> | undefined,
): { manifestSha?: string; nonce?: string; uid?: string; any: boolean } {
  const manifestSha = labels?.[SYNTHETIC_EVAL_MANIFEST_LABEL];
  const nonce = labels?.[SYNTHETIC_EVAL_NONCE_LABEL];
  const uid = labels?.[SYNTHETIC_EVAL_UID_LABEL];
  return {
    ...(manifestSha === undefined ? {} : { manifestSha }),
    ...(nonce === undefined ? {} : { nonce }),
    ...(uid === undefined ? {} : { uid }),
    any: manifestSha !== undefined || nonce !== undefined || uid !== undefined,
  };
}

/**
 * Decide whether a running container may be reused.
 *
 * A valid prepared/active record makes an unlabeled stable container stale so
 * ensureRunning will rebuild it with the requested overlay. Any orphan/partial
 * label is also stale. Real user UIDs never consult or honor an overlay record.
 */
export function classifySyntheticEvalContainer(
  uid: number,
  labels: Record<string, string> | undefined,
  record: SyntheticEvalRecord | null,
  containerId?: string,
): SyntheticEvalContainerState {
  const current = overlayLabels(labels);
  if (!isSyntheticEvalUid(uid)) {
    return current.any
      ? { mode: "stale", reason: "overlay label on non-synthetic uid" }
      : { mode: "standard" };
  }
  const applicable = record?.uid === uid ? record : null;
  if (!current.any) {
    return applicable
      ? { mode: "stale", reason: "synthetic overlay record requires reprovision" }
      : { mode: "standard" };
  }
  if (
    !current.manifestSha
    || !current.nonce
    || !current.uid
    || !applicable
    || applicable.state !== "active"
    || applicable.containerId !== containerId
    || current.manifestSha !== applicable.manifestSha
    || current.nonce !== applicable.nonce
    || current.uid !== String(uid)
  ) {
    return { mode: "stale", reason: "synthetic overlay labels do not match active record" };
  }
  return { mode: "valid", record: applicable };
}

export function syntheticEvalOverlayLabels(
  spec: SyntheticEvalOverlaySpec,
): Record<string, string> {
  return {
    [SYNTHETIC_EVAL_MANIFEST_LABEL]: spec.manifestSha,
    [SYNTHETIC_EVAL_NONCE_LABEL]: spec.nonce,
    [SYNTHETIC_EVAL_UID_LABEL]: String(spec.uid),
  };
}
