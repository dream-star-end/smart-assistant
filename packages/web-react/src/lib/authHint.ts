/**
 * 「本浏览器登录过」的非敏感标记（localStorage，值恒为 "1"，不含任何 token/身份信息）。
 *
 * 唯一用途：boot 时判断是否值得发一次 POST /api/auth/refresh 静默续期。refresh token 在
 * HttpOnly cookie 里、只有登录才会下发 —— 从未登录过的匿名访客没有它，boot 必发 refresh
 * 只会收获一个 400（控制台红错 + 白白一次请求）。标记存在 → 照旧静默续期；标记不存在 →
 * 跳过 refresh 直接未登录态。
 *
 * 写入：登录成功 / boot 静默续期成功。清除：登出（本 tab 或其它 tab 的登出广播）、
 * refresh 明确失效（INVALID_REFRESH/VALIDATION 落到未登录态）。其它 tab 写入时，未登录的
 * tab 经 subscribeAuthHintSet 重新静默续期。
 * localStorage 不可用时全部 fail-open（读作"登录过"），绝不能把已登录用户误判成匿名访客。
 */
const AUTH_HINT_KEY = "oc_auth_hint";

export function hasAuthHint(): boolean {
  try {
    return localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    return true;
  }
}

export function setAuthHint(): void {
  try {
    localStorage.setItem(AUTH_HINT_KEY, "1");
  } catch {
    /* best effort：写不进只影响下次 boot 多发一次 refresh，无功能损失 */
  }
}

export function clearAuthHint(): void {
  try {
    localStorage.removeItem(AUTH_HINT_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * 其它同源 tab 写入标记（登录 / 静默续期成功）时回调（OCV5-636）。cookie 罐全浏览器共享，
 * 停在未登录态的 tab 据此重新静默续期，不再一直停在营销首页。storage 事件只发给其它 tab，
 * 且值不变不发，所以本 tab 自己的写入、已是 "1" 时的重复写入都不会触发。
 */
export function subscribeAuthHintSet(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUTH_HINT_KEY && event.newValue === "1") listener();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
