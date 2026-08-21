/**
 * 侧栏运行中置顶：组内会话、真实项目区的稳定比较。
 * 不新建「运行中」分组、不把会话搬出所属项目；default / 已归档的区位由拍平层固定。
 */

export function compareByUpdatedDesc(
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string },
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  // 时间相同按 id，避免同毫秒时在多次拍平之间对调。
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareSessionsRunningThenUpdated(
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string },
  runningIds: ReadonlySet<string>,
): number {
  const ar = runningIds.has(a.id);
  const br = runningIds.has(b.id);
  if (ar !== br) return ar ? -1 : 1;
  return compareByUpdatedDesc(a, b);
}

export function sortSessionsRunningThenUpdated<T extends { id: string; updatedAt: string }>(
  list: readonly T[],
  runningIds: ReadonlySet<string>,
): T[] {
  return list.slice().sort((a, b) => compareSessionsRunningThenUpdated(a, b, runningIds));
}

/**
 * 含运行中会话的真实项目稳定上浮：有运行的保持原相对序排在前面，其余保持原相对序。
 * 调用方只应传入真实项目（不含虚拟 default）。
 */
export function partitionProjectsRunningFirst<T extends { id: string }>(
  projects: readonly T[],
  hasRunning: (projectId: string) => boolean,
): T[] {
  const running: T[] = [];
  const rest: T[] = [];
  for (const p of projects) {
    if (hasRunning(p.id)) running.push(p);
    else rest.push(p);
  }
  return running.length === 0 ? (projects as T[]) : running.concat(rest);
}
