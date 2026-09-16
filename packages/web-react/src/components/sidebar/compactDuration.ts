const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 会话紧凑用时（中文单位，SR-01）：<1 分 → `1分`；<60 分 → `N分`；<24 时 → `N小时`；否则 `N天`。 */
export function formatCompactDuration(durationMs: number): string {
  const duration = Math.max(0, durationMs);
  if (duration < HOUR) return `${Math.max(1, Math.floor(duration / MIN))}分`;
  if (duration < DAY) return `${Math.floor(duration / HOUR)}小时`;
  return `${Math.floor(duration / DAY)}天`;
}

export type SessionDurationWindow = {
  startAt: number;
  endAt: number;
};

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 侧栏展示整段会话生命周期：createdAt → lastAt；运行中则 createdAt → 当前时间。
 * createdAt 不存在时不伪造用时；结束时刻缺失才回落 updatedAt。
 */
export function sessionDurationWindow(
  session: { createdAt?: number; lastAt?: number; updatedAt?: string },
  running: boolean,
  nowMs: number,
): SessionDurationWindow | null {
  const startAt = finitePositive(session.createdAt);
  if (startAt == null) return null;

  let endAt = running ? finitePositive(nowMs) : finitePositive(session.lastAt);
  if (endAt == null && session.updatedAt) {
    const parsed = Date.parse(session.updatedAt);
    if (Number.isFinite(parsed) && parsed > 0) endAt = parsed;
  }
  if (endAt == null) return null;
  return { startAt, endAt: Math.max(startAt, endAt) };
}
