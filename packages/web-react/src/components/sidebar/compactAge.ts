const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 侧栏紧凑时长：<1m → `1m`；<60m → `Nm`；<24h → `Nh`；否则 `Nd`。不出现 `0m` 或秒。 */
export function formatCompactAge(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MIN))}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

/** 运行中优先本轮开始；拿不到则 lastAt，再回落 updatedAt。 */
export function sessionAgeTimestamp(
  session: { lastAt?: number; updatedAt?: string },
  running: boolean,
  runStartedAt?: number,
): number | null {
  if (running && typeof runStartedAt === "number" && Number.isFinite(runStartedAt) && runStartedAt > 0) {
    return runStartedAt;
  }
  if (typeof session.lastAt === "number" && Number.isFinite(session.lastAt)) return session.lastAt;
  if (session.updatedAt) {
    const t = Date.parse(session.updatedAt);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
