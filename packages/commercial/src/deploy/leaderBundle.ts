// leaderBundle.ts — 全局单例职责收口(RFC-v5-dual-master-cohort D4)。
//
// 把"同一时刻全网只能有一个实例跑"的调度器(shared 域全部 + orphanReconcile + cronWake +
// wecomAlert/wecomAibot)从 composition root 的散装 eager-start 收口为一个**可幂等 start() /
// 有界 stopAndDrain()** 的 bundle。composition root 只 add() 成员(携带 deferred start 闭包),
// 真正启动由 leaseController 在竞得 lease 后回调 start();fence(lease loss)时回调 stopAndDrain。
//
// 为什么要 deferred start:双 master 下这些调度器双跑 = 双 settle / 双恢复 / 竞态。旧模型用
// controlPlaneEnabled(env)静态门,双 master 场景无法表达"此刻谁是 leader"。lease 才是唯一
// 权威——所以启动时机必须交给 lease,而非进程启动即跑。
//
// stopAndDrain 有界(默认 30s)是 lease 协议的硬前置:drain 上限 30s < fence 等待 45s,超时
// 也必须返回让位(宁可留个别 scheduler 未干净停,也不能阻塞 leader 交接;进程随后多半被 fence)。

export interface BundleMemberHandle {
  /** 停止本成员:停新 tick + 在飞 tick 等待完成(成员自身契约)。 */
  stop: () => Promise<void> | void;
}

export type BundleDomain = "shared" | "v5-owned";

export interface LeaderBundleMemberSpec {
  name: string;
  domain: BundleDomain;
  /** deferred 启动闭包;bundle 保证仅在未运行时调用(幂等)。返回运行句柄。 */
  start: () => Promise<BundleMemberHandle> | BundleMemberHandle;
}

export interface LeaderBundle {
  /** 组装期登记成员(必须在 start 前);重名 add 抛错(防漏改造成两处启动同一调度器)。 */
  add(spec: LeaderBundleMemberSpec): void;
  /** 幂等启动:已在 running/starting 态 → no-op。竞得 lease 后由 leaseController 调用。 */
  start(): Promise<void>;
  /** 有界停排(默认 30s):停新 tick + 逐个 stop;超时放弃剩余等待并返回(让位优先)。 */
  stopAndDrain(timeoutMs?: number): Promise<void>;
  isRunning(): boolean;
  /** 当前运行中的成员名(供 healthz schedulers 派生)。 */
  runningNames(): string[];
}

export interface LeaderBundleOptions {
  /** 成员启动成功回调(index.ts 用它把成员登记进 schedulerRegistry,供 healthz 派生)。 */
  onMemberStarted?: (name: string, domain: BundleDomain) => void;
  /** 成员停止回调(从 schedulerRegistry 摘除)。 */
  onMemberStopped?: (name: string) => void;
  onError?: (ctx: string, err: unknown) => void;
  logger?: { info: (m: string) => void; warn: (m: string, meta?: unknown) => void };
  now?: () => number;
}

type BundleState = "idle" | "starting" | "running" | "stopping";

const DEFAULT_DRAIN_MS = 30_000;

export function createLeaderBundle(opts: LeaderBundleOptions = {}): LeaderBundle {
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger ?? { info: () => {}, warn: () => {} };
  const specs: LeaderBundleMemberSpec[] = [];
  const running = new Map<string, BundleMemberHandle>();
  let state: BundleState = "idle";
  // 串行化 start/stop——竞得后立即 fence(start 未完就来 stopAndDrain)必须先等 start 落定
  // 再 drain,否则会漏 stop 掉 start 后半程才拉起的成员(资产泄漏 + 双跑窗口)。
  let opChain: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = opChain.then(fn, fn);
    // 吞掉链上错误传播(每个 op 自己 catch);只用它做串行屏障。
    opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function doStart(): Promise<void> {
    if (state === "running" || state === "starting") return; // 幂等
    state = "starting";
    for (const spec of specs) {
      if (running.has(spec.name)) continue;
      // start 期间被 stopAndDrain 抢占(state 翻 stopping)→ 停止继续拉起后续成员。
      if ((state as BundleState) === "stopping") break;
      try {
        const handle = await spec.start();
        // 二次检查:await 期间可能已被要求停排——若已 stopping,立即把刚起的成员停掉,不登记。
        if ((state as BundleState) === "stopping") {
          try {
            await handle.stop();
          } catch (err) {
            opts.onError?.(`bundle.rollbackStart:${spec.name}`, err);
          }
          break;
        }
        running.set(spec.name, handle);
        opts.onMemberStarted?.(spec.name, spec.domain);
      } catch (err) {
        // 单个调度器启动失败不阻断 leadership(与旧模型各自独立启动语义一致);记录后继续。
        opts.onError?.(`bundle.start:${spec.name}`, err);
        log.warn(`[leaderBundle] member start failed: ${spec.name}`, err);
      }
    }
    if ((state as BundleState) !== "stopping") {
      state = "running";
      log.info(`[leaderBundle] started members=[${[...running.keys()].join(",")}]`);
    }
  }

  async function doStop(timeoutMs: number): Promise<void> {
    if (state === "idle") return;
    state = "stopping";
    const deadline = now() + Math.max(0, timeoutMs);
    const names = [...running.keys()];
    for (const name of names) {
      const handle = running.get(name);
      if (!handle) continue;
      const remaining = deadline - now();
      if (remaining <= 0) {
        // 预算耗尽:放弃等待剩余成员的干净 stop(让位优先)。记录未停项供诊断。
        log.warn(`[leaderBundle] drain budget exhausted; abandoning stop of remaining`, {
          remaining: names.slice(names.indexOf(name)),
        });
        break;
      }
      try {
        await withDeadline(Promise.resolve(handle.stop()), remaining);
      } catch (err) {
        opts.onError?.(`bundle.stop:${name}`, err);
        log.warn(`[leaderBundle] member stop failed/timeout: ${name}`, err);
      }
      // 无论 stop 成功/超时,都从运行集与 registry 摘除(超时的成员视为已让位;不再计入 healthz)。
      running.delete(name);
      opts.onMemberStopped?.(name);
    }
    // 若上面因预算耗尽 break,把剩余成员也从 registry 摘除(它们可能仍在跑,但已不再是本实例的
    // "健康调度器"——leader 已让位)。
    for (const name of [...running.keys()]) {
      running.delete(name);
      opts.onMemberStopped?.(name);
    }
    state = "idle";
    log.info(`[leaderBundle] stopAndDrain done`);
  }

  return {
    add(spec) {
      if (specs.some((s) => s.name === spec.name)) {
        throw new Error(`[leaderBundle] duplicate member: ${spec.name}(改造漏改?同一调度器被登记两次)`);
      }
      specs.push(spec);
    },
    start() {
      return enqueue(() => doStart());
    },
    stopAndDrain(timeoutMs = DEFAULT_DRAIN_MS) {
      return enqueue(() => doStop(timeoutMs));
    },
    isRunning: () => state === "running" || state === "starting",
    runningNames: () => [...running.keys()],
  };
}

/** 给一个 promise 加超时(超时抛;不 cancel 底层——调度器 stop 无法强杀,只能放弃等待)。 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`stop timeout after ${ms}ms`));
    }, ms);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as unknown as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
