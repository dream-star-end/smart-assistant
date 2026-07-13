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
// 【R1 BLOCKER 1 修订——两条硬语义】
//  ① start-all-or-fail:required 成员 start 抛错 → **回滚已启动成员** + 抛错。leaseController 据此
//     step-down + fail-stop(绝不带"半启动的 leader"运行:少跑一个 shared mutator = 该职责在
//     双 master 窗口内静默真空)。best-effort 成员(required:false)保留旧"失败不阻断"语义。
//  ② stopAndDrain 返回 {drained, stuck}:预算耗尽(默认 30s)时**不摘除仍在跑的成员**并谎报成功,
//     而是返回 {drained:false, stuck:[names]}。leaseController 收到 drained:false → 不写 ACK / 不
//     unlock / 进程 fail-stop —— 后继 holder 经 PID 三元组确认旧进程死亡后才接管(协议已支持)。
//     "超时也让位"曾是设计意图,但让位的前提是**旧 mutator 确已停**;stuck 成员可能仍在写共享
//     状态,此时交权 = 双跑。宁可 fail-stop 等 liveness 确认,也不带 stuck 成员交权。

export interface BundleMemberHandle {
  /** 停止本成员:停新 tick + 在飞 tick 等待完成(成员自身契约)。 */
  stop: () => Promise<void> | void;
}

export type BundleDomain = "shared" | "v5-owned";

export interface LeaderBundleMemberSpec {
  name: string;
  domain: BundleDomain;
  /**
   * required(默认 true):start 抛错 → 整 bundle 回滚已启动成员 + 抛错(start-all-or-fail)。
   * 单 leader 语义下这些都是"少跑一个 = 该职责全网真空"的关键调度器,默认关键。
   * 显式 false=best-effort(start 失败仅 log 继续,与旧 eager 语义一致)。
   */
  required?: boolean;
  /** deferred 启动闭包;bundle 保证仅在未运行时调用(幂等)。返回运行句柄。 */
  start: () => Promise<BundleMemberHandle> | BundleMemberHandle;
}

/** stopAndDrain 结果:drained=false 时 stuck 列出预算内未干净停的成员(leaseController fail-stop 依据)。 */
export interface DrainResult {
  drained: boolean;
  stuck: string[];
}

export interface LeaderBundle {
  /** 组装期登记成员(必须在 start 前);重名 add 抛错(防漏改造成两处启动同一调度器)。 */
  add(spec: LeaderBundleMemberSpec): void;
  /** 幂等启动:已在 running/starting 态 → no-op。竞得 lease 后由 leaseController 调用。required 成员失败 → 回滚 + 抛。 */
  start(): Promise<void>;
  /** 有界停排(默认 30s):停新 tick + 逐个 stop;超时 → {drained:false, stuck}(**不摘除 stuck**)。 */
  stopAndDrain(timeoutMs?: number): Promise<DrainResult>;
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
  /** required start 失败后的回滚总预算；生产默认与正常 drain 相同，测试可缩短。 */
  startupRollbackMs?: number;
}

type BundleState = "idle" | "starting" | "running" | "stopping";

const DEFAULT_DRAIN_MS = 30_000;

/**
 * required member 启动失败且已启动成员未能在预算内停净。
 * lease controller 必须识别此错误并保持 advisory lock，直接 fail-stop；绝不能先 unlock。
 */
export class LeaderBundleRollbackIncompleteError extends Error {
  readonly code = "OC_LEADER_BUNDLE_ROLLBACK_INCOMPLETE";

  constructor(
    readonly failedMember: string,
    readonly stuck: string[],
    options?: ErrorOptions,
  ) {
    super(
      `[leaderBundle] required member ${failedMember} start failed and rollback incomplete: stuck=[${stuck.join(",")}]`,
      options,
    );
    this.name = "LeaderBundleRollbackIncompleteError";
  }
}

export function createLeaderBundle(opts: LeaderBundleOptions = {}): LeaderBundle {
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger ?? { info: () => {}, warn: () => {} };
  const specs: LeaderBundleMemberSpec[] = [];
  const running = new Map<string, BundleMemberHandle>();
  let state: BundleState = "idle";
  // 串行化 start/stop——竞得后立即 fence(start 未完就来 stopAndDrain)必须先等 start 落定
  // 再 drain,否则会漏 stop 掉 start 后半程才拉起的成员(资产泄漏 + 双跑窗口)。
  let opChain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = opChain.then(fn, fn);
    // 吞掉链上错误传播(每个 op 自己 catch);只用它做串行屏障。
    opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 停掉一个已启动成员(回滚 / drain 共用);best-effort,不抛。 */
  async function stopMember(name: string, handle: BundleMemberHandle, budgetMs?: number): Promise<boolean> {
    try {
      const p = Promise.resolve(handle.stop());
      if (budgetMs !== undefined) {
        await withDeadline(p, budgetMs);
      } else {
        await p;
      }
      return true;
    } catch (err) {
      opts.onError?.(`bundle.stop:${name}`, err);
      log.warn(`[leaderBundle] member stop failed/timeout: ${name}`, err);
      return false;
    }
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
          await stopMember(spec.name, handle);
          break;
        }
        running.set(spec.name, handle);
        opts.onMemberStarted?.(spec.name, spec.domain);
      } catch (err) {
        const required = spec.required !== false;
        if (required) {
          // start-all-or-fail:关键成员起不来 = 不能带"半启动的 leader"运行。回滚已起成员后抛,
          // 让 leaseController step-down + fail-stop(systemd 拉起后以 standby 重来)。
          opts.onError?.(`bundle.start:${spec.name}`, err);
          log.warn(`[leaderBundle] required member start FAILED, rolling back bundle: ${spec.name}`, err);
          const rollback = await doStop(opts.startupRollbackMs ?? DEFAULT_DRAIN_MS);
          if (!rollback.drained) {
            throw new LeaderBundleRollbackIncompleteError(spec.name, rollback.stuck, {
              cause: err,
            });
          }
          throw err instanceof Error
            ? err
            : new Error(`[leaderBundle] required member start failed: ${spec.name}`);
        }
        // best-effort 成员:失败不阻断其余(与旧 eager 语义一致);记录后继续。
        opts.onError?.(`bundle.start:${spec.name}`, err);
        log.warn(`[leaderBundle] best-effort member start failed (continuing): ${spec.name}`, err);
      }
    }
    if ((state as BundleState) !== "stopping") {
      state = "running";
      log.info(`[leaderBundle] started members=[${[...running.keys()].join(",")}]`);
    }
  }

  async function doStop(timeoutMs: number): Promise<DrainResult> {
    if (state === "idle") return { drained: true, stuck: [] };
    state = "stopping";
    const deadline = now() + Math.max(0, timeoutMs);
    const names = [...running.keys()];
    const stuck: string[] = [];
    for (const name of names) {
      const handle = running.get(name);
      if (!handle) continue;
      const remaining = deadline - now();
      if (remaining <= 0) {
        // 预算耗尽:剩余成员全部标记 stuck(**不 stop、不摘除**——它们可能仍在写共享状态)。
        // leaseController 见 drained:false → 不交权、fail-stop,后继经 PID liveness 确认死亡才接管。
        const rest = names.slice(names.indexOf(name));
        for (const r of rest) if (running.has(r)) stuck.push(r);
        break;
      }
      const ok = await stopMember(name, handle, remaining);
      if (ok) {
        // 干净停 → 摘除(不再计入 healthz)。
        running.delete(name);
        opts.onMemberStopped?.(name);
      } else {
        // stop 抛错/超时:视为未干净停(可能仍在跑)→ 标 stuck,保留在 running(不谎报让位)。
        stuck.push(name);
      }
    }
    if (stuck.length > 0) {
      // fail-stop 路径:进程即将退出,不改 state(保持诊断快照);stuck 成员留在 running。
      log.warn(`[leaderBundle] stopAndDrain 未干净停(交权将被 leaseController 拒绝,fail-stop)`, { stuck });
      return { drained: false, stuck };
    }
    state = "idle";
    log.info(`[leaderBundle] stopAndDrain done`);
    return { drained: true, stuck: [] };
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
