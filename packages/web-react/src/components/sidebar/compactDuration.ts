const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 会话紧凑用时：<1m → `1m`；<60m → `Nm`；<24h → `Nh`；否则 `Nd`。 */
export function formatCompactDuration(durationMs: number): string {
  const duration = Math.max(0, durationMs);
  if (duration < HOUR) return `${Math.max(1, Math.floor(duration / MIN))}m`;
  if (duration < DAY) return `${Math.floor(duration / HOUR)}h`;
  return `${Math.floor(duration / DAY)}d`;
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
