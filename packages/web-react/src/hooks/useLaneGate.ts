import { useEffect, useState } from "react";

/**
 * lane 决策 3s 超时兜底（P3 RFC D1）：已认证但迟迟拿不到 lane 决策时，按 ready 放行并 warn，
 * **杜绝 WS 因 lane 闸永久阻塞**（宁可首连落 active slot 由 cookie 后续纠正，也不死锁）。
 */
export const LANE_DECISION_TIMEOUT_MS = 3000;

/**
 * cohort 分批切流 lane 就绪闸（P3 RFC D1）。socket 建 WS 的前置之一：只有 lane 决策达成
 * （cookie 已由服务端 Set-Cookie 下发）才建连，避免首连落错 slot 再被 cookie 纠正的抖动。
 *
 * 语义（单一权威，抽独立 hook 便于时序单测）：
 *  - `active=false`（未认证/demo/登出）→ 恒 false（无需 lane，socket 也不会连）；
 *  - `laneSignal===undefined`（已认证但尚未处理到任何 auth 响应的 lane 字段）→ 决策进行中，
 *    arm 3s 定时器，到点兜底放行 + console.warn；
 *  - `laneSignal={lane}`（已拿到 auth 响应）→ **无论字段是 string 还是 null（字段缺失=后端未
 *    部署 lane=向后兼容）都算已决策**，立即 ready，并清除任何在途兜底定时器（flap/快速登录零残留）。
 *
 * 一旦 ready 不因内容变化再被拦截；`active` 落回 false（登出）即复位，下次认证重新走决策。
 */
export function useLaneGate(
  active: boolean,
  laneSignal: { lane: string | null } | undefined,
): boolean {
  const [timedOut, setTimedOut] = useState(false);
  // 已决策 = 拿到了 auth 响应（present 或字段缺失都算，见 doc）。
  const decided = laneSignal !== undefined;

  useEffect(() => {
    // 无需等待（未激活或已决策）：清除兜底态，cleanup 会清掉在途定时器（flap 旧 timer 必清）。
    if (!active || decided) {
      setTimedOut(false);
      return;
    }
    const t = setTimeout(() => {
      console.warn(
        "[laneReady] lane 决策 3s 未达，按 ready 兜底放行（向后兼容，防 WS 永久阻塞）",
      );
      setTimedOut(true);
    }, LANE_DECISION_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [active, decided]);

  if (!active) return false;
  return decided || timedOut;
}
