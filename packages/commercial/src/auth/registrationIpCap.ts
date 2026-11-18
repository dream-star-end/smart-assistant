/**
 * 同一客户端 IP 累计最多建成 3 个账号(反薅羊毛,2026-11-06 用户决策)。
 *
 * 邮箱注册和社交登录建号都走这里。只算 users.registration_ip 有值的行:0334 之前的
 * 老账号是 NULL,不占名额。
 */

import { isIP } from "node:net";
import type { PoolClient } from "pg";

export const MAX_ACCOUNTS_PER_REGISTRATION_IP = 3;

/**
 * 在建号事务内、INSERT users 之前调用。返回 false = 拒绝建号:名额用完,或拿不到合法
 * 客户端 IP(clientIpOf 取不到时是 "unknown",不能放行)。
 *
 * advisory lock 持有到事务结束,否则同 IP 并发注册会都读到"还有名额"。
 */
export async function claimRegistrationIpSlot(
  client: PoolClient,
  ip: string | undefined,
): Promise<boolean> {
  if (!ip || isIP(ip) === 0) return false;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('registration_ip:' || $1::inet::text))`,
    [ip],
  );
  const res = await client.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM users WHERE registration_ip = $1::inet',
    [ip],
  );
  return res.rows[0].n < MAX_ACCOUNTS_PER_REGISTRATION_IP;
}
