// 训练 run 重入选择器 —— 纯函数，供 SkillOptPanel 在挂载时从「全部训练 run」里
// 挑出「当前技能」最近一条可恢复的 run。抽成纯函数是为了可单测且与 UI 解耦。
import type { SkillTrainRun } from "./types";

/**
 * 可恢复的训练 run：
 * - active(queued|running)：进行中 → 恢复轮询；
 * - draft(diff_ready)：有未处理草稿 → 恢复 diff 面板入口 + 提示条。
 * merged/discarded/failed 是终态，不可恢复。
 */
export type ResumableTrainRun = { run: SkillTrainRun; kind: "active" | "draft" };

/**
 * 从训练 run 列表里挑出「当前技能」最近一条可恢复 run。
 * runs 后端已按 startedAt 降序返回；此处仍防御性再排一次（不依赖后端顺序），
 * 取命中项中 startedAt 最大的一条。无匹配返回 null（保持现状不变）。
 */
export function pickResumableTrainRun(
  runs: readonly SkillTrainRun[],
  skillName: string,
): ResumableTrainRun | null {
  const first = runs
    .filter(
      (r) =>
        r.skillName === skillName &&
        (r.status === "queued" || r.status === "running" || r.status === "diff_ready"),
    )
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  if (!first) return null;
  return { run: first, kind: first.status === "diff_ready" ? "draft" : "active" };
}
