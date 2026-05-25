/**
 * v3 反关联根治 — 灰度型 feature flag 的运行时读取层(v1.0.207)。
 *
 * 把 `phase6_account_uuid_enforce` / `session_pin_mode` 从 commercial.env(restart
 * 才生效)迁到 `system_settings` 表(管理后台 admin UI 立即可改),需要解决
 * **热路径不能每请求一次 DB 读**的问题 — pickUpstream 是 chat request hot path,
 * 每秒几十~上百 QPS,直查 system_settings 即使 1-2ms 也累计浪费。
 *
 * 设计:
 *   - 单 key in-process 30s TTL cache(Map<SystemSettingKey, {value, expiresAt}>)
 *   - `getSessionPinMode()` / `getPhase6AccountUuidEnforce()` 作为 deps getter
 *     注入到 makeAnthropicProxyHandler,pickUpstream 入口 await 一次后冻结到局部
 *     常量(保留 scheduler.pick 与 hook 闭包同值的竞态防护设计,plan §5.5.4)
 *   - 管理后台 PUT /api/admin/settings/:key 成功后调 `invalidateRuntimeFlagsCache()`,
 *     本机进程立即看到新值;跨 master 进程走 30s TTL 自然收敛(KL 当前单 master prod,
 *     无跨进程问题。未来双活可再引入 LISTEN/NOTIFY)
 *
 * 为什么不放在 systemSettings.getSystemSetting 里加 cache:
 *   - 其它 key(maintenance_mode / allow_registration 等)的 admin 改动期待**立即**
 *     生效,不能容忍 30s 延迟。此处 cache 只针对灰度 flag,narrow scope。
 */

import type { SystemSettingKey, SystemSettingValue } from "./systemSettings.js";
import { DEFAULTS, getSystemSetting } from "./systemSettings.js";

const TTL_MS = 30_000;

type CacheEntry = { value: unknown; expiresAt: number };

const cache = new Map<SystemSettingKey, CacheEntry>();

/**
 * Internal seam — 测试通过 `__setReaderForTest(fakeReader)` 注入假的 DB 读取器,
 * 不需要 node:test 实验性 module mock。production 永远走 getSystemSetting。
 */
type Reader = <K extends SystemSettingKey>(
  key: K,
) => Promise<{ value: SystemSettingValue<K> }>;

let reader: Reader = (key) => getSystemSetting(key);

/**
 * 读 key:命中且未过期 → 返 cache 值;否则查 DB 并刷新 cache。
 *
 * 失败语义:
 *   - `getSystemSetting` 内部已做 schema 兜底:row 不存在 → DEFAULTS,
 *     row 值不通过 zod → 也回 DEFAULTS。这两类不会走到 catch。
 *   - 但 PG 自身瞬时不可用(connection refused / pool exhausted / 网络抖动)会
 *     让底层 `query()` throw,Codex round 2 BLOCK 指出:throw 会跨过 pickUpstream
 *     的 PickError 契约,let preCheck reservation leak。
 *   - 这里 catch:回 DEFAULTS(等同 row 不存在的语义)+ **不写 cache**,
 *     下次 call 重试 → PG 恢复后立即拿到真值。
 *
 * 为什么 fail-open 到 DEFAULTS('off')而不是 fail-closed:
 *   - 项目宗旨"反风控不能以牺牲用户体验为代价";PG 瞬时抖动时让 chat 热路径 500
 *     是用 UX 换微秒级窗口的"防风控更严",得不偿失。
 *   - "off" 与 row 不存在等价,语义对称、不引入第三种状态。
 */
async function readCached<K extends SystemSettingKey>(
  key: K,
): Promise<SystemSettingValue<K>> {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.value as SystemSettingValue<K>;
  }
  let row: { value: SystemSettingValue<K> };
  try {
    row = await reader(key);
  } catch {
    // 不 cache:下次 call 重试,避免 30s 内一直 fail-open
    return DEFAULTS[key];
  }
  cache.set(key, { value: row.value, expiresAt: now + TTL_MS });
  return row.value;
}

export function getSessionPinMode(): Promise<SystemSettingValue<"session_pin_mode">> {
  return readCached("session_pin_mode");
}

export function getPhase6AccountUuidEnforce(): Promise<
  SystemSettingValue<"phase6_account_uuid_enforce">
> {
  return readCached("phase6_account_uuid_enforce");
}

/**
 * 清空所有 runtime flag cache,让下次 getXxx() 重新走 DB。
 *
 * 由 `handleAdminPutSetting` 在 setSystemSetting 成功后调用,确保 admin 改完
 * 本机进程后续请求立即看到新值。无视 key 是否相关 — 反正只有 2 个 entry,
 * 清空成本可忽略。
 */
export function invalidateRuntimeFlagsCache(): void {
  cache.clear();
}

// ─── 测试用 ─────────────────────────────────────────────────────────────
// production 代码不应调这些;只给 runtimeFlags.test.ts 注入假 reader / 探针。

export function __setReaderForTest(r: Reader | null): void {
  reader = r ?? ((key) => getSystemSetting(key));
}

export const __test_only_cache = cache;
export const __test_only_TTL_MS = TTL_MS;
