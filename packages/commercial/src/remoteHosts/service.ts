/**
 * 远程执行机业务层。
 *
 * 职责:
 *   - zod 校验用户输入(create/update 两套 schema,strict 拒未知字段)
 *   - 调用 crypto + queries 完成 CRUD
 *   - 把 RemoteHostRow 转成对前端安全的 RemoteHost 视图(无密码)
 *
 * 不做:
 *   - SSH 实际连接探测(由 gateway 的 ControlMaster 注入 tester fn)
 *   - 限流 / 认证(HTTP handler 层处理)
 *
 * 错误模型:抛 RemoteHostError('VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL'),
 * handler 层翻译成对应 HTTP status。
 */

import { z } from "zod";
import { decryptPassword, encryptPassword } from "./crypto.js";
import * as q from "./queries.js";
import { rowToRemoteHost, type DecryptedCredential, type RemoteHost, type RemoteHostRow } from "./types.js";

// ─── zod schemas ───────────────────────────────────────────────────────────

/**
 * host 字段:只接受 hostname 或 IPv4/IPv6 字面量,不接 URL,不接带端口(port 另一个字段)。
 * 长度上限贴合 RFC 1035(253 字符 DNS 名)。禁止空格 / `@` / `:` 等可能被误当协议/用户的字符。
 */
const hostField = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:\-\[\]]+$/, "host must be a hostname or IP literal");

/**
 * username 字段:POSIX 合法用户名 + 常见补充字符(.)。不接受空格 / shell 元字符。
 */
const usernameField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9._-]*$/, "username must be a valid posix user name");

/** 显示名:前端列表里用,不参与任何 shell/SSH argv 拼接,放宽字符集。 */
const nameField = z.string().trim().min(1).max(64);

const portField = z.number().int().min(1).max(65535);

/**
 * remoteWorkdir:远端起始目录。默认 `~`。允许绝对路径或 `~`/`~/xxx`。
 * 不做 canonicalization,交给远端 shell 展开;这里只挡明显不合理的形式。
 */
const remoteWorkdirField = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^(~|~\/[^\x00]*|\/[^\x00]*)$/, "remote_workdir must be absolute path or start with ~");

/**
 * 密码:不限字符集(用户可能真用奇字符),但限长度防 DoS + DB 膨胀。
 * 1..256 字节覆盖绝大多数真实密码。
 */
const passwordField = z.string().min(1).max(256);

export const CreateRemoteHostInputSchema = z
  .object({
    name: nameField,
    host: hostField,
    port: portField.default(22),
    username: usernameField,
    password: passwordField,
    remote_workdir: remoteWorkdirField.default("~"),
  })
  .strict();
export type CreateRemoteHostInput = z.infer<typeof CreateRemoteHostInputSchema>;

export const UpdateRemoteHostInputSchema = z
  .object({
    name: nameField.optional(),
    host: hostField.optional(),
    port: portField.optional(),
    username: usernameField.optional(),
    /** 如要轮换密码:传 password;不想改就忽略字段(undefined)。 */
    password: passwordField.optional(),
    remote_workdir: remoteWorkdirField.optional(),
  })
  .strict()
  .refine(
    (o) => Object.keys(o).length > 0,
    { message: "patch must include at least one field" },
  );
export type UpdateRemoteHostInput = z.infer<typeof UpdateRemoteHostInputSchema>;

// ─── error type ────────────────────────────────────────────────────────────

export type RemoteHostErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

export class RemoteHostError extends Error {
  readonly code: RemoteHostErrorCode;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  constructor(
    code: RemoteHostErrorCode,
    message: string,
    issues?: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "RemoteHostError";
    this.code = code;
    this.issues = issues;
  }
}

function validationErrorFromZod(e: z.ZodError): RemoteHostError {
  return new RemoteHostError(
    "VALIDATION",
    "invalid input",
    e.issues.map((i) => ({
      path: i.path.join(".") || "<root>",
      message: i.message,
    })),
  );
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export async function listHostsForUser(userId: string): Promise<RemoteHost[]> {
  const rows = await q.listByUser(userId);
  return rows.map(rowToRemoteHost);
}

export async function getHostForUser(userId: string, hostId: string): Promise<RemoteHost> {
  const row = await q.getByIdForUser(userId, hostId);
  if (!row) throw new RemoteHostError("NOT_FOUND", "remote host not found");
  return rowToRemoteHost(row);
}

export async function createHostForUser(
  userId: string,
  raw: unknown,
): Promise<RemoteHost> {
  const parsed = CreateRemoteHostInputSchema.safeParse(raw);
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const input = parsed.data;

  // 先建一条"占位行":name/host 等明文 + 暂时用 dummy nonce/ct(稍后覆盖)。
  //
  // 需要 host_id 才能算 AAD,chicken-and-egg。选择:
  //   a) 先 INSERT 拿 id,再用 id 算 AAD + encrypt + UPDATE password_*。两次写,但逻辑简单。
  //   b) 在应用层 uuid_generate_v7 预分配 id,单次 INSERT。需要引入 uuid 包。
  // 选 (a):多一次 UPDATE,但都在同库同事务内,对性能可忽略;
  // 且 "create 失败就剩下带 dummy password 的行" 靠事务 + 回滚兜底。
  //
  // 实现上用 tx 包住:INSERT → encrypt(用 returning 的 id) → UPDATE password_*。
  const { tx } = await import("../db/queries.js");
  let row: RemoteHostRow;
  try {
    row = await tx(async (client) => {
      const dummyNonce = Buffer.alloc(12);
      const dummyCt = Buffer.alloc(17); // 1 byte pt + 16 byte tag,满足 migration BYTEA NOT NULL
      const insertRes = await client.query<RemoteHostRow>(
        `INSERT INTO user_remote_hosts
           (user_id, name, host, port, username, remote_workdir,
            password_nonce, password_ct)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, user_id, name, host, port, username, remote_workdir,
                   password_nonce, password_ct, fingerprint,
                   last_test_ok, last_test_error, last_used_at,
                   created_at, updated_at`,
        [
          userId,
          input.name,
          input.host,
          input.port,
          input.username,
          input.remote_workdir,
          dummyNonce,
          dummyCt,
        ],
      );
      const inserted = insertRes.rows[0]!;
      const enc = encryptPassword(userId, inserted.id, input.password);
      const updRes = await client.query<RemoteHostRow>(
        `UPDATE user_remote_hosts
           SET password_nonce = $3, password_ct = $4, updated_at = NOW()
         WHERE user_id = $1 AND id = $2
         RETURNING id, user_id, name, host, port, username, remote_workdir,
                   password_nonce, password_ct, fingerprint,
                   last_test_ok, last_test_error, last_used_at,
                   created_at, updated_at`,
        [userId, inserted.id, enc.nonce, enc.ciphertext],
      );
      return updRes.rows[0]!;
    });
  } catch (err) {
    if (err instanceof Error && /duplicate key value/i.test(err.message)) {
      throw new RemoteHostError("CONFLICT", `name "${input.name}" already exists`);
    }
    throw err;
  }
  return rowToRemoteHost(row);
}

export async function updateHostForUser(
  userId: string,
  hostId: string,
  raw: unknown,
): Promise<RemoteHost> {
  const parsed = UpdateRemoteHostInputSchema.safeParse(raw);
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const patch = parsed.data;

  // 先确认存在(user-scoped)
  const existing = await q.getByIdForUser(userId, hostId);
  if (!existing) throw new RemoteHostError("NOT_FOUND", "remote host not found");

  // host / username 变化 → fingerprint 不再有意义,同步清掉
  const hostChanged = patch.host !== undefined && patch.host !== existing.host;
  const portChanged = patch.port !== undefined && patch.port !== existing.port;
  const userChanged = patch.username !== undefined && patch.username !== existing.username;
  const shouldResetFingerprint = hostChanged || portChanged || userChanged;

  try {
    await q.updateMeta(userId, hostId, {
      name: patch.name,
      host: patch.host,
      port: patch.port,
      username: patch.username,
      remoteWorkdir: patch.remote_workdir,
    });
  } catch (err) {
    if (err instanceof Error && /duplicate key value/i.test(err.message)) {
      throw new RemoteHostError("CONFLICT", `name "${patch.name}" already exists`);
    }
    throw err;
  }

  if (shouldResetFingerprint) {
    // R7:host/port/username 变 → host key material 也失效,整体清。
    // 下次 test 会重新 TOFU。mux manager 侧也要清 /run/.../known_hosts 文件缓存
    // (在 acquireMux 内"从 DB materialize"的路径自然覆盖)。
    await q.updateHostKeyMaterial(userId, hostId, null, null);
  }

  if (patch.password !== undefined) {
    const enc = encryptPassword(userId, hostId, patch.password);
    await q.updatePassword(userId, hostId, enc.nonce, enc.ciphertext);
  }

  const refreshed = await q.getByIdForUser(userId, hostId);
  if (!refreshed) throw new RemoteHostError("INTERNAL", "host disappeared after update");
  return rowToRemoteHost(refreshed);
}

export async function deleteHostForUser(userId: string, hostId: string): Promise<void> {
  const ok = await q.remove(userId, hostId);
  if (!ok) throw new RemoteHostError("NOT_FOUND", "remote host not found");
}

export async function resetFingerprintForUser(
  userId: string,
  hostId: string,
): Promise<RemoteHost> {
  // R7:reset 同时清 fingerprint + host_keys_text。下次 test 走完整 TOFU 路径。
  const ok = await q.updateHostKeyMaterial(userId, hostId, null, null);
  if (!ok) throw new RemoteHostError("NOT_FOUND", "remote host not found");
  const row = await q.getByIdForUser(userId, hostId);
  if (!row) throw new RemoteHostError("INTERNAL", "host disappeared after reset");
  return rowToRemoteHost(row);
}

/**
 * gateway 需要的运行时凭据:密码解密成 Buffer,由调用方用完后 .fill(0)。
 * 不走 HTTP 层,只供 ControlMaster 内部使用。
 *
 * 典型调用序列:
 *   const cred = await loadDecryptedCredential(userId, hostId);
 *   try { await useIt(cred); } finally { cred.password.fill(0); }
 */
export async function loadDecryptedCredential(
  userId: string,
  hostId: string,
): Promise<DecryptedCredential> {
  const row = await q.getByIdForUser(userId, hostId);
  if (!row) throw new RemoteHostError("NOT_FOUND", "remote host not found");
  const password = decryptPassword(userId, hostId, row.password_nonce, row.password_ct);
  return {
    hostId: row.id,
    userId: row.user_id,
    host: row.host,
    port: row.port,
    username: row.username,
    password,
    fingerprint: row.fingerprint,
    knownHostsText: row.host_keys_text,
    remoteWorkdir: row.remote_workdir,
  };
}

/**
 * gateway 侧的 SSH 探测 fn 签名。HTTP handler 通过 deps 注入。
 *
 * 返回:
 *   - ok=true + fingerprintCaptured:首次 TOFU 成功,handler 会写入 fingerprint
 *   - ok=true + fingerprintCaptured=null:已有 fingerprint 且匹配,OK
 *   - ok=false + error:连接/认证失败,handler 写 last_test_error,不动 fingerprint
 */
export interface RemoteHostTestResult {
  ok: boolean;
  error?: string | null;
  /**
   * 首次 TOFU 成功返回 fingerprint(UI 展示)+ known_hosts material(真正信任锚)。
   * 两者**必须同时返回**:service 层会一并写库,不允许只有 fingerprint 而无 keys。
   * 已锁定 fp 的探测成功 → 两项都 null(不动 DB)。
   */
  fingerprintCaptured?: string | null;
  knownHostsTextCaptured?: string | null;
}

export type RemoteHostTester = (
  cred: DecryptedCredential,
) => Promise<RemoteHostTestResult>;

/**
 * POST /:id/test 的业务流:
 *   1. 加载解密凭据
 *   2. 调 tester
 *   3. 根据结果更新 last_test_* + 可能写入 fingerprint
 *   4. 返回最新 RemoteHost 视图
 *
 * 密码 Buffer 在函数返回前 .fill(0),调用方无需关心。
 */
export async function testHostForUser(
  userId: string,
  hostId: string,
  tester: RemoteHostTester,
): Promise<{ host: RemoteHost; result: RemoteHostTestResult }> {
  const cred = await loadDecryptedCredential(userId, hostId);
  let result: RemoteHostTestResult;
  try {
    result = await tester(cred);
  } finally {
    cred.password.fill(0);
  }
  await q.updateTestResult(userId, hostId, result.ok, result.error ?? null);
  if (
    result.ok &&
    result.fingerprintCaptured &&
    result.knownHostsTextCaptured
  ) {
    // R7 Codex BLOCK 修复:必须 fingerprint + host_keys_text 同时成对写入;
    // 只有 fingerprint 没 material → /run/.../known_hosts 冷启后无法 rebuild。
    // 只在 DB 还空时写入(TOFU 首次);已锁定的不该被覆盖。
    const current = await q.getByIdForUser(userId, hostId);
    if (current && current.host_keys_text === null) {
      await q.updateHostKeyMaterial(
        userId,
        hostId,
        result.fingerprintCaptured,
        result.knownHostsTextCaptured,
      );
    }
  }
  const refreshed = await q.getByIdForUser(userId, hostId);
  if (!refreshed) throw new RemoteHostError("INTERNAL", "host disappeared after test");
  return { host: rowToRemoteHost(refreshed), result };
}
