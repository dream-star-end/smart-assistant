import {
  BOX_GPT_WEB_ALLOWED_UIDS_ENV,
  BOX_GPT_WEB_CONTAINER_ALLOWED_ENV,
  isBoxGptWebAllowedUid,
} from "@openclaude/protocol";

/**
 * Cursor credential entitlement is deliberately separate from model grants.
 * A DB visibility grant alone must never cause the shared root-only key to be
 * mounted. Expanding this set is an explicit operator action.
 *
 * `*` or `all` (exact token) opens every syntactically valid uid. Empty or
 * malformed configuration still fails closed as a whole.
 */
export type CursorCredentialPolicy = ReadonlySet<number> | "all";

export function parseCursorCredentialUids(raw: string | undefined): CursorCredentialPolicy {
  const value = raw?.trim() ?? "";
  if (value === "*" || value === "all") return "all";
  if (!value) return new Set<number>();

  const members = new Set<number>();
  for (const token of value.split(",")) {
    if (!/^[1-9][0-9]*$/.test(token)) return new Set<number>();
    const uid = Number(token);
    if (!Number.isSafeInteger(uid)) return new Set<number>();
    members.add(uid);
  }
  return members;
}

/** The uid may use the owner's Cursor accounts from its container. Exactly the rule that mounts the
 * root-only credential pool into a container (resolveV5CursorAuthMount): OC_V5_CURSOR_CREDENTIAL_UIDS
 * when set, else the owner uid. The interactive Box route asks the master for a Box exec target under
 * the same entitlement instead of reading that pool. */
export function isCursorCredentialEntitled(uid: number | string | bigint, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OC_V5_CURSOR_CREDENTIAL_UIDS?.trim() ? env.OC_V5_CURSOR_CREDENTIAL_UIDS : env.OC_V5_CURSOR_OWNER_UID;
  return isCursorCredentialMember(uid, raw);
}

export function isCursorCredentialMember(
  uid: number | string | bigint,
  raw = process.env.OC_V5_CURSOR_CREDENTIAL_UIDS,
): boolean {
  const text = String(uid);
  if (!/^[1-9][0-9]*$/.test(text)) return false;
  const normalized = Number(text);
  if (!Number.isSafeInteger(normalized)) return false;
  const policy = parseCursorCredentialUids(raw);
  if (policy === "all") return true;
  return policy.has(normalized);
}

/** Explicit allowlist for the Box exec endpoint (OCV5-575). When set it replaces the credential-mount
 * rule below: commercial mounts Cursor for everyone (`all`) but hands the Box exec endpoint only to the
 * uids listed here. A wildcard is refused; an empty or malformed list allows nobody. */
export const BOX_EXEC_TARGET_UIDS_ENV = "OC_BOX_EXEC_TARGET_UIDS";

/** Who may receive a Box exec endpoint from the master (POST /internal/box/exec-target). With
 * OC_BOX_EXEC_TARGET_UIDS set, exactly the uids it lists. Otherwise the same entitlement as the
 * credential mount, except that a wildcard policy (`all` / `*`) is refused outright: the endpoint drives
 * the shared Box itself, so it goes only to explicitly listed uids (OCV5-380). */
export function boxExecTargetEntitlement(
  uid: number | string | bigint,
  env: NodeJS.ProcessEnv = process.env,
): "entitled" | "not_entitled" | "wildcard_refused" {
  const explicit = env[BOX_EXEC_TARGET_UIDS_ENV];
  const raw = explicit !== undefined
    ? explicit
    : env.OC_V5_CURSOR_CREDENTIAL_UIDS?.trim() ? env.OC_V5_CURSOR_CREDENTIAL_UIDS : env.OC_V5_CURSOR_OWNER_UID;
  if (parseCursorCredentialUids(raw) === "all") return "wildcard_refused";
  return isCursorCredentialMember(uid, raw) ? "entitled" : "not_entitled";
}

/** The uid may use `box-gpt-6-astra-pro` (OC_BOX_GPT_WEB_ALLOWED_UIDS; unset = personal owner 3). */
export function isBoxGptWebAllowedUser(
  uid: number | string | bigint | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isBoxGptWebAllowedUid(uid, env[BOX_GPT_WEB_ALLOWED_UIDS_ENV]);
}

/** The per-container capability flag the container gateway checks before it launches the Box runner. */
export function boxGptWebContainerEnv(
  uid: number | string | bigint,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${BOX_GPT_WEB_CONTAINER_ALLOWED_ENV}=${isBoxGptWebAllowedUser(uid, env) ? "1" : "0"}`;
}

