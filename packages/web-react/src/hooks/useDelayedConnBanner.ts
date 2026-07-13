import { useEffect, useState } from "react";
import type { ConnBanner } from "../lib/chat/pure";

/** 连接横幅显示延迟（P3 RFC D6）：断开持续 > 本值才点亮横幅，2s 内重连成功零闪烁。 */
export const CONN_BANNER_DELAY_MS = 2000;

/**
 * 连接横幅 2s 延迟消费侧（P3 RFC D6）。deriveConnBanner 仍**立即**反映断线真相——断线排队/
 * 禁发等发送语义据此，绝不受本延迟影响；本 hook 只推迟**横幅的可见性**：
 *  - 断开 < delayMs 内重连成功（raw 回 null）→ 定时器清除，横幅从不出现（零闪烁）；
 *  - flap（断-连-断）→ 每次"连上/无需显示"都清旧 timer（cleanup + 立即隐藏），迟到的旧
 *    timer 不会误点亮横幅；
 *  - 一旦点亮，横幅内容（倒计时/文案）随 raw 实时更新，不被延迟二次拦截。
 *
 * 只作用于连接横幅，不掩盖 HTTP 错误 toast。用稳定布尔 `active`（是否有横幅要显示）作 effect
 * 依赖，避免 raw 每渲染新对象（倒计时刷新）反复重置计时器导致横幅永不点亮。
 */
export function useDelayedConnBanner(
  raw: ConnBanner,
  delayMs = CONN_BANNER_DELAY_MS,
): ConnBanner {
  const [shown, setShown] = useState(false);
  const active = raw !== null;

  useEffect(() => {
    if (!active) {
      setShown(false); // 连上/无需显示：立即隐藏 + cleanup 清 pending timer
      return;
    }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);

  return shown ? raw : null;
}
