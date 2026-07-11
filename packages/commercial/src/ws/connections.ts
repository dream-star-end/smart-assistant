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

/** 连接被关闭的原因分类——决定 ws close code 与前端 UX 语义,**绝不合流**:
 *   - 'kick'    :同用户超额,踢最老连接(4505,前端提示关闭多余标签页);
 *   - 'shutdown':服务重启/发版(4509,瞬态,前端静默自动重连+resume 续传,不打扰用户)。
 *  历史教训:两者曾共用一条 close 路径(error 帧 + 4505),导致每次部署所有在线会话
 *  被钉一张"连接已断开,刷新页面"红卡 + 误报"连接数超限"。 */
export type ConnCloseCause = "kick" | "shutdown";

/**
 * 一个已注册的连接句柄。`close` 由调用方传入;本模块在"被 kick"/"shutdown"时调用它。
 * `opened_at` 用来在超限时挑"最老的一个"踢出。
 */
export interface Conn {
  /** 用于日志 / 定位的不透明 id,调用方自选(例如 request-id) */
  id: string;
  user_id: bigint | string;
  opened_at: number;
  /** 被 kick / shutdown 时调用;实现应按 cause 选 close code(kick=4505 / shutdown=4509),
   *  **不发 turn 级 error 帧**(连接态信号走 close code,不进会话正文)。幂等。 */
  close: (reason: string, cause: ConnCloseCause) => void;
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
        v.close("kicked: too many concurrent connections for this user (max=" + this.max + ")", "kick");
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

  /** 清空。服务重启/发版时调用(给每个 conn 发 cause='shutdown' 的 close——
   *  瞬态语义,前端自动重连,**不是** kick)。 */
  closeAll(reason = "server shutting down"): void {
    for (const list of this.byUser.values()) {
      for (const c of list) {
        try { c.close(reason, "shutdown"); } catch { /* */ }
      }
    }
    this.byUser.clear();
  }
}
