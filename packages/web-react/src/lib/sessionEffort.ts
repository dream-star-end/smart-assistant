/**
 * 思考档位(effortLevel)的**会话级**持久化。
 *
 * 权威语义(与 lib/teamMode 同模式):
 *  - 每个会话独立的档位记忆,键 `oc_v5_effort:<sessionId>`:
 *      - 缺键 = 该会话从未显式选择 → 发送时回落用户全局偏好(preferences.default_effort);
 *      - `"-"` = 显式「跟随模型默认」→ 发送 effortLevel:null(协议语义 = 清除已有
 *        档位,让 runner 回到模型自身默认;关掉不能删键,否则会退回全局偏好,破坏
 *        「本会话关掉不影响继承语义」);
 *      - `"low"|"medium"|"high"|"xhigh"|"max"` = 显式档位。
 *  - 与 teamMode 不同,effort 的全局继承源是**服务端 preferences.default_effort**
 *    (已有权威,不另立全局 localStorage 键);因此只有用户显式选择后才落 per-session 键。
 *  - sessionId 为空(空会话态):读写只作用于内存 state,首条消息创建会话后由 App
 *    在显式选择存在时落地。
 *
 * 后端零改动:effortLevel 本就是 inbound.message 顶层路由字段(每条消息可切,切换 =
 * 重建 runner env);本模块只管前端持久化与继承规则。
 */
import type { PreferenceEffort } from "./modelPreferences";

const EFFORT_SESSION_PREFIX = "oc_v5_effort:";
/** 显式「跟随模型默认」的落盘占位(区别于「未选择」的缺键)。 */
const EFFORT_FOLLOW_MODEL = "-";

const VALID: readonly PreferenceEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function effortSessionKey(sessionId: string): string {
  return `${EFFORT_SESSION_PREFIX}${sessionId}`;
}

/**
 * 读某会话的显式档位:undefined = 未选择(继承全局偏好);null = 显式跟随模型默认;
 * 档位值 = 显式选择。localStorage 不可用 / 值非法 → undefined(保守:当作未选择)。
 */
export function readSessionEffort(sessionId: string | undefined): PreferenceEffort | null | undefined {
  if (!sessionId) return undefined;
  try {
    const v = localStorage.getItem(effortSessionKey(sessionId));
    if (v === null) return undefined;
    if (v === EFFORT_FOLLOW_MODEL) return null;
    return (VALID as readonly string[]).includes(v) ? (v as PreferenceEffort) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 写某会话的显式档位(null = 跟随模型默认)。best-effort,失败不抛(内存选择仍生效)。
 */
export function writeSessionEffort(
  sessionId: string | undefined,
  value: PreferenceEffort | null,
): void {
  if (!sessionId) return;
  try {
    localStorage.setItem(effortSessionKey(sessionId), value ?? EFFORT_FOLLOW_MODEL);
  } catch {
    // Storage 只是最佳努力;写失败不影响内存状态。
  }
}

/** 删除某会话的 per-session 键(会话删除时顺手清,避免键无限堆积)。best-effort。 */
export function clearSessionEffort(sessionId: string): void {
  try {
    localStorage.removeItem(effortSessionKey(sessionId));
  } catch {
    // best-effort
  }
}
