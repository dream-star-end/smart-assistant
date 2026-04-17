/**
 * T-40 — 每用户 WS 连接管理。
 *
 * 规约(01-SPEC F-6.5,04-API §11):
 *   - 同用户最多 3 个并发 `/ws/chat` 连接
 *   - 开第 4 个 → **把最老的那个 kick 掉**(发 error frame + close 1008)
 *
 * 不用 Redis(同用户在同一 gateway 实例即可 — MVP 单机,后续多机再谈)。
 *
 * API 极小:`register / unregister`。关闭老连接用回调,避免本模块直接依赖 ws lib。
 */

export const DEFAULT_MAX_PER_USER = 3;

/**
 * 一个已注册的连接句柄。`close` 由调用方传入;本模块在"被 kick"时调用它。
 * `opened_at` 用来在超限时挑"最老的一个"踢出。
 */
export interface Conn {
  /** 用于日志 / 定位的不透明 id,调用方自选(例如 request-id) */
  id: string;
  user_id: bigint | string;
  opened_at: number;
  /** 被 kick 时调用;应发送一个 error frame 然后 close(code=1008)。幂等。 */
  close: (reason: string) => void;
}

export interface RegisterResult {
  /** 本连接被注册成功后的 unregister 函数。连接关闭时务必调用,避免 registry 泄漏。 */
  unregister: () => void;
  /** 本次注册踢出的旧连接(0 或多个)。调用方可用于观测/日志。 */
  evicted: Conn[];
}

/**
 * 每用户 conn 集合,注册时自动挤出最老连接。
 *
 * 并发模型:Node.js 单线程事件循环内所有方法都是原子的 —— 即使两个 ws upgrade 在同一 tick,
 * handler 的 register 调用也在 microtask 里串行化,不会真正"同时"。所以无需额外锁。
 */
export class ConnectionRegistry {
  private byUser = new Map<string, Conn[]>();
  private readonly max: number;

  constructor(opts: { maxPerUser?: number } = {}) {
    this.max = opts.maxPerUser ?? DEFAULT_MAX_PER_USER;
    if (this.max < 1) {
      throw new RangeError("maxPerUser must be >= 1");
    }
  }

  /**
   * 注册新连接。若超额 → 踢最老的,剩下的 + 新连接 <= max。
   *
   * 返回 { unregister, evicted }。调用方在 ws close 时务必 unregister()。
   */
  register(conn: Conn): RegisterResult {
    const key = String(conn.user_id);
    const list = this.byUser.get(key) ?? [];
    const evicted: Conn[] = [];
    // 新连接入队后可能超过 max → 挑最旧的开始踢,直到 size == max
    list.push(conn);
    // sort 按 opened_at 升序(最早的在前);稳定即可
    list.sort((a, b) => a.opened_at - b.opened_at);
    while (list.length > this.max) {
      const victim = list.shift();
      if (victim) evicted.push(victim);
    }
    this.byUser.set(key, list);

    // 立即 kick,但注意:`close` 由调用方实现,我们不在这里 await —— ws.close 是
    // 非阻塞的。若 close 抛出我们吞掉(不能让 kick 的副作用污染 register 路径)。
    for (const v of evicted) {
      try {
        v.close("kicked: too many concurrent connections for this user (max=" + this.max + ")");
      } catch {
        /* close 实现问题,不是我们的错 */
      }
    }

    let unregistered = false;
    const unregister = (): void => {
      if (unregistered) return;
      unregistered = true;
      const curr = this.byUser.get(key);
      if (!curr) return;
      const idx = curr.findIndex((c) => c.id === conn.id);
      if (idx >= 0) curr.splice(idx, 1);
      if (curr.length === 0) this.byUser.delete(key);
    };

    return { unregister, evicted };
  }

  /** 当前某用户持有的活跃连接数。测试用。 */
  count(userId: bigint | string): number {
    return this.byUser.get(String(userId))?.length ?? 0;
  }

  /** 所有用户总连接数。测试/指标用。 */
  total(): number {
    let n = 0;
    for (const l of this.byUser.values()) n += l.length;
    return n;
  }

  /** 清空。shutdown 时调用(给每个 conn 发 close)。 */
  closeAll(reason = "server shutting down"): void {
    for (const list of this.byUser.values()) {
      for (const c of list) {
        try { c.close(reason); } catch { /* */ }
      }
    }
    this.byUser.clear();
  }
}
