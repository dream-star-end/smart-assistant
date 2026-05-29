import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

import { encrypt, decryptToBuffer } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";
import { query, tx, type QueryRunner } from "../db/queries.js";

export const ACCOUNT_GROUP_KINDS = ["official_oauth", "api_relay"] as const;
export type AccountGroupKind = (typeof ACCOUNT_GROUP_KINDS)[number];

export const ACCOUNT_GROUP_PROVIDERS = ["claude", "codex"] as const;
export type AccountGroupProvider = (typeof ACCOUNT_GROUP_PROVIDERS)[number];

export const RELAY_CREDENTIAL_STATUSES = ["active", "disabled", "cooldown"] as const;
export type RelayCredentialStatus = (typeof RELAY_CREDENTIAL_STATUSES)[number];

const GROUP_LABEL_RE = /^.{1,120}$/u;
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/;

export interface AccountGroupRow {
  id: bigint;
  label: string;
  kind: AccountGroupKind;
  provider: AccountGroupProvider;
  enabled: boolean;
  priority: number;
  models: string[];
  created_at: Date;
  updated_at: Date;
}

export interface RelayCredentialRow {
  id: bigint;
  group_id: bigint;
  label: string;
  base_url: string;
  model_provider: string;
  provider_name: string | null;
  wire_api: "responses" | "chat";
  preferred_auth_method: "apikey" | "chatgpt";
  disable_response_storage: boolean;
  status: RelayCredentialStatus;
  health_score: number;
  cooldown_until: Date | null;
  last_used_at: Date | null;
  last_error: string | null;
  success_count: bigint;
  fail_count: bigint;
  created_at: Date;
  updated_at: Date;
}

export interface CreateGroupInput {
  label: string;
  kind: AccountGroupKind;
  provider: AccountGroupProvider;
  enabled?: boolean;
  priority?: number;
  models?: string[];
}

export interface UpdateGroupInput {
  label?: string;
  enabled?: boolean;
  priority?: number;
}

export interface CreateRelayCredentialInput {
  group_id: bigint | string;
  label: string;
  base_url: string;
  model_provider: string;
  provider_name?: string | null;
  wire_api?: "responses" | "chat";
  preferred_auth_method?: "apikey" | "chatgpt";
  disable_response_storage?: boolean;
  api_key: string;
  status?: RelayCredentialStatus;
  health_score?: number;
}

export interface UpdateRelayCredentialInput {
  label?: string;
  base_url?: string;
  model_provider?: string;
  provider_name?: string | null;
  wire_api?: "responses" | "chat";
  preferred_auth_method?: "apikey" | "chatgpt";
  disable_response_storage?: boolean;
  api_key?: string;
  status?: RelayCredentialStatus;
  health_score?: number;
  cooldown_until?: Date | null;
  last_error?: string | null;
}

interface RawGroupRow {
  id: string;
  label: string;
  kind: AccountGroupKind;
  provider: AccountGroupProvider;
  enabled: boolean;
  priority: number;
  models: string[] | null;
  created_at: Date;
  updated_at: Date;
}

interface RawRelayCredentialRow {
  id: string;
  group_id: string;
  label: string;
  base_url: string;
  model_provider: string;
  provider_name: string | null;
  wire_api: "responses" | "chat";
  preferred_auth_method: "apikey" | "chatgpt";
  disable_response_storage: boolean;
  status: RelayCredentialStatus;
  health_score: number;
  cooldown_until: Date | null;
  last_used_at: Date | null;
  last_error: string | null;
  success_count: string;
  fail_count: string;
  created_at: Date;
  updated_at: Date;
}

const GROUP_COLS = `
  g.id::text AS id,
  g.label,
  g.kind,
  g.provider,
  g.enabled,
  g.priority,
  COALESCE(array_agg(gm.model_id ORDER BY gm.model_id) FILTER (WHERE gm.model_id IS NOT NULL), ARRAY[]::text[]) AS models,
  g.created_at,
  g.updated_at
`;

const RELAY_COLS = `
  id::text AS id,
  group_id::text AS group_id,
  label,
  base_url,
  model_provider,
  provider_name,
  wire_api,
  preferred_auth_method,
  disable_response_storage,
  status,
  health_score,
  cooldown_until,
  last_used_at,
  last_error,
  success_count::text AS success_count,
  fail_count::text AS fail_count,
  created_at,
  updated_at
`;

function parseGroup(row: RawGroupRow): AccountGroupRow {
  return {
    id: BigInt(row.id),
    label: row.label,
    kind: row.kind,
    provider: row.provider,
    enabled: row.enabled,
    priority: row.priority,
    models: row.models ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseRelay(row: RawRelayCredentialRow): RelayCredentialRow {
  return {
    id: BigInt(row.id),
    group_id: BigInt(row.group_id),
    label: row.label,
    base_url: row.base_url,
    model_provider: row.model_provider,
    provider_name: row.provider_name,
    wire_api: row.wire_api,
    preferred_auth_method: row.preferred_auth_method,
    disable_response_storage: row.disable_response_storage,
    status: row.status,
    health_score: row.health_score,
    cooldown_until: row.cooldown_until,
    last_used_at: row.last_used_at,
    last_error: row.last_error,
    success_count: BigInt(row.success_count),
    fail_count: BigInt(row.fail_count),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function assertSupportedGroupCombo(kind: AccountGroupKind, provider: AccountGroupProvider): void {
  if (kind === "official_oauth" && (provider === "claude" || provider === "codex")) return;
  if (kind === "api_relay" && provider === "codex") return;
  throw new RangeError("unsupported_group_kind_provider");
}

function normalizeLabel(label: string): string {
  const out = label.trim();
  if (!GROUP_LABEL_RE.test(out)) throw new RangeError("invalid_label");
  return out;
}

function normalizePriority(priority: number | undefined): number {
  if (priority === undefined) return 100;
  if (!Number.isInteger(priority) || priority < -1_000_000 || priority > 1_000_000) {
    throw new RangeError("invalid_priority");
  }
  return priority;
}

function normalizeModelId(modelId: string): string {
  const out = modelId.trim();
  if (!MODEL_ID_RE.test(out)) throw new RangeError("invalid_model_id");
  return out;
}

function normalizeUrl(baseUrl: string): string {
  const out = baseUrl.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(out);
  } catch {
    throw new RangeError("invalid_base_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new RangeError("invalid_base_url");
  return out;
}

function normalizeProviderId(id: string): string {
  const out = id.trim();
  if (!PROVIDER_ID_RE.test(out)) throw new RangeError("invalid_model_provider");
  return out;
}

function normalizeStatus(status: RelayCredentialStatus | undefined): RelayCredentialStatus {
  if (status === undefined) return "active";
  if (!RELAY_CREDENTIAL_STATUSES.includes(status)) throw new RangeError("invalid_status");
  return status;
}

function normalizeHealthScore(score: number | undefined): number {
  if (score === undefined) return 100;
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new RangeError("invalid_health_score");
  return score;
}

export async function listAccountGroups(): Promise<AccountGroupRow[]> {
  const res = await query<RawGroupRow>(
    `SELECT ${GROUP_COLS}
       FROM account_groups g
       LEFT JOIN account_group_models gm ON gm.group_id = g.id
      GROUP BY g.id
      ORDER BY g.priority ASC, g.id ASC`,
  );
  return res.rows.map(parseGroup);
}

export async function getAccountGroup(id: bigint | string): Promise<AccountGroupRow | null> {
  const res = await query<RawGroupRow>(
    `SELECT ${GROUP_COLS}
       FROM account_groups g
       LEFT JOIN account_group_models gm ON gm.group_id = g.id
      WHERE g.id = $1
      GROUP BY g.id`,
    [String(id)],
  );
  return res.rows[0] ? parseGroup(res.rows[0]) : null;
}

export async function listEnabledGroupsForModel(args: {
  modelId: string;
  kind?: AccountGroupKind;
  provider?: AccountGroupProvider;
  runner?: QueryRunner;
}): Promise<AccountGroupRow[]> {
  const params: unknown[] = [normalizeModelId(args.modelId)];
  const where = ["g.enabled = TRUE", "gm.model_id = $1"];
  if (args.kind !== undefined) {
    params.push(args.kind);
    where.push(`g.kind = $${params.length}`);
  }
  if (args.provider !== undefined) {
    params.push(args.provider);
    where.push(`g.provider = $${params.length}`);
  }
  const res = await query<RawGroupRow>(
    `SELECT ${GROUP_COLS}
       FROM account_groups g
       JOIN account_group_models gm ON gm.group_id = g.id
      WHERE ${where.join(" AND ")}
      GROUP BY g.id
      ORDER BY g.priority ASC, g.id ASC`,
    params,
    args.runner,
  );
  return res.rows.map(parseGroup);
}

export async function createAccountGroup(input: CreateGroupInput): Promise<AccountGroupRow> {
  assertSupportedGroupCombo(input.kind, input.provider);
  const label = normalizeLabel(input.label);
  const priority = normalizePriority(input.priority);
  const enabled = input.enabled ?? true;
  const res = await query<{ id: string }>(
    `INSERT INTO account_groups(label, kind, provider, enabled, priority)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id::text AS id`,
    [label, input.kind, input.provider, enabled, priority],
  );
  const id = res.rows[0]!.id;
  if (input.models !== undefined) await setAccountGroupModels(id, input.models);
  const group = await getAccountGroup(id);
  if (!group) throw new Error("created account group vanished");
  return group;
}

export async function updateAccountGroup(id: bigint | string, patch: UpdateGroupInput): Promise<AccountGroupRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.label !== undefined) push("label", normalizeLabel(patch.label));
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.priority !== undefined) push("priority", normalizePriority(patch.priority));
  if (sets.length > 0) {
    push("updated_at", new Date());
    params.push(String(id));
    const idIdx = params.length;
    await query(`UPDATE account_groups SET ${sets.join(", ")} WHERE id = $${idIdx}`, params);
  }
  return getAccountGroup(id);
}

export async function setAccountGroupModels(id: bigint | string, modelIds: string[]): Promise<string[]> {
  const models = [...new Set(modelIds.map(normalizeModelId))];
  await tx(async (client) => {
    await query("DELETE FROM account_group_models WHERE group_id = $1", [String(id)], client);
    for (const model of models) {
      await query(
        `INSERT INTO account_group_models(group_id, model_id)
         VALUES ($1,$2)`,
        [String(id), model],
        client,
      );
    }
  });
  return models;
}

export async function deleteAccountGroup(id: bigint | string): Promise<boolean> {
  const res = await query("DELETE FROM account_groups WHERE id = $1", [String(id)]);
  return (res.rowCount ?? 0) > 0;
}

export async function listRelayCredentials(groupId?: bigint | string): Promise<RelayCredentialRow[]> {
  const params: unknown[] = [];
  const where = groupId === undefined ? "" : "WHERE group_id = $1";
  if (groupId !== undefined) params.push(String(groupId));
  const res = await query<RawRelayCredentialRow>(
    `SELECT ${RELAY_COLS}
       FROM api_relay_credentials
       ${where}
      ORDER BY group_id, health_score DESC, id ASC`,
    params,
  );
  return res.rows.map(parseRelay);
}

export async function createRelayCredential(input: CreateRelayCredentialInput): Promise<RelayCredentialRow> {
  const group = await getAccountGroup(input.group_id);
  if (!group) throw new RangeError("group_not_found");
  assertSupportedGroupCombo(group.kind, group.provider);
  if (group.kind !== "api_relay" || group.provider !== "codex") throw new RangeError("group_not_api_relay_codex");

  const key = loadKmsKey();
  let apiKeyBuf: Buffer | null = Buffer.from(input.api_key, "utf8");
  try {
    const enc = encrypt(apiKeyBuf, key);
    const res = await query<RawRelayCredentialRow>(
      `INSERT INTO api_relay_credentials(
         group_id, label, base_url, model_provider, provider_name, wire_api,
         preferred_auth_method, disable_response_storage, api_key_enc,
         api_key_nonce, status, health_score
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${RELAY_COLS}`,
      [
        String(input.group_id),
        normalizeLabel(input.label),
        normalizeUrl(input.base_url),
        normalizeProviderId(input.model_provider),
        input.provider_name?.trim() || null,
        input.wire_api ?? "responses",
        input.preferred_auth_method ?? "apikey",
        input.disable_response_storage ?? true,
        enc.ciphertext,
        enc.nonce,
        normalizeStatus(input.status),
        normalizeHealthScore(input.health_score),
      ],
    );
    return parseRelay(res.rows[0]!);
  } finally {
    key.fill(0);
    apiKeyBuf?.fill(0);
    apiKeyBuf = null;
  }
}

export async function updateRelayCredential(
  id: bigint | string,
  patch: UpdateRelayCredentialInput,
): Promise<RelayCredentialRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.label !== undefined) push("label", normalizeLabel(patch.label));
  if (patch.base_url !== undefined) push("base_url", normalizeUrl(patch.base_url));
  if (patch.model_provider !== undefined) push("model_provider", normalizeProviderId(patch.model_provider));
  if (patch.provider_name !== undefined) push("provider_name", patch.provider_name?.trim() || null);
  if (patch.wire_api !== undefined) push("wire_api", patch.wire_api);
  if (patch.preferred_auth_method !== undefined) push("preferred_auth_method", patch.preferred_auth_method);
  if (patch.disable_response_storage !== undefined) push("disable_response_storage", patch.disable_response_storage);
  if (patch.status !== undefined) push("status", normalizeStatus(patch.status));
  if (patch.health_score !== undefined) push("health_score", normalizeHealthScore(patch.health_score));
  if (patch.cooldown_until !== undefined) push("cooldown_until", patch.cooldown_until);
  if (patch.last_error !== undefined) push("last_error", patch.last_error);
  if (patch.api_key !== undefined) {
    const key = loadKmsKey();
    let apiKeyBuf: Buffer | null = Buffer.from(patch.api_key, "utf8");
    try {
      const enc = encrypt(apiKeyBuf, key);
      push("api_key_enc", enc.ciphertext);
      push("api_key_nonce", enc.nonce);
    } finally {
      key.fill(0);
      apiKeyBuf?.fill(0);
      apiKeyBuf = null;
    }
  }
  if (sets.length === 0) return getRelayCredential(id);
  push("updated_at", new Date());
  params.push(String(id));
  const idIdx = params.length;
  const res = await query<RawRelayCredentialRow>(
    `UPDATE api_relay_credentials SET ${sets.join(", ")}
      WHERE id = $${idIdx}
      RETURNING ${RELAY_COLS}`,
    params,
  );
  return res.rows[0] ? parseRelay(res.rows[0]) : null;
}

export async function getRelayCredential(id: bigint | string): Promise<RelayCredentialRow | null> {
  const res = await query<RawRelayCredentialRow>(
    `SELECT ${RELAY_COLS} FROM api_relay_credentials WHERE id = $1`,
    [String(id)],
  );
  return res.rows[0] ? parseRelay(res.rows[0]) : null;
}

export async function deleteRelayCredential(id: bigint | string): Promise<boolean> {
  const res = await query("DELETE FROM api_relay_credentials WHERE id = $1", [String(id)]);
  return (res.rowCount ?? 0) > 0;
}


export async function hasActiveOfficialOAuthAccountInGroup(
  groupId: bigint | string,
  provider: AccountGroupProvider,
  runner?: QueryRunner,
): Promise<boolean> {
  const group = await getAccountGroup(groupId);
  if (!group || !group.enabled || group.kind !== "official_oauth" || group.provider !== provider) return false;
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM claude_accounts
      WHERE provider = $1
        AND group_id = $2
        AND status = 'active'
      LIMIT 1`,
    [provider, String(groupId)],
    runner,
  );
  return res.rows.length > 0;
}

export async function pickRelayCredentialForGroup(
  groupId: bigint | string,
  runner?: QueryRunner,
): Promise<RelayCredentialRow | null> {
  const res = await query<RawRelayCredentialRow>(
    `SELECT ${RELAY_COLS}
       FROM api_relay_credentials
      WHERE group_id = $1
        AND status = 'active'
        AND (cooldown_until IS NULL OR cooldown_until <= NOW())
      ORDER BY health_score DESC, id ASC
      LIMIT 1`,
    [String(groupId)],
    runner,
  );
  return res.rows[0] ? parseRelay(res.rows[0]) : null;
}

export function hashRouteToken(token: string): string {
  if (!ROUTE_TOKEN_RE.test(token)) throw new RangeError("invalid_route_token");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintRouteToken(): string {
  return randomBytes(32).toString("hex");
}

export interface CodexRouteContextCreated {
  token: string;
  group: AccountGroupRow;
  credential: RelayCredentialRow;
  expiresAt: Date;
}

export async function createCodexRouteContextForModel(args: {
  containerId: number;
  userId: bigint;
  modelId: string;
  ttlMs?: number;
  groupId?: bigint | string;
  runner?: PoolClient;
}): Promise<CodexRouteContextCreated | null> {
  const runner = args.runner;
  const groups = await listEnabledGroupsForModel({
    modelId: args.modelId,
    kind: "api_relay",
    provider: "codex",
    runner,
  });
  const eligibleGroups = args.groupId === undefined
    ? groups
    : groups.filter((g) => g.id === BigInt(String(args.groupId)));
  for (const group of eligibleGroups) {
    const credential = await pickRelayCredentialForGroup(group.id, runner);
    if (!credential) continue;
    const token = mintRouteToken();
    const expiresAt = new Date(Date.now() + (args.ttlMs ?? 2 * 60 * 60 * 1000));
    await query(
      `INSERT INTO codex_route_contexts(
         token_hash, container_id, user_id, model_id, group_id, credential_id, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        hashRouteToken(token),
        String(args.containerId),
        String(args.userId),
        normalizeModelId(args.modelId),
        String(group.id),
        String(credential.id),
        expiresAt,
      ],
      runner,
    );
    return { token, group, credential, expiresAt };
  }
  return null;
}

export interface ResolvedCodexRouteContext {
  modelId: string;
  group: AccountGroupRow;
  credential: RelayCredentialRow;
  apiKey: Buffer;
}

export async function resolveCodexRouteContext(args: {
  token: string;
  containerId: number;
  userId: bigint;
  runner?: QueryRunner;
  keyFn?: () => Buffer;
}): Promise<ResolvedCodexRouteContext | null> {
  const tokenHash = hashRouteToken(args.token);
  const res = await query<{
    model_id: string;
    group_id: string;
    credential_id: string;
  }>(
    `SELECT model_id, group_id::text AS group_id, credential_id::text AS credential_id
       FROM codex_route_contexts
      WHERE token_hash = $1
        AND container_id = $2
        AND user_id = $3
        AND status = 'active'
        AND expires_at > NOW()`,
    [tokenHash, String(args.containerId), String(args.userId)],
    args.runner,
  );
  const ctx = res.rows[0];
  if (!ctx) return null;

  const group = await getAccountGroup(ctx.group_id);
  const credential = await getRelayCredential(ctx.credential_id);
  if (!group || !credential) return null;
  if (!group.enabled || group.kind !== "api_relay" || group.provider !== "codex") return null;
  if (credential.status !== "active") return null;
  if (credential.cooldown_until && credential.cooldown_until > new Date()) return null;

  const sec = await query<{ api_key_enc: Buffer; api_key_nonce: Buffer }>(
    `SELECT api_key_enc, api_key_nonce FROM api_relay_credentials WHERE id = $1`,
    [String(credential.id)],
    args.runner,
  );
  const row = sec.rows[0];
  if (!row) return null;
  const key = (args.keyFn ?? loadKmsKey)();
  try {
    const apiKey = decryptToBuffer(row.api_key_enc, row.api_key_nonce, key);
    await query(
      `UPDATE codex_route_contexts SET last_used_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
      args.runner,
    );
    return { modelId: ctx.model_id, group, credential, apiKey };
  } finally {
    zeroBuffer(key);
  }
}

export async function expireCodexRouteContext(token: string): Promise<boolean> {
  const res = await query(
    `UPDATE codex_route_contexts
        SET status = 'expired',
            expires_at = NOW()
      WHERE token_hash = $1
        AND status = 'active'`,
    [hashRouteToken(token)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markRelayCredentialFailure(id: bigint | string, err: string): Promise<void> {
  await query(
    `UPDATE api_relay_credentials
        SET fail_count = fail_count + 1,
            last_error = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [String(id), err.slice(0, 500)],
  );
}

export async function markRelayCredentialSuccess(id: bigint | string): Promise<void> {
  await query(
    `UPDATE api_relay_credentials
        SET success_count = success_count + 1,
            last_used_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [String(id)],
  );
}
