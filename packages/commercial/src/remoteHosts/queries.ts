/**
 * user_remote_hosts CRUD —— 全部走 $1..$N 参数化,user_id 始终作为查询条件
 * 之一(防 IDOR:即便别处漏校验,数据库层也兜底)。
 *
 * 本模块不包含加解密逻辑,密码字段以 BYTEA 进出;crypto 封装见 ./crypto.ts。
 */

import { query } from "../db/queries.js";
import type { RemoteHostRow } from "./types.js";

export interface CreateRemoteHostInput {
  userId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  remoteWorkdir: string;
  passwordNonce: Buffer;
  passwordCt: Buffer;
}

export interface UpdateRemoteHostMetaInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  remoteWorkdir?: string;
}

const ROW_COLS = `
  id, user_id, name, host, port, username, remote_workdir,
  password_nonce, password_ct, fingerprint, host_keys_text,
  last_test_ok, last_test_error, last_used_at,
  created_at, updated_at
`;

export async function listByUser(userId: string): Promise<RemoteHostRow[]> {
  const r = await query<RemoteHostRow>(
    `SELECT ${ROW_COLS} FROM user_remote_hosts
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [userId],
  );
  return r.rows;
}

export async function getByIdForUser(
  userId: string,
  hostId: string,
): Promise<RemoteHostRow | null> {
  const r = await query<RemoteHostRow>(
    `SELECT ${ROW_COLS} FROM user_remote_hosts
     WHERE user_id = $1 AND id = $2`,
    [userId, hostId],
  );
  return r.rows[0] ?? null;
}

export async function create(input: CreateRemoteHostInput): Promise<RemoteHostRow> {
  const r = await query<RemoteHostRow>(
    `INSERT INTO user_remote_hosts
       (user_id, name, host, port, username, remote_workdir, password_nonce, password_ct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ROW_COLS}`,
    [
      input.userId,
      input.name,
      input.host,
      input.port,
      input.username,
      input.remoteWorkdir,
      input.passwordNonce,
      input.passwordCt,
    ],
  );
  return r.rows[0]!;
}

/**
 * 更新可见元数据。host/username 变化会让旧 fingerprint 失去意义,调用方
 * 负责决定是否同时 reset fingerprint(一般 host 变了应该 reset)。
 *
 * 注意:本函数不改 password_* 字段;改密码走 updatePassword。
 */
export async function updateMeta(
  userId: string,
  hostId: string,
  patch: UpdateRemoteHostMetaInput,
): Promise<RemoteHostRow | null> {
  // 动态 SET 片段:只 patch 传进来的字段,避免把 null 覆盖回已有值
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${idx++}`);
    params.push(val);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.host !== undefined) push("host", patch.host);
  if (patch.port !== undefined) push("port", patch.port);
  if (patch.username !== undefined) push("username", patch.username);
  if (patch.remoteWorkdir !== undefined) push("remote_workdir", patch.remoteWorkdir);
  if (sets.length === 0) return getByIdForUser(userId, hostId);
  sets.push("updated_at = NOW()");
  params.push(userId, hostId);
  const r = await query<RemoteHostRow>(
    `UPDATE user_remote_hosts SET ${sets.join(", ")}
     WHERE user_id = $${idx++} AND id = $${idx}
     RETURNING ${ROW_COLS}`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function updatePassword(
  userId: string,
  hostId: string,
  nonce: Buffer,
  ciphertext: Buffer,
): Promise<boolean> {
  const r = await query(
    `UPDATE user_remote_hosts
       SET password_nonce = $3, password_ct = $4, updated_at = NOW()
     WHERE user_id = $1 AND id = $2`,
    [userId, hostId, nonce, ciphertext],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function remove(userId: string, hostId: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM user_remote_hosts WHERE user_id = $1 AND id = $2`,
    [userId, hostId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * 首次 TOFU 或 reset 后写入 host key material。两列一起更新 —— fingerprint 是
 * host_keys_text 的派生(`ssh-keygen -lf`),永远不该漂移。
 *
 * 传 (null, null) 表示 reset(user 显式触发 reset-fingerprint,或 host/port/username
 * 变更后自动清)。
 */
export async function updateHostKeyMaterial(
  userId: string,
  hostId: string,
  fingerprint: string | null,
  hostKeysText: string | null,
): Promise<boolean> {
  const r = await query(
    `UPDATE user_remote_hosts
       SET fingerprint = $3, host_keys_text = $4, updated_at = NOW()
     WHERE user_id = $1 AND id = $2`,
    [userId, hostId, fingerprint, hostKeysText],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * test API 调用后记录结果。error 为 null 表示成功。
 */
export async function updateTestResult(
  userId: string,
  hostId: string,
  ok: boolean,
  error: string | null,
): Promise<boolean> {
  const r = await query(
    `UPDATE user_remote_hosts
       SET last_test_ok = $3, last_test_error = $4, updated_at = NOW()
     WHERE user_id = $1 AND id = $2`,
    [userId, hostId, ok, error],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 会话/工具真正用到 host 时打点,用于 UI 显示"最近使用"。 */
export async function touchLastUsed(userId: string, hostId: string): Promise<void> {
  await query(
    `UPDATE user_remote_hosts SET last_used_at = NOW()
     WHERE user_id = $1 AND id = $2`,
    [userId, hostId],
  );
}
