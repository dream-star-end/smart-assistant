// OCV5-308 offline operator. These primitives are not an activation approval.
import { constants as fsConstants } from "node:fs";
import { open, readFile, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import type { Client, PoolClient } from "pg";

export const COMMON_FENCE = "openclaude:v5:production-mutation-admission:v1";
export const LOCK_TABLES = [
  "model_catalog", "model_pricing", "model_aliases",
  "account_groups", "account_group_models", "model_visibility_grants",
] as const;
export const PRICE_BUSINESS_KEYS = [
  "display_name", "input_per_mtok", "output_per_mtok",
  "cache_read_per_mtok", "cache_write_per_mtok", "multiplier",
] as const;
type Database = Pick<Client | PoolClient, "query">;
export type JsonObject = Record<string, unknown>;

export function insist(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const object = value as JsonObject;
  return "{" + Object.keys(object).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function expectedVersion(value: unknown): number {
  insist(typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 2147483647, "NON_NULL_EXPECTED_VERSION_REQUIRED");
  return value;
}

// The CLI never falls back to app/deploy URLs or discovers an owner credential.
export function explicitOperatorDsn(env: NodeJS.ProcessEnv): string {
  const dsn = env.OC_V5_MODEL_RELEASE_DATABASE_URL;
  insist(typeof dsn === "string" && dsn.length > 0, "EXPLICIT_AUTHORIZED_OPERATOR_DSN_REQUIRED");
  const uri = new URL(dsn);
  insist(["postgres:", "postgresql:"].includes(uri.protocol) &&
    uri.hostname && uri.port && uri.pathname.length > 1 &&
    !uri.host.includes(","), "OPERATOR_DSN_EXPLICIT_SINGLE_PRIMARY_REQUIRED");
  for (const key of uri.searchParams.keys()) {
    insist(!["host", "hostaddr", "port", "service", "servicefile", "dbname", "options", "role", "search_path"].includes(key.toLowerCase()),
      "OPERATOR_DSN_ENDPOINT_OVERRIDE_REFUSED");
  }
  return dsn;
}

// O_NOFOLLOW and fstat inspect the opened file, not a prior pathname check.
export async function trustedRootFile(path: string, privateFile = true): Promise<Buffer> {
  const fd = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const s = await fd.stat();
    insist(s.isFile() && s.uid === 0 && (s.mode & 0o022) === 0 &&
      (!privateFile || (s.mode & 0o777) === 0o600), "ROOT_FILE_TYPE_OWNER_MODE_REQUIRED");
    return await fd.readFile();
  } finally {
    await fd.close();
  }
}
export async function primaryIdentity(db: Database): Promise<JsonObject> {
  const result = await db.query<{ identity: JsonObject }>(
    "SELECT json_build_object('clusterId', system_identifier::text, 'database', current_database(), " +
    "'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()), " +
    "'serverAddress', inet_server_addr()::text, 'serverPort', inet_server_port(), " +
    "'postmasterEpoch', extract(epoch FROM pg_postmaster_start_time())::text, " +
    "'inRecovery', pg_is_in_recovery()) AS identity FROM pg_control_system()");
  insist(result.rows.length === 1, "ONE_PRIMARY_IDENTITY_REQUIRED");
  const identity = result.rows[0].identity;
  insist(identity.inRecovery === false, "PRIMARY_NOT_RECOVERY_REQUIRED");
  return identity;
}
export interface LeasePaths {
  commonNonce: string;
  manualNonce: string;
  lock: string;
}
export const PRODUCTION_LEASE_PATHS: LeasePaths = {
  commonNonce: "/run/openclaude-v5/production-mutation.lock.admission-nonce",
  manualNonce: "/run/openclaude-v5/production-mutation.lock.manual-holder",
  lock: "/run/openclaude-v5/production-mutation.lock",
};

// Called only AFTER common PG lock and all mutation locks, before first DML.
// Pure file-path injection is for real private flock fixtures, never a CLI flag.
export async function verifyLocalLease(
  db: Database, nonce: string, paths: LeasePaths = PRODUCTION_LEASE_PATHS,
): Promise<JsonObject> {
  insist(process.geteuid?.() === 0, "COMMERCIAL_HOST_ROOT_REQUIRED");
  insist(/^[0-9a-f]{32}$/.test(nonce), "INVOCATION_NONCE_REQUIRED");
  const common = (await trustedRootFile(paths.commonNonce)).toString().trim();
  const manual = (await trustedRootFile(paths.manualNonce)).toString().trim();
  insist(common === nonce && manual === nonce, "STALE_INVOCATION_NONCE");
  const proof: JsonObject = JSON.parse(
    (await trustedRootFile(paths.commonNonce + ".db")).toString());
  insist(proof.schema === 1 && proof.nonce === nonce, "ADMISSION_PROOF_SCHEMA_NONCE");
  const pid = proof.holderPid;
  insist(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1,
    "HOLDER_PID_REQUIRED");
  insist(typeof proof.holderStart === "string" && /^[1-9][0-9]*$/.test(proof.holderStart),
    "HOLDER_START_REQUIRED");
  insist(typeof proof.expiresAt === "number" && Number.isSafeInteger(proof.expiresAt) &&
    Math.floor(Date.now() / 1000) < proof.expiresAt, "LEASE_EXPIRED");
  const kernel = await readFile("/proc/" + pid + "/stat", "utf8");
  const close = kernel.lastIndexOf(") ");
  insist(close > 0 && kernel.startsWith(String(pid) + " ("), "HOLDER_STAT_IDENTITY");
  const fields = kernel.slice(close + 2).trim().split(/\s+/);
  insist(!["Z", "X", "x", "T", "t"].includes(fields[0]) &&
    fields[19] === proof.holderStart, "HOLDER_DEAD_OR_REUSED");
  process.kill(pid, 0);
  const fd9 = await stat("/proc/" + pid + "/fd/9", { bigint: true });
  const lock = await stat(paths.lock, { bigint: true });
  insist(fd9.isFile() && fd9.dev === lock.dev && fd9.ino === lock.ino &&
    proof.lockDevIno === fd9.dev.toString() + ":" + fd9.ino.toString(),
    "HOLDER_FD9_LOCK_IDENTITY");
  const fdInfo = await readFile("/proc/" + pid + "/fdinfo/9", "utf8");
  insist(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(fdInfo),
    "HOLDER_FD9_ACTUAL_EXCLUSIVE_FLOCK_REQUIRED");
  const identity = await primaryIdentity(db);
  for (const [key, value] of Object.entries(identity)) {
    insist(canonical(proof[key]) === canonical(value), "PROOF_PRIMARY_IDENTITY_MISMATCH");
  }
  // Fresh nonce reread catches replacement during the identity/proc reads.
  insist((await trustedRootFile(paths.commonNonce)).toString().trim() === nonce &&
    (await trustedRootFile(paths.manualNonce)).toString().trim() === nonce,
    "INVOCATION_REPLACED_DURING_QUALIFICATION");
  return proof;
}

// No LOCK or mutating function call is used in the read-only permission probe.
export async function permissionPreflight(db: Database): Promise<JsonObject> {
  const tableNeeds: Array<[string, string]> = LOCK_TABLES.map((table) => [table, "UPDATE"]);
  tableNeeds.push(["deploy_state", "UPDATE"], ["model_pricing", "UPDATE"], ["admin_audit", "INSERT"]);
  for (const table of [...LOCK_TABLES, "deploy_state", "model_security_epoch", "admin_audit"]) {
    tableNeeds.push([table, "SELECT"]);
  }
  const denied: string[] = [];
  for (const [table, privilege] of tableNeeds) {
    const result = await db.query<{ ok: boolean }>(
      "SELECT has_table_privilege(current_user,$1,$2) AS ok", [table, privilege]);
    if (result.rows[0]?.ok !== true) denied.push(table + ":" + privilege);
  }
  for (const signature of [
    "pg_catalog.pg_control_system()",
    "fn_model_activate_entry(bigint,integer,bigint)",
    "fn_model_disable_entry(bigint,integer,bigint)",
    "fn_model_switch_version(text,text,text,text,integer,jsonb,integer,bigint,integer)",
  ]) {
    const result = await db.query<{ ok: boolean }>(
      "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS ok", [signature]);
    if (result.rows[0]?.ok !== true) denied.push(signature);
  }
  const sequence = await db.query<{ ok: boolean }>(
    "SELECT has_sequence_privilege(current_user,'admin_audit_id_seq','USAGE') AS ok");
  if (sequence.rows[0]?.ok !== true) denied.push("admin_audit_id_seq:USAGE");
  const identity = await db.query<{ current_user: string; session_user: string }>(
    "SELECT current_user,session_user");
  insist(denied.length === 0, "OPERATOR_PRIVILEGES_INSUFFICIENT:" + denied.join(","));
  return identity.rows[0];
}

export function validateRunId(runId: string): void {
  insist(/^[a-zA-Z0-9_-]{8,80}$/.test(runId), "RUN_ID_REQUIRED");
}
export async function writeLocks(db: Database, runId: string): Promise<void> {
  validateRunId(runId);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [COMMON_FENCE]);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    ["openclaude:v5:ocv5-308:run:" + runId]);
  const state = await db.query("SELECT singleton FROM deploy_state WHERE singleton FOR UPDATE");
  insist(state.rows.length === 1, "DEPLOY_STATE_SINGLETON_REQUIRED");
  for (const table of LOCK_TABLES) {
    await db.query("LOCK TABLE " + table + " IN SHARE ROW EXCLUSIVE MODE");
  }
}

// Session locks are acquired BEFORE RR BEGIN, never after a snapshot SELECT.
export async function reconciliationLocks(db: Database, runId: string): Promise<void> {
  validateRunId(runId);
  await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [COMMON_FENCE]);
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))",
      ["openclaude:v5:ocv5-308:run:" + runId]);
  } catch (error) {
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [COMMON_FENCE]);
    throw error;
  }
}
export async function releaseReconciliationLocks(db: Database, runId: string): Promise<void> {
  try {
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
      ["openclaude:v5:ocv5-308:run:" + runId]);
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [COMMON_FENCE]);
  }
}

export interface ReleaseIdentity {
  active_release: string;
  generation: string;
  lock_version: string;
  sourceCommit: string;
  metadataSha256: string;
  markerSha256: string;
}
// Metadata is locally read from the locked DS row's exact immutable release.
// Approved compatibility/runtime/upstream evidence is a separate required input.
export async function releaseIdentity(
  db: Database, releasesRoot = "/opt/openclaude/openclaude-v5-releases",
): Promise<ReleaseIdentity> {
  const result = await db.query<{
    phase: string; active_release: string; generation: string; lock_version: string;
  }>("SELECT phase,active_release,generation::text,lock_version::text FROM deploy_state WHERE singleton");
  insist(result.rows.length === 1 && result.rows[0].phase === "stable", "STABLE_RELEASE_REQUIRED");
  const state = result.rows[0];
  insist(typeof state.active_release === "string" &&
    resolve(state.active_release).startsWith(resolve(releasesRoot) + "/") &&
    await realpath(state.active_release) === resolve(state.active_release), "TRUSTED_RELEASE_PATH");
  const markerBytes = await trustedRootFile(join(state.active_release, ".complete"), false);
  const metadata = await trustedRootFile(join(state.active_release, "deploy/v5/release-metadata.json"), false);
  const marker = JSON.parse(markerBytes.toString());
  insist(typeof marker.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(marker.sourceCommit) &&
    typeof marker.metadataSha256 === "string" && /^[0-9a-f]{64}$/.test(marker.metadataSha256) &&
    /^[0-9a-f]{64}$/.test(marker.artifactSha256), "STRONG_RELEASE_MARKER_REQUIRED");
  const metadataSha256 = createHash("sha256").update(metadata).digest("hex");
  insist(metadataSha256 === marker.metadataSha256, "RELEASE_METADATA_DIGEST_MISMATCH");
  const versionBytes = await trustedRootFile(join(state.active_release, "VERSION.json"), false);
  const version = JSON.parse(versionBytes.toString());
  const match = /^rel-([0-9a-f]{7,40})-([0-9]{8}-[0-9]{6})(?:-migrated)?$/.exec(basename(state.active_release));
  insist(match && marker.sourceCommit.startsWith(match[1]) &&
    marker.builtAt === match[2] && version.commit === match[1], "RELEASE_VERSION_IDENTITY");
  insist(/^[1-9][0-9]*$/.test(state.generation) &&
    /^[1-9][0-9]*$/.test(state.lock_version), "RELEASE_GENERATION_LOCK_IDENTITY");
  return {
    active_release: state.active_release, generation: state.generation,
    lock_version: state.lock_version, sourceCommit: marker.sourceCommit,
    metadataSha256, markerSha256: createHash("sha256").update(markerBytes).digest("hex"),
  };
}


export type Row = Record<string, any>;
export interface ModelManifest {
  new_models: Row[];
  existing_active_enabled: Array<{ catalog: Row; pricing: Row }>;
  standard_grok_target: { catalog: Row; pricing: Row };
  excluded_from_activation: string[];
}
export const PREPARE_VERSION = "0293_commercial_new_models_prepare";
export const CATALOG_BUSINESS_KEYS = [
  "model_id", "engine", "provider_id", "upstream_model_id", "context_window",
  "capability_profile", "capability_schema_version",
] as const;
const PRICING_BUSINESS_KEYS = [
  ...PRICE_BUSINESS_KEYS, "model_id", "enabled", "visibility", "sort_order",
  "default_effort", "min_plan_code", "promo_label", "extra_system_prompt",
] as const;
const GENERATED_KEYS = ["lock_version", "updated_at", "updated_by"] as const;
export interface Snapshot {
  tables: Record<string, Row[]>;
  epoch: string;
  prepareApplied: boolean;
}
export interface Observation {
  schema: 1;
  manifestSha256: string;
  release: ReleaseIdentity;
  primary: JsonObject;
  snapshot: Snapshot;
  snapshotSha256: string;
  prepareSqlSha256: string;
}
export interface Readiness {
  schema: 1;
  manifestSha256: string;
  sourceCommit: string;
  metadataSha256: string;
  prepareSqlSha256: string;
  runtimeReady: true;
  credentialsReady: true;
  compatibilityReady: true;
  evidenceSha256: string[];
}
export interface OperatorContext {
  manifest: ModelManifest;
  prepareSqlSha256: string;
  releasesRoot?: string; // Only direct private-test callers inject paths.
  leasePaths?: LeasePaths;
}
export interface WriteRequest {
  runId: string;
  nonce: string;
  observation: Observation;
  readiness: Readiness;
}
export interface Receipt {
  schema: 1;
  operation: "activate" | "compensate";
  runId: string;
  requestSha256: string;
  manifestSha256: string;
  release: ReleaseIdentity;
  primary: JsonObject;
  before: Snapshot;
  after: Snapshot;
  afterSha256: string;
  activationRunId?: string;
}
export class CommitUnknown extends Error {
  constructor(public readonly runId: string, public readonly requestSha256: string) {
    super("COMMIT_UNKNOWN_RECONCILE_ONLY");
  }
}
function pick(row: Row, keys: readonly string[]): Row {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}
function without(row: Row, keys: readonly string[]): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}
function same(a: unknown, b: unknown, code: string): void {
  insist(canonical(a) === canonical(b), code);
}
function one(rows: Row[], predicate: (row: Row) => boolean, code: string): Row {
  const found = rows.filter(predicate);
  insist(found.length === 1, code);
  return found[0];
}
function active(snapshot: Snapshot, modelId: string): Row {
  return one(snapshot.tables.model_catalog, (row) => row.model_id === modelId &&
    row.state === "active", "ONE_ACTIVE_ENTRY_REQUIRED:" + modelId);
}
function price(snapshot: Snapshot, modelId: string): Row {
  return one(snapshot.tables.model_pricing, (row) => row.model_id === modelId,
    "ONE_PRICE_REQUIRED:" + modelId);
}
export function validateManifest(manifest: ModelManifest): void {
  const ids = manifest.new_models.map((row) => row.model_id);
  insist(ids.length === 17 && new Set(ids).size === 17 &&
    ids.every((id) => typeof id === "string" && /^[a-zA-Z0-9._-]+$/.test(id)),
    "EXACT_SEVENTEEN_NEW_MODELS_REQUIRED");
  insist(manifest.existing_active_enabled.length === 34 &&
    new Set(manifest.existing_active_enabled.map((row) => row.catalog.model_id)).size === 34,
    "EXACT_OLD_THIRTY_FOUR_REQUIRED");
  same(manifest.excluded_from_activation, ["gpt-6-astra-1m"], "ASTRA_EXCLUSION_REQUIRED");
  insist(!ids.includes("grok-build") && !ids.includes("gpt-6-astra-1m") &&
    manifest.standard_grok_target.catalog.model_id === "grok-build" &&
    manifest.standard_grok_target.catalog.upstream_model_id === "grok-4.7" &&
    Number(manifest.standard_grok_target.pricing.multiplier) === 2,
    "FROZEN_STANDARD_GROK_TARGET_REQUIRED");
}
export async function readSnapshot(db: Database): Promise<Snapshot> {
  const tables: Record<string, Row[]> = {};
  const order: Record<string, string> = {
    model_catalog: "entry_id", model_pricing: "model_id", model_aliases: "alias",
    account_groups: "id", account_group_models: "group_id,model_id",
    model_visibility_grants: "user_id,model_id",
  };
  for (const table of LOCK_TABLES) {
    const result = await db.query<{ rows: Row[] }>(
      "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY " + order[table] +
      "),'[]'::jsonb) AS rows FROM " + table + " t");
    tables[table] = result.rows[0].rows;
  }
  const epoch = await db.query<{ epoch: string }>(
    "SELECT epoch::text FROM model_security_epoch WHERE id");
  insist(epoch.rows.length === 1, "ONE_SECURITY_EPOCH_REQUIRED");
  const prepared = await db.query("SELECT 1 FROM schema_migrations WHERE version=$1",
    [PREPARE_VERSION]);
  return { tables, epoch: epoch.rows[0].epoch, prepareApplied: prepared.rowCount === 1 };
}
export function assertPrepared(snapshot: Snapshot, manifest: ModelManifest): void {
  validateManifest(manifest);
  insist(snapshot.prepareApplied, "PREPARATION_MIGRATION_LEDGER_REQUIRED");
  const ids = manifest.new_models.map((row) => row.model_id);
  for (const spec of manifest.new_models) {
    const row = one(snapshot.tables.model_catalog, (item) => item.model_id === spec.model_id,
      "ONE_PREPARED_ENTRY_REQUIRED:" + spec.model_id);
    insist(row.state === "staged", "NEW_MODEL_MUST_BE_STAGED:" + spec.model_id);
    expectedVersion(row.lock_version);
    same(pick(row, CATALOG_BUSINESS_KEYS), pick(spec, CATALOG_BUSINESS_KEYS),
      "PREPARED_DESCRIPTOR_DRIFT:" + spec.model_id);
    const pricing = price(snapshot, spec.model_id);
    expectedVersion(pricing.lock_version);
    same(pick(pricing, [...PRICE_BUSINESS_KEYS, "sort_order", "default_effort"]),
      pick(spec, [...PRICE_BUSINESS_KEYS, "sort_order", "default_effort"]),
      "PREPARED_PRICE_DRIFT:" + spec.model_id);
    insist(pricing.enabled === false && pricing.visibility === "public" &&
      pricing.min_plan_code === null, "PREPARED_VISIBILITY_DRIFT:" + spec.model_id);
    const donors = snapshot.tables.account_groups.filter((group) =>
      group.enabled === true && group.provider === spec.group_provider &&
      group.kind === "official_oauth" &&
      snapshot.tables.account_group_models.some((binding) =>
        binding.group_id === group.id && binding.model_id === spec.group_donor));
    insist(donors.length > 0 && donors.some((group) =>
      snapshot.tables.account_group_models.some((binding) =>
        binding.group_id === group.id && binding.model_id === spec.group_key)),
      "LIVE_COMMERCIAL_DONOR_BINDING_REQUIRED:" + spec.model_id);
  }
  insist(snapshot.tables.model_visibility_grants.every((row) => !ids.includes(row.model_id)),
    "NEW_MODEL_UNEXPECTED_PERMISSION");
  const oldIds = manifest.existing_active_enabled.map((row) => row.catalog.model_id).sort();
  same(snapshot.tables.model_pricing.filter((row) => row.enabled === true &&
    snapshot.tables.model_catalog.some((entry) => entry.model_id === row.model_id &&
      entry.state === "active")).map((row) => row.model_id).sort(),
    oldIds, "FROZEN_OLD_AVAILABILITY_DRIFT");
  for (const old of manifest.existing_active_enabled) {
    same(pick(active(snapshot, old.catalog.model_id), CATALOG_BUSINESS_KEYS),
      pick(old.catalog, CATALOG_BUSINESS_KEYS), "FROZEN_OLD_DESCRIPTOR_DRIFT:" + old.catalog.model_id);
    same(pick(price(snapshot, old.catalog.model_id), PRICING_BUSINESS_KEYS),
      pick(old.pricing, PRICING_BUSINESS_KEYS), "FROZEN_OLD_PRICE_OR_PERMISSION_DRIFT:" + old.catalog.model_id);
  }
  insist(price(snapshot, "gpt-6-astra-1m").enabled === false &&
    snapshot.tables.model_catalog.every((row) =>
      row.model_id !== "gpt-6-astra-1m" || row.state !== "active"), "ASTRA_MUST_REMAIN_DISABLED");
}
function validateReadiness(observation: Observation, ready: Readiness): void {
  insist(ready.schema === 1 && ready.runtimeReady === true && ready.credentialsReady === true &&
    ready.compatibilityReady === true && Array.isArray(ready.evidenceSha256) &&
    ready.evidenceSha256.length > 0 && ready.evidenceSha256.every((sha) =>
      typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)), "APPROVED_READINESS_EVIDENCE_REQUIRED");
  same(pick(ready, ["manifestSha256", "sourceCommit", "metadataSha256", "prepareSqlSha256"]),
    { manifestSha256: observation.manifestSha256, sourceCommit: observation.release.sourceCommit,
      metadataSha256: observation.release.metadataSha256, prepareSqlSha256: observation.prepareSqlSha256 },
    "READINESS_RELEASE_MANIFEST_BINDING");
}
export async function observe(db: Database, context: OperatorContext): Promise<Observation> {
  validateManifest(context.manifest);
  await permissionPreflight(db);
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const release = await releaseIdentity(db, context.releasesRoot);
    const snapshot = await readSnapshot(db);
    assertPrepared(snapshot, context.manifest);
    const observation: Observation = { schema: 1, manifestSha256: digest(context.manifest),
      release, primary: await primaryIdentity(db), snapshot, snapshotSha256: digest(snapshot),
      prepareSqlSha256: context.prepareSqlSha256 };
    await db.query("COMMIT");
    return observation;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
async function storedReceipt(db: Database, runId: string): Promise<Receipt | undefined> {
  validateRunId(runId);
  const result = await db.query<{ after: Receipt }>(
    "SELECT after FROM admin_audit WHERE action=$1 AND target=$2 ORDER BY id",
    ["ocv5-308.model-release", runId]);
  insist(result.rows.length <= 1, "DUPLICATE_RUN_RECEIPT");
  return result.rows[0]?.after;
}
function requestDigest(request: WriteRequest, operation: string, activationRunId?: string): string {
  // Lease nonce may legitimately differ on an explicit receipt reconciliation.
  return digest({ operation, runId: request.runId, observation: request.observation,
    readiness: request.readiness, ...(activationRunId ? { activationRunId } : {}) });
}
async function qualify(db: Database, context: OperatorContext, request: WriteRequest): Promise<void> {
  validateRunId(request.runId);
  insist(request.observation.schema === 1, "OBSERVATION_SCHEMA_REQUIRED");
  same(digest(context.manifest), request.observation.manifestSha256, "MANIFEST_DRIFT");
  same(context.prepareSqlSha256, request.observation.prepareSqlSha256, "PREPARATION_SQL_DRIFT");
  same(digest(request.observation.snapshot), request.observation.snapshotSha256, "OBSERVATION_DIGEST");
  validateReadiness(request.observation, request.readiness);
  await writeLocks(db, request.runId);
  await verifyLocalLease(db, request.nonce, context.leasePaths);
  same(await primaryIdentity(db), request.observation.primary, "OBSERVED_PRIMARY_CAS_CONFLICT");
  same(await releaseIdentity(db, context.releasesRoot), request.observation.release,
    "LIVE_RELEASE_CAS_CONFLICT");
}
async function switchGrok(db: Database, catalog: Row, expected: Row): Promise<void> {
  await db.query("SELECT fn_model_switch_version($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)",
    ["grok-build", catalog.engine, catalog.provider_id, catalog.upstream_model_id,
      catalog.context_window, JSON.stringify(catalog.capability_profile),
      catalog.capability_schema_version, 1, expectedVersion(expected.lock_version)]);
}
async function setGrokPrice(db: Database, target: Row, before: Row): Promise<void> {
  const expected = expectedVersion(before.lock_version);
  const params = PRICE_BUSINESS_KEYS.map((key) => target[key]);
  const result = await db.query(
    "UPDATE model_pricing SET " +
    PRICE_BUSINESS_KEYS.map((key, i) => key + "=$" + (i + 1)).join(",") +
    ",lock_version=lock_version+1,updated_by=1,updated_at=now() " +
    "WHERE model_id='grok-build' AND lock_version=$7 RETURNING model_id",
    [...params, expected]);
  insist(result.rowCount === 1, "STANDARD_GROK_PRICING_CAS_CONFLICT");
}
function assertTransition(
  before: Snapshot, after: Snapshot, manifest: ModelManifest, activation: boolean,
): void {
  const ids = manifest.new_models.map((row) => row.model_id);
  const changedIds = [...ids, "grok-build"];
  for (const table of ["account_groups", "account_group_models", "model_visibility_grants"]) {
    same(before.tables[table], after.tables[table], "UNEXPECTED_PERMISSION_BINDING_CHANGE:" + table);
  }
  same(before.tables.model_catalog.filter((row) => !changedIds.includes(row.model_id)),
    after.tables.model_catalog.filter((row) => !changedIds.includes(row.model_id)),
    "OLD_CATALOG_CHANGED");
  same(before.tables.model_pricing.filter((row) => !changedIds.includes(row.model_id)),
    after.tables.model_pricing.filter((row) => !changedIds.includes(row.model_id)),
    "OLD_PRICE_CHANGED");
  for (const spec of manifest.new_models) {
    const old = one(before.tables.model_catalog, (row) => row.model_id === spec.model_id,
      "ONE_NEW_ENTRY_BEFORE");
    const now = one(after.tables.model_catalog, (row) => row.model_id === spec.model_id,
      "ONE_NEW_ENTRY_AFTER");
    same(without(now, ["state", ...GENERATED_KEYS]), without(old, ["state", ...GENERATED_KEYS]),
      "NEW_DESCRIPTOR_MUTATED");
    insist(now.state === (activation ? "active" : "disabled") &&
      now.lock_version === old.lock_version + 1, "NEW_STATE_VERSION_POSTCONDITION");
    const oldPrice = price(before, spec.model_id), newPrice = price(after, spec.model_id);
    same(without(oldPrice, ["enabled", ...GENERATED_KEYS]),
      without(newPrice, ["enabled", ...GENERATED_KEYS]), "NEW_PRICE_MUTATED");
    insist(newPrice.enabled === activation, "NEW_ENABLED_POSTCONDITION");
  }
  const oldGrok = active(before, "grok-build"), newGrok = active(after, "grok-build");
  insist(newGrok.entry_id !== oldGrok.entry_id, "NEW_GROK_VERSION_REQUIRED");
  const retired = one(after.tables.model_catalog, (row) => row.entry_id === oldGrok.entry_id,
    "OLD_GROK_HISTORY_MISSING");
  insist(retired.state === "retired", "OLD_GROK_MUST_RETIRE");
  same(pick(retired, CATALOG_BUSINESS_KEYS), pick(oldGrok, CATALOG_BUSINESS_KEYS),
    "OLD_GROK_HISTORY_MUTATED");
  same(before.tables.model_catalog.filter((row) => row.model_id === "grok-build" &&
    row.entry_id !== oldGrok.entry_id),
    after.tables.model_catalog.filter((row) => row.model_id === "grok-build" &&
      row.entry_id !== oldGrok.entry_id && row.entry_id !== newGrok.entry_id),
    "OTHER_GROK_HISTORY_MUTATED");
  const grokTarget = activation ? manifest.standard_grok_target :
    manifest.existing_active_enabled.find((row) => row.catalog.model_id === "grok-build")!;
  same(pick(newGrok, CATALOG_BUSINESS_KEYS), pick(grokTarget.catalog, CATALOG_BUSINESS_KEYS),
    "GROK_TARGET_DESCRIPTOR_POSTCONDITION");
  same(pick(price(after, "grok-build"), PRICE_BUSINESS_KEYS),
    pick(grokTarget.pricing, PRICE_BUSINESS_KEYS), "GROK_TARGET_PRICE_POSTCONDITION");
  same(without(price(before, "grok-build"), [...PRICE_BUSINESS_KEYS, ...GENERATED_KEYS]),
    without(price(after, "grok-build"), [...PRICE_BUSINESS_KEYS, ...GENERATED_KEYS]),
    "GROK_NON_ALLOWLIST_PRICE_FIELD_CHANGED");
  const oldAliases = before.tables.model_aliases;
  const newAliases = after.tables.model_aliases;
  insist(oldAliases.length === newAliases.length, "ALIAS_COUNT_CHANGED");
  for (let i = 0; i < oldAliases.length; ++i) {
    if (oldAliases[i].entry_id === oldGrok.entry_id) {
      insist(newAliases[i].entry_id === newGrok.entry_id, "GROK_ALIAS_NOT_RETARGETED");
      same(without(oldAliases[i], ["entry_id", ...GENERATED_KEYS]),
        without(newAliases[i], ["entry_id", ...GENERATED_KEYS]), "GROK_ALIAS_SEMANTIC_CHANGE");
    } else same(oldAliases[i], newAliases[i], "OTHER_ALIAS_CHANGED");
  }
  insist(after.prepareApplied && BigInt(after.epoch) > BigInt(before.epoch),
    "SECURITY_EPOCH_POSTCONDITION");
  insist(price(after, "gpt-6-astra-1m").enabled === false, "ASTRA_REACTIVATED");
}
async function auditReceipt(db: Database, receipt: Receipt): Promise<void> {
  await db.query("INSERT INTO admin_audit(admin_id,action,target,before,after) " +
    "VALUES(1,$1,$2,$3::jsonb,$4::jsonb)",
    ["ocv5-308.model-release", receipt.runId, JSON.stringify(receipt.before), JSON.stringify(receipt)]);
}
export async function apply(
  db: Database, context: OperatorContext, request: WriteRequest,
): Promise<Receipt> {
  await permissionPreflight(db);
  await db.query("BEGIN");
  let committing = false;
  const requestSha256 = requestDigest(request, "activate");
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'");
    await qualify(db, context, request);
    const replay = await storedReceipt(db, request.runId);
    if (replay) {
      insist(replay.operation === "activate" && replay.requestSha256 === requestSha256,
        "RUN_ID_PAYLOAD_CONFLICT");
      same(await readSnapshot(db), replay.after, "COMMITTED_POSTSTATE_DRIFT");
      await db.query("ROLLBACK");
      return replay;
    }
    const before = await readSnapshot(db);
    same(before, request.observation.snapshot, "OBSERVED_STATE_CAS_CONFLICT");
    assertPrepared(before, context.manifest);
    for (const spec of [...context.manifest.new_models].sort((a,b) =>
      a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0)) {
      const entry = one(before.tables.model_catalog, (row) => row.model_id === spec.model_id,
        "ONE_STAGED_ENTRY_REQUIRED");
      await db.query("SELECT fn_model_activate_entry($1,$2,$3)",
        [entry.entry_id, expectedVersion(entry.lock_version), 1]);
    }
    const oldGrok = active(before, "grok-build");
    await switchGrok(db, context.manifest.standard_grok_target.catalog, oldGrok);
    await setGrokPrice(db, context.manifest.standard_grok_target.pricing, price(before, "grok-build"));
    const after = await readSnapshot(db);
    assertTransition(before, after, context.manifest, true);
    const receipt: Receipt = { schema: 1, operation: "activate", runId: request.runId,
      requestSha256, manifestSha256: digest(context.manifest), release: request.observation.release,
      primary: request.observation.primary, before, after, afterSha256: digest(after) };
    await auditReceipt(db, receipt);
    committing = true;
    await db.query("COMMIT");
    return receipt;
  } catch (error) {
    if (committing) throw new CommitUnknown(request.runId, requestSha256);
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
export async function reconcile(
  db: Database, runId: string, requestSha256: string, manifestSha256: string,
  context: Pick<OperatorContext, "releasesRoot"> = {},
): Promise<{ kind: "committed"; receipt: Receipt } | { kind: "unknown" }> {
  insist(/^[0-9a-f]{64}$/.test(requestSha256) && /^[0-9a-f]{64}$/.test(manifestSha256),
    "RECONCILIATION_DIGEST_REQUIRED");
  await reconciliationLocks(db, runId);
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const receipt = await storedReceipt(db, runId);
      if (!receipt) { await db.query("COMMIT"); return { kind: "unknown" }; }
      insist(receipt.schema === 1 && receipt.requestSha256 === requestSha256 &&
        receipt.manifestSha256 === manifestSha256, "RECONCILIATION_RECEIPT_CONFLICT");
      same(await primaryIdentity(db), receipt.primary, "RECONCILIATION_PRIMARY_CONFLICT");
      same(await releaseIdentity(db, context.releasesRoot), receipt.release,
        "RECONCILIATION_RELEASE_CONFLICT");
      same(digest(receipt.after), receipt.afterSha256, "RECEIPT_POSTSTATE_DIGEST");
      same(await readSnapshot(db), receipt.after, "RECONCILIATION_COMMITTED_STATE_DRIFT");
      await db.query("COMMIT");
      return { kind: "committed", receipt };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally { await releaseReconciliationLocks(db, runId); }
}
export async function compensate(
  db: Database, context: OperatorContext, request: WriteRequest, activationRunId: string,
): Promise<Receipt> {
  validateRunId(activationRunId);
  insist(activationRunId !== request.runId, "FRESH_COMPENSATION_RUN_ID_REQUIRED");
  await permissionPreflight(db);
  await db.query("BEGIN");
  let committing = false;
  const requestSha256 = requestDigest(request, "compensate", activationRunId);
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'");
    await qualify(db, context, request);
    const replay = await storedReceipt(db, request.runId);
    if (replay) {
      insist(replay.operation === "compensate" && replay.requestSha256 === requestSha256,
        "RUN_ID_PAYLOAD_CONFLICT");
      same(await readSnapshot(db), replay.after, "COMPENSATED_POSTSTATE_DRIFT");
      await db.query("ROLLBACK");
      return replay;
    }
    const original = await storedReceipt(db, activationRunId);
    insist(original?.operation === "activate" &&
      original.manifestSha256 === digest(context.manifest), "COMMITTED_ACTIVATION_RECEIPT_REQUIRED");
    same(original.release, request.observation.release, "COMPENSATION_RELEASE_BINDING");
    same(digest(original.after), original.afterSha256, "ACTIVATION_RECEIPT_DIGEST");
    const before = await readSnapshot(db);
    same(before, original.after, "COMPENSATION_POSTSTATE_CAS_CONFLICT");
    for (const spec of [...context.manifest.new_models].sort((a,b) =>
      a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0)) {
      const entry = active(before, spec.model_id);
      await db.query("SELECT fn_model_disable_entry($1,$2,$3)",
        [entry.entry_id, expectedVersion(entry.lock_version), 1]);
    }
    const oldGrok = active(before, "grok-build");
    await switchGrok(db, active(original.before, "grok-build"), oldGrok);
    await setGrokPrice(db, price(original.before, "grok-build"), price(before, "grok-build"));
    const after = await readSnapshot(db);
    assertTransition(before, after, context.manifest, false);
    const receipt: Receipt = { schema: 1, operation: "compensate", runId: request.runId,
      activationRunId, requestSha256, manifestSha256: digest(context.manifest),
      release: request.observation.release, primary: request.observation.primary, before, after, afterSha256: digest(after) };
    await auditReceipt(db, receipt);
    committing = true;
    await db.query("COMMIT");
    return receipt;
  } catch (error) {
    if (committing) throw new CommitUnknown(request.runId, requestSha256);
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

class CommittedOutputFailure extends Error {
  constructor(public readonly receipt: Receipt) { super("COMMITTED_LOCAL_OUTPUT_FAILED"); }
}
async function commandLine(): Promise<void> {
  insist(process.geteuid?.() === 0, "COMMERCIAL_HOST_ROOT_REQUIRED");
  const [operation, ...args] = process.argv.slice(2);
  insist(["observe", "apply", "reconcile", "compensate"].includes(operation), "OPERATOR_COMMAND_REQUIRED");
  const options: Record<string,string> = {};
  for (let i = 0; i < args.length; i += 2) {
    insist(args[i]?.startsWith("--") && args[i+1] && !args[i+1].startsWith("--") &&
      !(args[i].slice(2) in options), "UNIQUE_NAMED_OPTION_REQUIRED");
    options[args[i].slice(2)] = args[i+1];
  }
  const allowed: Record<string, string[]> = {
    observe: ["out"], apply: ["observation","readiness","run-id","out"],
    reconcile: ["run-id","request-sha256","manifest-sha256","out"],
    compensate: ["observation","readiness","run-id","activation-run-id","out"],
  };
  insist(Object.keys(options).every((key) => allowed[operation].includes(key)),
    "UNKNOWN_CLI_OPTION_REFUSED");
  for (const key of allowed[operation]) insist(options[key], "REQUIRED_CLI_OPTION:" + key);
  const { fileURLToPath } = await import("node:url");
  const base = fileURLToPath(new URL(".", import.meta.url));
  const manifest = JSON.parse((await trustedRootFile(join(base, "model-release-manifest.json"), false)).toString());
  validateManifest(manifest);
  const sql = await trustedRootFile(resolve(base,
    "../../packages/commercial/src/db/migrations/0293_commercial_new_models_prepare.sql"), false);
  const context: OperatorContext = { manifest, prepareSqlSha256: createHash("sha256").update(sql).digest("hex") };
  const dsn = explicitOperatorDsn(process.env);
  // Deterministic local output-path rejection happens before any database work.
  const output = await open(options.out, fsConstants.O_WRONLY | fsConstants.O_CREAT |
    fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: dsn,
    connectionTimeoutMillis: 5000, query_timeout: 30000 });
  try {
    await client.connect();
    await client.query("SET search_path=pg_catalog,public; SET lock_timeout='5s'; SET statement_timeout='20s'");
    let result: unknown;
    if (operation === "observe") result = await observe(client, context);
    else if (operation === "reconcile") result = await reconcile(client,
      options["run-id"], options["request-sha256"], options["manifest-sha256"]);
    else {
      const observation = JSON.parse((await trustedRootFile(options.observation)).toString()) as Observation;
      const readiness = JSON.parse((await trustedRootFile(options.readiness)).toString()) as Readiness;
      const nonce = process.env.OC_V5_MUTATION_ADMISSION_NONCE;
      insist(typeof nonce === "string", "OFFICIAL_INVOCATION_NONCE_REQUIRED");
      const request: WriteRequest = { runId: options["run-id"], nonce, observation, readiness };
      result = operation === "apply" ? await apply(client, context, request) :
        await compensate(client, context, request, options["activation-run-id"]);
    }
    const shaped = result as Receipt & { kind?: string; receipt?: Receipt };
    const committed = shaped.operation ? shaped : shaped.kind === "committed" ? shaped.receipt : undefined;
    try {
      await output.writeFile(JSON.stringify(result,null,2) + "\n");
      await output.sync();
    } catch (error) {
      if (committed) throw new CommittedOutputFailure(committed);
      throw error;
    }
    process.stdout.write(JSON.stringify({ operation, output: options.out }) + "\n");
  } finally {
    await output.close().catch(() => {});
    await client.end().catch(() => {});
  }
}
import { pathToFileURL } from "node:url";
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  commandLine().catch((error) => {
    // Never log credentials, DSNs or upstream/PG error messages.
    if (error instanceof CommitUnknown) {
      process.stderr.write(JSON.stringify({ status: "unknown", runId: error.runId,
        requestSha256: error.requestSha256, next: "reconcile-only" }) + "\n");
      process.exitCode = 75;
    } else if (error instanceof CommittedOutputFailure) {
      process.stderr.write(JSON.stringify({ status: "committed_local_output_failed",
        runId: error.receipt.runId, requestSha256: error.receipt.requestSha256,
        manifestSha256: error.receipt.manifestSha256, next: "reconcile-only" }) + "\n");
      process.exitCode = 74;
    } else {
      process.stderr.write("MODEL_RELEASE_OPERATOR_REFUSED\n");
      process.exitCode = 1;
    }
  });
}
