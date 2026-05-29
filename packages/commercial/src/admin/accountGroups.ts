import { getPool } from "../db/index.js";
import {
  createAccountGroup,
  createRelayCredential,
  deleteAccountGroup,
  deleteRelayCredential,
  getAccountGroup,
  getRelayCredential,
  listAccountGroups,
  listRelayCredentials,
  setAccountGroupModels,
  updateAccountGroup,
  updateRelayCredential,
  type AccountGroupKind,
  type AccountGroupProvider,
  type AccountGroupRow,
  type CreateGroupInput,
  type CreateRelayCredentialInput,
  type RelayCredentialRow,
  type RelayCredentialStatus,
  type UpdateGroupInput,
  type UpdateRelayCredentialInput,
} from "../account-pool/groups.js";
import { writeAdminAudit } from "./audit.js";
import { incrAdminAuditWriteFailure } from "./metrics.js";
import type { AdminAuditCtx } from "./accounts.js";

function defaultAuditErrorLog(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[admin/accountGroups] admin_audit write failed:", err);
}

async function bestEffortAudit(
  ctx: AdminAuditCtx,
  action: string,
  target: string | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  try {
    await writeAdminAudit(getPool(), {
      adminId: ctx.adminId,
      action,
      target,
      before,
      after,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    incrAdminAuditWriteFailure(action);
    (ctx.onAuditError ?? defaultAuditErrorLog)(err);
  }
}

function groupSnapshot(row: AccountGroupRow): Record<string, unknown> {
  return {
    id: row.id.toString(),
    label: row.label,
    kind: row.kind,
    provider: row.provider,
    enabled: row.enabled,
    priority: row.priority,
    models: row.models,
  };
}

function credentialSnapshot(row: RelayCredentialRow): Record<string, unknown> {
  return {
    id: row.id.toString(),
    group_id: row.group_id.toString(),
    label: row.label,
    base_url: row.base_url,
    model_provider: row.model_provider,
    provider_name: row.provider_name,
    wire_api: row.wire_api,
    preferred_auth_method: row.preferred_auth_method,
    disable_response_storage: row.disable_response_storage,
    status: row.status,
    health_score: row.health_score,
    cooldown_until: row.cooldown_until?.toISOString() ?? null,
  };
}

export interface AdminCreateAccountGroupInput {
  label: string;
  kind: AccountGroupKind;
  provider: AccountGroupProvider;
  enabled?: boolean;
  priority?: number;
  models?: string[];
}

export interface AdminPatchAccountGroupInput {
  label?: string;
  enabled?: boolean;
  priority?: number;
}

async function ensureModelsExist(modelIds: string[]): Promise<void> {
  if (modelIds.length === 0) return;
  const uniq = [...new Set(modelIds)];
  const res = await getPool().query<{ model_id: string }>(
    `SELECT model_id FROM model_pricing WHERE model_id = ANY($1::text[])`,
    [uniq],
  );
  const found = new Set(res.rows.map((r) => r.model_id));
  const missing = uniq.filter((id) => !found.has(id));
  if (missing.length > 0) throw new RangeError(`model_not_found:${missing.join(",")}`);
}

export async function adminListAccountGroups(): Promise<AccountGroupRow[]> {
  return listAccountGroups();
}

export async function adminGetAccountGroup(id: bigint | string): Promise<AccountGroupRow | null> {
  return getAccountGroup(id);
}

export async function adminCreateAccountGroup(
  input: AdminCreateAccountGroupInput,
  ctx: AdminAuditCtx,
): Promise<AccountGroupRow> {
  if (input.models !== undefined) await ensureModelsExist(input.models);
  const row = await createAccountGroup(input as CreateGroupInput);
  await bestEffortAudit(ctx, "account_group.create", `account_group:${row.id}`, null, groupSnapshot(row));
  return row;
}

export async function adminPatchAccountGroup(
  id: bigint | string,
  patch: AdminPatchAccountGroupInput,
  ctx: AdminAuditCtx,
): Promise<AccountGroupRow> {
  const before = await getAccountGroup(id);
  if (!before) throw new RangeError("group_not_found");
  const after = await updateAccountGroup(id, patch as UpdateGroupInput);
  if (!after) throw new RangeError("group_not_found");
  const beforePatch: Record<string, unknown> = {};
  const afterPatch: Record<string, unknown> = {};
  if (patch.label !== undefined) { beforePatch.label = before.label; afterPatch.label = after.label; }
  if (patch.enabled !== undefined) { beforePatch.enabled = before.enabled; afterPatch.enabled = after.enabled; }
  if (patch.priority !== undefined) { beforePatch.priority = before.priority; afterPatch.priority = after.priority; }
  await bestEffortAudit(ctx, "account_group.patch", `account_group:${after.id}`, beforePatch, afterPatch);
  return after;
}

export async function adminSetAccountGroupModels(
  id: bigint | string,
  modelIds: string[],
  ctx: AdminAuditCtx,
): Promise<AccountGroupRow> {
  const before = await getAccountGroup(id);
  if (!before) throw new RangeError("group_not_found");
  await ensureModelsExist(modelIds);
  await setAccountGroupModels(id, modelIds);
  const after = await getAccountGroup(id);
  if (!after) throw new RangeError("group_not_found");
  await bestEffortAudit(
    ctx,
    "account_group.models.set",
    `account_group:${after.id}`,
    { models: before.models },
    { models: after.models },
  );
  return after;
}

export async function adminDeleteAccountGroup(
  id: bigint | string,
  ctx: AdminAuditCtx,
): Promise<boolean> {
  const before = await getAccountGroup(id);
  if (!before) return false;
  const ok = await deleteAccountGroup(id);
  if (ok) {
    await bestEffortAudit(ctx, "account_group.delete", `account_group:${String(id)}`, groupSnapshot(before), null);
  }
  return ok;
}

export interface AdminCreateRelayCredentialInput {
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

export interface AdminPatchRelayCredentialInput {
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
}

export async function adminListRelayCredentials(groupId?: bigint | string): Promise<RelayCredentialRow[]> {
  return listRelayCredentials(groupId);
}

export async function adminCreateRelayCredential(
  input: AdminCreateRelayCredentialInput,
  ctx: AdminAuditCtx,
): Promise<RelayCredentialRow> {
  const row = await createRelayCredential(input as CreateRelayCredentialInput);
  await bestEffortAudit(
    ctx,
    "relay_credential.create",
    `relay_credential:${row.id}`,
    null,
    { ...credentialSnapshot(row), api_key: "<redacted>" },
  );
  return row;
}

export async function adminPatchRelayCredential(
  id: bigint | string,
  patch: AdminPatchRelayCredentialInput,
  ctx: AdminAuditCtx,
): Promise<RelayCredentialRow> {
  const before = await getRelayCredential(id);
  if (!before) throw new RangeError("credential_not_found");
  const after = await updateRelayCredential(id, patch as UpdateRelayCredentialInput);
  if (!after) throw new RangeError("credential_not_found");
  const beforePatch: Record<string, unknown> = {};
  const afterPatch: Record<string, unknown> = {};
  for (const key of [
    "label",
    "base_url",
    "model_provider",
    "provider_name",
    "wire_api",
    "preferred_auth_method",
    "disable_response_storage",
    "status",
    "health_score",
    "cooldown_until",
  ] as const) {
    if (patch[key] !== undefined) {
      const b = before[key];
      const a = after[key];
      beforePatch[key] = b instanceof Date ? b.toISOString() : b;
      afterPatch[key] = a instanceof Date ? a.toISOString() : a;
    }
  }
  if (patch.api_key !== undefined) {
    beforePatch.api_key = "<redacted>";
    afterPatch.api_key = "<rotated>";
  }
  await bestEffortAudit(ctx, "relay_credential.patch", `relay_credential:${after.id}`, beforePatch, afterPatch);
  return after;
}

export async function adminDeleteRelayCredential(
  id: bigint | string,
  ctx: AdminAuditCtx,
): Promise<boolean> {
  const before = await getRelayCredential(id);
  if (!before) return false;
  const ok = await deleteRelayCredential(id);
  if (ok) {
    await bestEffortAudit(ctx, "relay_credential.delete", `relay_credential:${String(id)}`, credentialSnapshot(before), null);
  }
  return ok;
}
