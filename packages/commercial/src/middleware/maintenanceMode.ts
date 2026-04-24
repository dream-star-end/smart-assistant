/**
 * V3 Phase 4H+ — maintenance_mode 中间件(HTTP + WS 共用)。
 *
 * 背景(2026-04-25 audit P0-2):
 *   system_settings.maintenance_mode=true 配了但**没有接入执行**。admin 在 UI 上
 *   按下"开启维护模式",后端完全不生效,所有请求照常通过。该中间件承担起真正
 *   拦截非 admin 流量的职责,同时保留 admin 运维通道。
 *
 * 行为:
 *   - `maintenance_mode=true`(system_settings 读到):
 *       · anonymous:返 503 MAINTENANCE
 *       · 非 admin 身份(user / reviewer / 其它 role):返 503 MAINTENANCE
 *       · admin 身份 JWT + DB double-check 通过:放行
 *       · admin JWT 在手但 DB 里已撤权 / banned:返 503 MAINTENANCE(不泄露 403)
 *   - `maintenance_mode=false`:直接放行(等价无中间件)
 *
 * 缓存:
 *   每请求查 DB 显然吃不消(MVP 也不至于)。用 60s 进程内缓存,admin 改了
 *   maintenance_mode 后最坏 60s 生效。admin 按下开关立刻对自己会话生效的
 *   路径:admin JWT→DB 校验本身也 60s 之后才确认,但 admin bypass 逻辑本来就
 *   放行,所以**admin 自己不受维护模式影响**是 2 重保障(admin 在设置页点完开关
 *   立刻在同一 tab 跑其它 API 仍然能用)。
 *
 * 安全护栏:
 *   - admin 判定必须 DB 双查(requireAdminVerifyDb):JWT 还没过期但 DB 里被撤
 *     admin 的情况下,维护模式必须按"非 admin"对待;避免"降权 24h 内仍可绕过
 *     维护模式"的漏洞。
 *   - 任何 admin 判定失败一律当"非 admin"处理,返 503 MAINTENANCE 而不是
 *     401/403 —— 避免对外暴露"当前到底什么人在登录 / token 格式"的探测信号。
 *   - 路由层面由调用方用 allowlist 保留 /healthz + /api/admin/* 的 bypass。
 */

import type { IncomingMessage } from "node:http";
import { getSystemSetting } from "../admin/systemSettings.js";
import { verifyCommercialJwtSync } from "../auth/jwtSync.js";
import { requireAdminVerifyDb } from "../admin/requireAdmin.js";

// ─── 60s 进程内缓存 ───────────────────────────────────────────────────
let _cachedValue: boolean | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * 读 maintenance_mode 开关,60s 进程内缓存。
 *
 * 出错 fail-open:读取失败(DB 挂)→ false,避免维护模式误触发把站打挂。
 * 如果真想维护,admin 照常生效 DB 恢复后自然拿到 true。
 */
export async function isInMaintenance(): Promise<boolean> {
  const now = Date.now();
  if (_cachedValue !== null && now - _cachedAt < CACHE_TTL_MS) {
    return _cachedValue;
  }
  try {
    const r = await getSystemSetting("maintenance_mode");
    _cachedValue = r.value === true;
    _cachedAt = now;
    return _cachedValue;
  } catch {
    // DB 故障 → fail-open(别把网站关掉只因 DB hiccup)
    _cachedValue = false;
    _cachedAt = now;
    return false;
  }
}

/**
 * 清空缓存(测试用)。生产代码不应调,让 60s 自然过期即可。
 */
export function _clearMaintenanceCache(): void {
  _cachedValue = null;
  _cachedAt = 0;
}

/**
 * 判定请求是否来自 "active admin"。
 *   true  → 放行(维护模式也能打穿)
 *   false → 按非 admin 处理(应返 503 MAINTENANCE)
 *
 * 内部捕获任何异常都返 false —— JWT 失败 / DB 查不到 / role 被撤 / status 非 active
 * 都当"不是 admin"处理。**不抛错**,不泄露 401/403 细节。
 */
export async function isActiveAdmin(
  req: IncomingMessage,
  token: string,
  jwtSecret: string | Uint8Array,
): Promise<boolean> {
  if (!token) return false;
  const claims = verifyCommercialJwtSync(token, jwtSecret);
  if (!claims || claims.role !== "admin") return false;
  try {
    await requireAdminVerifyDb(req, jwtSecret);
    return true;
  } catch {
    return false;
  }
}
