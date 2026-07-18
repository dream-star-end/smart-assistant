// 轮询工具:一律用轮询代替死 sleep(工程要求)。到达条件即返回,超时抛错。

export interface PollOpts {
  timeoutMs: number;
  intervalMs?: number;
  label?: string;
}

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: PollOpts,
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let last: unknown;
  // 首探立即执行,不先等一个 interval。
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[poll] 超时 ${opts.timeoutMs}ms 未满足条件${opts.label ? `: ${opts.label}` : ''}` +
          (last instanceof Error ? ` (last err: ${last.message})` : ''),
      );
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

/** 仅用于轮询间隔的非阻塞等待;测试逻辑严禁裸 sleep 作为"等回复"的手段。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
