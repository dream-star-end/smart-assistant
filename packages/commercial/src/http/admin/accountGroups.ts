import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import { requireAdmin, requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { translateRangeError } from "./_shared.js";
import {
  adminCreateAccountGroup,
  adminCreateRelayCredential,
  adminDeleteAccountGroup,
  adminDeleteRelayCredential,
  adminGetAccountGroup,
  adminListAccountGroups,
  adminListRelayCredentials,
  adminPatchAccountGroup,
  adminPatchRelayCredential,
  adminSetAccountGroupModels,
  type AdminCreateAccountGroupInput,
  type AdminCreateRelayCredentialInput,
  type AdminPatchAccountGroupInput,
  type AdminPatchRelayCredentialInput,
} from "../../admin/accountGroups.js";
import type { AccountGroupRow, RelayCredentialRow } from "../../account-pool/groups.js";

const GROUP_PREFIX = "/api/admin/account-groups/";
const CREDENTIAL_PREFIX = "/api/admin/account-groups/relay-credentials/";

function serializeGroup(g: AccountGroupRow): Record<string, unknown> {
  return {
    id: g.id.toString(),
    label: g.label,
    kind: g.kind,
    provider: g.provider,
    enabled: g.enabled,
    priority: g.priority,
    models: g.models,
    created_at: g.created_at.toISOString(),
    updated_at: g.updated_at.toISOString(),
  };
}

function serializeCredential(c: RelayCredentialRow): Record<string, unknown> {
  return {
    id: c.id.toString(),
    group_id: c.group_id.toString(),
    label: c.label,
    base_url: c.base_url,
    model_provider: c.model_provider,
    provider_name: c.provider_name,
    wire_api: c.wire_api,
    preferred_auth_method: c.preferred_auth_method,
    disable_response_storage: c.disable_response_storage,
    status: c.status,
    health_score: c.health_score,
    cooldown_until: c.cooldown_until?.toISOString() ?? null,
    last_used_at: c.last_used_at?.toISOString() ?? null,
    last_error: c.last_error,
    success_count: c.success_count.toString(),
    fail_count: c.fail_count.toString(),
    created_at: c.created_at.toISOString(),
    updated_at: c.updated_at.toISOString(),
  };
}

function parseIdFromTail(tail: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid id");
  }
  return tail;
}

function readBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  return body as Record<string, unknown>;
}

function parseGroupCreate(b: Record<string, unknown>): AdminCreateAccountGroupInput {
  if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label is required");
  if (b.kind !== "official_oauth" && b.kind !== "api_relay") {
    throw new HttpError(400, "VALIDATION", "kind must be official_oauth or api_relay");
  }
  if (b.provider !== "claude" && b.provider !== "codex") {
    throw new HttpError(400, "VALIDATION", "provider must be claude or codex");
  }
  const input: AdminCreateAccountGroupInput = {
    label: b.label,
    kind: b.kind,
    provider: b.provider,
  };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    input.enabled = b.enabled;
  }
  if (b.priority !== undefined) {
    if (typeof b.priority !== "number") throw new HttpError(400, "VALIDATION", "priority must be number");
    input.priority = b.priority;
  }
  if (b.models !== undefined) {
    if (!Array.isArray(b.models) || !b.models.every((m) => typeof m === "string")) {
      throw new HttpError(400, "VALIDATION", "models must be string[]");
    }
    input.models = b.models;
  }
  return input;
}

function parseGroupPatch(b: Record<string, unknown>): AdminPatchAccountGroupInput {
  const patch: AdminPatchAccountGroupInput = {};
  if (b.label !== undefined) {
    if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label must be string");
    patch.label = b.label;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    patch.enabled = b.enabled;
  }
  if (b.priority !== undefined) {
    if (typeof b.priority !== "number") throw new HttpError(400, "VALIDATION", "priority must be number");
    patch.priority = b.priority;
  }
  return patch;
}

function parseCredentialCreate(groupId: string, b: Record<string, unknown>): AdminCreateRelayCredentialInput {
  if (typeof b.label !== "string") throw new HttpError(400, "VALIDATION", "label is required");
  if (typeof b.base_url !== "string") throw new HttpError(400, "VALIDATION", "base_url is required");
  if (typeof b.model_provider !== "string") throw new HttpError(400, "VALIDATION", "model_provider is required");
  if (typeof b.api_key !== "string" || b.api_key.length === 0) {
    throw new HttpError(400, "VALIDATION", "api_key is required");
  }
  const input: AdminCreateRelayCredentialInput = {
    group_id: groupId,
    label: b.label,
    base_url: b.base_url,
    model_provider: b.model_provider,
    api_key: b.api_key,
  };
  if (b.provider_name !== undefined) {
    if (b.provider_name !== null && typeof b.provider_name !== "string") {
      throw new HttpError(400, "VALIDATION", "provider_name must be string or null");
    }
    input.provider_name = b.provider_name;
  }
  if (b.wire_api !== undefined) {
    if (b.wire_api !== "responses" && b.wire_api !== "chat") throw new HttpError(400, "VALIDATION", "invalid wire_api");
    input.wire_api = b.wire_api;
  }
  if (b.preferred_auth_method !== undefined) {
    if (b.preferred_auth_method !== "apikey" && b.preferred_auth_method !== "chatgpt") {
      throw new HttpError(400, "VALIDATION", "invalid preferred_auth_method");
    }
    input.preferred_auth_method = b.preferred_auth_method;
  }
  if (b.disable_response_storage !== undefined) {
    if (typeof b.disable_response_storage !== "boolean") {
      throw new HttpError(400, "VALIDATION", "disable_response_storage must be boolean");
    }
    input.disable_response_storage = b.disable_response_storage;
  }
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "disabled" && b.status !== "cooldown") {
      throw new HttpError(400, "VALIDATION", "invalid status");
    }
    input.status = b.status;
  }
  if (b.health_score !== undefined) {
    if (typeof b.health_score !== "number") throw new HttpError(400, "VALIDATION", "health_score must be number");
    input.health_score = b.health_score;
  }
  return input;
}

function parseCredentialPatch(b: Record<string, unknown>): AdminPatchRelayCredentialInput {
  const patch: AdminPatchRelayCredentialInput = {};
  for (const key of ["label", "base_url", "model_provider", "api_key"] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== "string") throw new HttpError(400, "VALIDATION", `${key} must be string`);
      patch[key] = b[key];
    }
  }
  if (b.provider_name !== undefined) {
    if (b.provider_name !== null && typeof b.provider_name !== "string") {
      throw new HttpError(400, "VALIDATION", "provider_name must be string or null");
    }
    patch.provider_name = b.provider_name;
  }
  if (b.wire_api !== undefined) {
    if (b.wire_api !== "responses" && b.wire_api !== "chat") throw new HttpError(400, "VALIDATION", "invalid wire_api");
    patch.wire_api = b.wire_api;
  }
  if (b.preferred_auth_method !== undefined) {
    if (b.preferred_auth_method !== "apikey" && b.preferred_auth_method !== "chatgpt") {
      throw new HttpError(400, "VALIDATION", "invalid preferred_auth_method");
    }
    patch.preferred_auth_method = b.preferred_auth_method;
  }
  if (b.disable_response_storage !== undefined) {
    if (typeof b.disable_response_storage !== "boolean") {
      throw new HttpError(400, "VALIDATION", "disable_response_storage must be boolean");
    }
    patch.disable_response_storage = b.disable_response_storage;
  }
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "disabled" && b.status !== "cooldown") {
      throw new HttpError(400, "VALIDATION", "invalid status");
    }
    patch.status = b.status;
  }
  if (b.health_score !== undefined) {
    if (typeof b.health_score !== "number") throw new HttpError(400, "VALIDATION", "health_score must be number");
    patch.health_score = b.health_score;
  }
  if (b.cooldown_until !== undefined) {
    if (b.cooldown_until === null) patch.cooldown_until = null;
    else if (typeof b.cooldown_until === "string") {
      const d = new Date(b.cooldown_until);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, "VALIDATION", "invalid cooldown_until");
      patch.cooldown_until = d;
    } else {
      throw new HttpError(400, "VALIDATION", "cooldown_until must be ISO string or null");
    }
  }
  return patch;
}

export async function handleAdminListAccountGroups(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await adminListAccountGroups();
  sendJson(res, 200, { rows: rows.map(serializeGroup) });
}

export async function handleAdminCreateAccountGroup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = readBodyObject((await readJsonBody(req)) ?? {});
  try {
    const row = await adminCreateAccountGroup(parseGroupCreate(body), {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { group: serializeGroup(row) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminGetAccountGroup(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const tail = url.pathname.slice(GROUP_PREFIX.length);
  if (tail.endsWith("/relay-credentials")) {
    const id = parseIdFromTail(tail.slice(0, -"/relay-credentials".length));
    const rows = await adminListRelayCredentials(id);
    sendJson(res, 200, { rows: rows.map(serializeCredential) });
    return;
  }
  const id = parseIdFromTail(tail);
  const row = await adminGetAccountGroup(id);
  if (!row) throw new HttpError(404, "NOT_FOUND", "group not found");
  sendJson(res, 200, { group: serializeGroup(row) });
}

export async function handleAdminPatchAccountGroup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = parseIdFromTail(url.pathname.slice(GROUP_PREFIX.length));
  const body = readBodyObject((await readJsonBody(req)) ?? {});
  try {
    const row = await adminPatchAccountGroup(id, parseGroupPatch(body), {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { group: serializeGroup(row) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminPutAccountGroupModels(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = url.pathname.match(/^\/api\/admin\/account-groups\/([1-9][0-9]{0,19})\/models$/);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  const body = readBodyObject((await readJsonBody(req)) ?? {});
  if (!Array.isArray(body.models) || !body.models.every((v) => typeof v === "string")) {
    throw new HttpError(400, "VALIDATION", "models must be string[]");
  }
  try {
    const row = await adminSetAccountGroupModels(m[1]!, body.models, {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { group: serializeGroup(row) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminDeleteAccountGroup(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = parseIdFromTail(url.pathname.slice(GROUP_PREFIX.length));
  try {
    const ok = await adminDeleteAccountGroup(id, { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent });
    if (!ok) throw new HttpError(404, "NOT_FOUND", "group not found");
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminCreateRelayCredential(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const m = url.pathname.match(/^\/api\/admin\/account-groups\/([1-9][0-9]{0,19})\/relay-credentials$/);
  if (!m) throw new HttpError(404, "NOT_FOUND", "endpoint not found");
  const body = readBodyObject((await readJsonBody(req)) ?? {});
  try {
    const row = await adminCreateRelayCredential(parseCredentialCreate(m[1]!, body), {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { credential: serializeCredential(row) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminPatchRelayCredential(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = parseIdFromTail(url.pathname.slice(CREDENTIAL_PREFIX.length));
  const body = readBodyObject((await readJsonBody(req)) ?? {});
  try {
    const row = await adminPatchRelayCredential(id, parseCredentialPatch(body), {
      adminId: admin.id,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { credential: serializeCredential(row) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

export async function handleAdminDeleteRelayCredential(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const id = parseIdFromTail(url.pathname.slice(CREDENTIAL_PREFIX.length));
  try {
    const ok = await adminDeleteRelayCredential(id, { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent });
    if (!ok) throw new HttpError(404, "NOT_FOUND", "credential not found");
    sendJson(res, 200, { deleted: true });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}
