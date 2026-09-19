import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";

type GoalStartDeps = {
  isBusy: () => boolean;
  save: () => Promise<GoalStateSnapshot>;
  apply: (goal: GoalStateSnapshot) => void;
  start: (goal: GoalStateSnapshot) => Promise<void>;
};

/** One explicit UI action, not a snapshot effect: loading/reconnecting never starts work.
 * Capture busy before saving as well as after it. A running turn finishing during the
 * save must not turn a goal edit into an extra prompt. Same-session concurrent clicks
 * share the operation; the existing send path owns dispatch, offline queue and retries.
 */
export function createGoalStarter() {
  const pending = new Map<string, Promise<void>>();
  return (sessionId: string, deps: GoalStartDeps): Promise<void> => {
    const existing = pending.get(sessionId);
    if (existing) return existing;
    const wasBusy = deps.isBusy();
    const operation = Promise.resolve().then(async () => {
      const goal = await deps.save();
      deps.apply(goal);
      if (goal.status !== "active" || wasBusy || deps.isBusy()) return;
      try {
        await deps.start(goal);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "发送失败";
        throw new Error(`目标已保存，但未能启动：${reason}。可再次点击保存重试。`);
      }
    }).finally(() => { pending.delete(sessionId); });
    pending.set(sessionId, operation);
    return operation;
  };
}
