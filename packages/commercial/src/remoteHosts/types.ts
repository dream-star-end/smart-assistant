/**
 * 远程执行机 (Remote SSH Host) 共享类型。
 *
 * DB 行 vs 上层视图的 mapping 集中在本文件:
 *   - RemoteHostRow: pg 行的 snake_case,与 migration 0028 对齐
 *   - RemoteHost: 业务层使用的 camelCase 视图,**不含密码**
 *   - DecryptedCredential: 运行时解密后的密码 + 握手上下文,生命周期严格限制在
 *     gateway 进程内存,绝不进 DB / env / log。
 */

export interface RemoteHostRow {
  id: string;
  user_id: string; // bigint 从 pg 读出是字符串
  name: string;
  host: string;
  port: number;
  username: string;
  remote_workdir: string;
  password_nonce: Buffer;
  password_ct: Buffer;
  fingerprint: string | null;
  /**
   * R7 Codex BLOCK 修复:完整的 known_hosts material —— `ssh-keyscan` 原始多行输出。
   * 这才是 `StrictHostKeyChecking=yes` 真正的信任锚;fingerprint 只是 UI 展示。
   * migration 0029 添加;NULL 表示"未 TOFU"。
   */
  host_keys_text: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** 前端/REST 返回的安全视图:无密码字段。 */
export interface RemoteHost {
  id: string;
  userId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  remoteWorkdir: string;
  fingerprint: string | null;
  /**
   * 前端一般只看 fingerprint 做 UI 展示,不需要原始 key material。但 admin 排障
   * 场景(例如看同步失败)可能用得到,故透出;hasHostKeys 布尔也可以,但字符串
   * 大小不大(~500B per host),直接回传省一个字段。
   */
  hasHostKeys: boolean;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastUsedAt: string | null; // ISO
  createdAt: string;
  updatedAt: string;
}

/** 运行时凭据 —— 只在 gateway 内存中存在,不序列化。 */
export interface DecryptedCredential {
  hostId: string;
  userId: string;
  host: string;
  port: number;
  username: string;
  /** 明文密码,用完立即 .fill(0) 清零。 */
  password: Buffer;
  /** TOFU 指纹,UI 展示用(允许 null 走首次握手)。 */
  fingerprint: string | null;
  /**
   * R7:完整 known_hosts material。null 表示首次连接(需要 ssh-keyscan TOFU);
   * 非 null 时 mux 先把这串 material 原样 materialize 到 `/run/ccb-ssh/.../known_hosts`
   * 再起 ssh 进程。
   */
  knownHostsText: string | null;
  remoteWorkdir: string;
}

export function rowToRemoteHost(r: RemoteHostRow): RemoteHost {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    remoteWorkdir: r.remote_workdir,
    fingerprint: r.fingerprint,
    hasHostKeys: r.host_keys_text !== null,
    lastTestOk: r.last_test_ok,
    lastTestError: r.last_test_error,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
