// leaderLease.ts — 双 master 单 leader 租约(RFC-v5-dual-master-cohort D4 R4 定稿协议)。
//
// 铁律:同一时刻全网只能有一个实例跑 LeaderBundle(shared 全表 mutator + 4 个需交接调度器)。
// 旧模型用 OC_CONTROL_PLANE_LEADER 静态门,无法表达双 master 场景"此刻谁是 leader",且 kill -9
// 重启的旧 slot 会抢回。P3 用 PG 上的 leader_lease 单行 + advisory lock + **epoch 化交接协议**
// 消 ABA / 陈旧 ACK / 重叠启动。
//
// 资格 = OC_CONTROL_PLANE_LEADER 严格 '1'(kill-switch 兼容;unset/非法 = fail-closed 拒起)
//        ∧ deploy_state.desired_leader_slot == 本 slot(OC_SLOT)。资格不满足**不竞锁**——
//        systemd Restart 拉起的旧 slot 因 desired 不匹配无资格,不会抢回(kill -9 场景)。
//
// 安装七步(R4:fence-request 先行,ACK 之后才安装新 holder;否则覆盖行会让旧 holder 的带
// epoch 条件 ACK 永远落空):
//   ①竞得 advisory lock(专用连接独占)
//   ②读并冻结 predecessor {epoch, instance_id, pid, start_ticks}
//   ③保留旧 holder 字段,仅 CAS 写 fence_requested_epoch=predecessor_epoch
//   ④等 fenced_ack_epoch==predecessor_epoch 或 predecessor 进程身份({pid,start_ticks})确认死
//     (45s>drain 30s;超时=fail-stop 告警,绝不带重叠启动)
//   ⑤再次确认 desired 仍=自己(等待期间 desired 变更→立即放弃并释放 advisory,不得安装)
//   ⑥CAS 安装:WHERE lease_epoch=pred AND holder_instance_id 与 pred 一致(IS NOT DISTINCT FROM
//     处理 seed NULL),写 epoch+1 + 新身份 + 清空 request/ack
//   ⑦才回调 onAcquire(start LeaderBundle)
//
// 旧 holder ACK = SET fenced_ack_epoch=$heldEpoch WHERE holder_instance_id=self AND
// lease_epoch=$heldEpoch —— 迟到的上代 ACK 因 epoch/instance 已变,匹配空行,不污染新代。
// graceful = drain(onFence)→写本 epoch ACK→unlock,新 holder 拿锁即见 ACK,零等待零重叠。

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import type { DesiredWatch, Slot } from "./deployState.js";
import { LeaderBundleRollbackIncompleteError } from "./leaderBundle.js";

const LEASE_ADVISORY_KEY = "oc_leader_lease_v5";

export type LeadershipState = "ineligible" | "standby" | "acquiring" | "leader" | "fenced";

export interface LeadershipStatus {
  state: LeadershipState;
  slot: Slot;
  /** deploy_state 代次(rollout generation);未读到时 null。 */
  generation: number | null;
  /** 本实例作为 leader 时的 pid;非 leader 为 null。 */
  leasePid: number | null;
}

/** onFence 返回:drained=true 表示 bundle 已干净停(可安全交权);false 时 stuck 列未停成员。 */
export interface FenceDrainOutcome {
  drained: boolean;
  stuck: string[];
}

export interface LeaseCallbacks {
  /**
   * 竞得并安装 lease 后调用:start LeaderBundle(幂等)。
   * **抛错 = start-all-or-fail 回滚(BLOCKER 1)** → controller step-down + fail-stop(绝不带半启动 leader 运行)。
   */
  onAcquire: () => Promise<void> | void;
  /**
   * lease loss / graceful 让位:stopAndDrain LeaderBundle(有界)。reason 供诊断。
   * 返回 {drained, stuck}:drained=false(超时仍有 mutator 在跑)→ controller 拒绝交权、fail-stop
   * (后继经 PID liveness 确认死亡才接管),绝不带 stuck 成员写共享状态时把权交出去(BLOCKER 1)。
   */
  onFence: (reason: string) => Promise<FenceDrainOutcome> | FenceDrainOutcome;
}

export interface LeaderLeaseOptions {
  pool: Pool;
  slot: Slot;
  desiredWatch: DesiredWatch;
  callbacks: LeaseCallbacks;
  /** env 资格(index.ts 用 resolveLeaderEnvEligibility 解析后传入;false=ineligible 恒不竞锁)。 */
  eligibleEnv: boolean;
  /** 进程启动随机 UUID(默认 randomUUID;测试注入)。 */
  instanceId?: string;
  now?: () => number;
  logger?: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
  /** fence 等待超时(45s>drain 30s)后 fail-stop 告警回调(人工裁决)。 */
  onFenceTimeoutAlert?: (info: { predecessorEpoch: number; predecessorPid: number | null }) => void;
  /**
   * fail-stop:进程无法安全继续持有/交出 leadership 时调用(默认 process.exit(1),systemd 拉起后以
   * standby 重来)。触发场景:①onAcquire(bundle start-all-or-fail)抛错 ②graceful/被动 fence 的 drain
   * 返回 drained:false(有 stuck mutator,交权 = 双跑)③连接掉线 fence 后短连接 ACK 也失败(无法交出 ACK)。
   * 测试注入 spy 观测,不真的退进程。
   */
  onFatal?: (reason: string, detail?: unknown) => void;
  heartbeatMs?: number;
  recompeteMs?: number;
  fenceWaitMs?: number;
  fenceWaitPollMs?: number;
  /** 自身进程 pid(测试注入);默认 process.pid。 */
  selfPid?: number;
  /** 自身 /proc/self/stat 第 22 字段 starttime(测试注入);默认读 /proc。 */
  selfStartTicks?: number;
  /** predecessor 存活判定(测试注入);默认读 /proc/<pid>/stat 校验 start_ticks。 */
  isProcessAlive?: (pid: number, startTicks: number) => boolean;
}

export interface LeaderLeaseController {
  /** 启动竞争循环(异步,不阻塞 registerCommercial)。 */
  start(): void;
  /** graceful:标记退出→(若 leader)drain+写 ACK+unlock→销毁连接。 */
  shutdown(): Promise<void>;
  status(): LeadershipStatus;
}

interface LeaseRow {
  lease_epoch: string;
  holder_slot: Slot | null;
  holder_instance_id: string | null;
  holder_pid: number | null;
  holder_pid_start_ticks: string | null;
  fence_requested_epoch: string | null;
  fenced_ack_epoch: string | null;
}

interface FrozenPredecessor {
  epoch: number;
  instanceId: string | null;
  pid: number | null;
  startTicks: number | null;
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * OC_CONTROL_PLANE_LEADER 严格真值表:'1'→true / '0'→false / 其它(unset/非法)→throw。
 * v5 生产 fail-closed 拒起(与 P2 开关纪律一致:资格类 env 不允许"以为关了其实没关")。
 */
export function resolveLeaderEnvEligibility(env: Record<string, string | undefined>): boolean {
  // trim 容忍 env 文件尾随空白/换行(非 misconfig);trim 后严格 '0'|'1',其余(unset/'true'/''/'2')拒起。
  const raw = env.OC_CONTROL_PLANE_LEADER?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(
    `[leaderLease] OC_CONTROL_PLANE_LEADER 必须显式 '0'|'1'(当前=${JSON.stringify(env.OC_CONTROL_PLANE_LEADER)});` +
      `v5 双 master 下资格判定 fail-closed,拒起。`,
  );
}

/** 读 /proc/<pid>/stat 第 22 字段 starttime(comm 含空格/括号,取最后一个 ')' 之后再分词)。 */
export function readProcStartTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) throw new Error(`/proc/${pid}/stat 格式异常`);
  const rest = stat.slice(rparen + 2); // 跳过 ") "
  const fields = rest.split(" ");
  // fields[0]=field3(state);starttime=field22 → fields[19]。
  const v = Number(fields[19]);
  if (!Number.isFinite(v)) throw new Error(`/proc/${pid}/stat starttime 解析失败`);
  return v;
}

function defaultIsProcessAlive(pid: number, startTicks: number): boolean {
  try {
    const cur = readProcStartTicks(pid);
    // start_ticks 不一致 = PID 已被复用(原进程死),视为死。
    return cur === startTicks;
  } catch {
    // /proc/<pid> 不存在 = 进程已死。
    return false;
  }
}

export function createLeaderLeaseController(opts: LeaderLeaseOptions): LeaderLeaseController {
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger ?? noopLogger;
  const selfInstance = opts.instanceId ?? randomUUID();
  const selfPid = opts.selfPid ?? process.pid;
  const selfStartTicks =
    opts.selfStartTicks ?? (() => {
      try {
        return readProcStartTicks(process.pid);
      } catch {
        return 0; // 非 Linux/测试环境:退化为 0(存活判定由注入覆盖)。
      }
    })();
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const recompeteMs = opts.recompeteMs ?? 3_000;
  const fenceWaitMs = opts.fenceWaitMs ?? 45_000;
  const fenceWaitPollMs = opts.fenceWaitPollMs ?? 500;
  // fail-stop:默认 process.exit(1)(systemd Restart=on-failure 拉起后因 desired 判定以 standby 起)。
  const failStop =
    opts.onFatal ??
    ((reason: string, detail?: unknown) => {
      log.error(`[leaderLease] FAIL-STOP: ${reason}`, detail);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });

  let state: LeadershipState = opts.eligibleEnv ? "standby" : "ineligible";
  let stopped = false;
  let leaseClient: PoolClient | null = null;
  let heldEpoch: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let recompeteTimer: ReturnType<typeof setTimeout> | null = null;
  // shutdown 必须等待“已安装 lease、onAcquire 仍在启动 bundle”的窗口收敛，再 drain 后交权。
  // 仅看 state=leader 会在 acquiring 窗口直接 unlock，造成后继与旧 bundle 双跑。
  let acquisitionInFlight: Promise<void> | null = null;
  // 串行化 compete/stepDown,避免 heartbeat 与 desired-change 并发触发两条让位路径。
  let transitioning = false;
  let unsubDesired: (() => void) | null = null;

  function setState(s: LeadershipState): void {
    if (state !== s) {
      state = s;
      log.info(`[leaderLease] state=${s}`, { slot: opts.slot, epoch: heldEpoch });
    }
  }

  function desiredIsSelf(): boolean {
    const snap = opts.desiredWatch.current();
    return snap?.desiredLeaderSlot === opts.slot;
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleRecompete(): void {
    if (stopped || recompeteTimer) return;
    recompeteTimer = setTimeout(() => {
      recompeteTimer = null;
      void compete();
    }, recompeteMs);
    if (recompeteTimer && typeof recompeteTimer === "object" && "unref" in recompeteTimer) {
      (recompeteTimer as { unref: () => void }).unref();
    }
  }

  // ── 竞争 + 安装 ────────────────────────────────────────────────────────────
  async function compete(): Promise<void> {
    if (acquisitionInFlight) return acquisitionInFlight;
    let finish!: () => void;
    const marker = new Promise<void>((resolve) => {
      finish = resolve;
    });
    acquisitionInFlight = marker;
    try {
      await competeOnce();
    } finally {
      if (acquisitionInFlight === marker) acquisitionInFlight = null;
      finish();
    }
  }

  async function competeOnce(): Promise<void> {
    if (stopped || leaseClient || transitioning) return;
    if (!opts.eligibleEnv) {
      setState("ineligible");
      return;
    }
    // desired 必须先就绪(启动瞬间 watch 可能还没首读)。
    if (opts.desiredWatch.current() === null) {
      try {
        await opts.desiredWatch.refreshNow();
      } catch {
        scheduleRecompete();
        return;
      }
    }
    if (!desiredIsSelf()) {
      setState("standby");
      return; // 由 desired onChange 唤醒重竞。
    }

    setState("acquiring");
    let client: PoolClient;
    try {
      client = await opts.pool.connect();
    } catch (err) {
      log.warn("[leaderLease] pool.connect 失败", err);
      scheduleRecompete();
      return;
    }
    // 掉线监听贯穿整个 lease 生命周期。
    client.on("error", (err) => void onLeaseClientError(client, err));

    try {
      const got = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
        [LEASE_ADVISORY_KEY],
      );
      if (got.rows[0]?.ok !== true) {
        // 已有持有者(另一 slot 是当前 leader)→ 探测连接还池,稍后重竞。
        client.release();
        setState(desiredIsSelf() ? "acquiring" : "standby");
        scheduleRecompete();
        return;
      }
      // 拿到 advisory:执行安装协议。
      const outcome = await installOnClient(client);
      if (outcome === "installed") {
        // 安装成功:installOnClient 已把 heldEpoch 置为 pred.epoch+1。捕获它 + client 作为
        // onAcquire 等待期的二次确认 token(BLOCKER 1 等待期竞态)。
        const installedEpoch = heldEpoch;
        leaseClient = client;
        // 掉线监听在 leader 期贯穿(compete 早期已 attach,此处不重复)。
        // BLOCKER 1:onAcquire = bundle start-all-or-fail。抛错 → 释放 lease + fail-stop,
        // 绝不置为 leader 态(半启动的 leader = shared 职责静默真空)。
        try {
          await Promise.resolve(opts.callbacks.onAcquire());
        } catch (err) {
          // required start 失败后的 bundle 回滚若仍有 stuck mutator，绝不能先 unlock；保持
          // advisory 到 fail-stop 退进程，由后继凭 PID liveness 接管，避免双跑。
          if (err instanceof LeaderBundleRollbackIncompleteError) {
            log.error("[leaderLease] onAcquire 回滚未停净 → 保持 lease + fail-stop", {
              failedMember: err.failedMember,
              stuck: err.stuck,
            });
            clearHeartbeat();
            setState("fenced");
            failStop(`onAcquire rollback incomplete: stuck=[${err.stuck.join(",")}]`, err);
            return;
          }
          log.error("[leaderLease] onAcquire(bundle start)失败 → 释放 lease + fail-stop", err);
          leaseClient = null;
          heldEpoch = null;
          clearHeartbeat();
          setState("fenced");
          // 回滚已完成(bundle 无成员在跑),可安全解锁 advisory 让后继竞得;随后 fail-stop。
          await unlockAndRelease(client).catch(() => {});
          failStop(`onAcquire(bundle start) failed: ${(err as Error)?.message ?? String(err)}`, err);
          return;
        }
        // BLOCKER 1(onAcquire 等待期竞态):await onAcquire(bundle.start)期间可能 ①lease 断连
        // (onLeaseClientError 已把 leaseClient 置空并接管 drain/ACK/fail-stop)②被 usurp(heldEpoch 变)
        // ③desired 翻走(finalize 交接把 desired 指向对方 slot)。旧实现无条件 setState("leader"),会让
        // "连接已死 / desired 已翻"的实例仍以 leader 自居(heartbeat 空转 = shared 职责静默真空)。
        // 修:以捕获 token 二次确认后才进 leader;任一不满足 → 让路 / 安全 step-down(回滚已启动 bundle+释放),绝不进 leader。
        if (stopped || leaseClient !== client || heldEpoch !== installedEpoch) {
          // 断连 / 被接管 / 停机:那条路径(onLeaseClientError / shutdown)已负责 drain/ACK/收尾,本函数让路,不进 leader。
          log.warn("[leaderLease] onAcquire 返回时 lease 已断连/被接管/停机 → 让路,不进 leader", {
            hasClient: leaseClient === client,
            epochStable: heldEpoch === installedEpoch,
            stopped,
          });
          return;
        }
        // 连接与 epoch 仍在 → 再确认 desired 仍=自己(等待期 finalize 翻走则安全让位,drain 已启动 bundle)。
        let desiredStillSelf = true;
        try {
          desiredStillSelf = (await opts.desiredWatch.refreshNow()).desiredLeaderSlot === opts.slot;
        } catch {
          desiredStillSelf = desiredIsSelf();
        }
        // refreshNow 可能耗时,其间又可能断连/被接管 —— 再核一次 token。
        if (stopped || leaseClient !== client || heldEpoch !== installedEpoch) {
          log.warn("[leaderLease] onAcquire 后确认 desired 期间 lease 已断连/被接管 → 让路,不进 leader");
          return;
        }
        if (!desiredStillSelf) {
          log.warn("[leaderLease] onAcquire 期间 desired 翻走 → 安全 step-down(drain 已启动 bundle+写 ACK+释放),不进 leader");
          await stepDown("desired-flip-during-acquire", { writeAck: true });
          return;
        }
        setState("leader");
        startHeartbeat();
        subscribeDesired();
        return;
      }
      // abandoned / timeout:释放 advisory + 连接,不安装(绝不重叠)。
      await unlockAndRelease(client);
      if (outcome === "timeout") {
        // fail-stop:不再快速重试(避免风暴),但仍安排一次远期重竞 + 告警人工裁决。
        scheduleRecompete();
      } else {
        // desired 反转 / ABA:回落 standby 或重竞。
        setState(desiredIsSelf() ? "acquiring" : "standby");
        scheduleRecompete();
      }
    } catch (err) {
      log.warn("[leaderLease] compete 异常", err);
      await unlockAndRelease(client).catch(() => {});
      scheduleRecompete();
    }
  }

  /** 安装协议 ②-⑥。返回 installed / abandoned(desired 反转或 ABA)/ timeout(fence 超时)。 */
  async function installOnClient(client: PoolClient): Promise<"installed" | "abandoned" | "timeout"> {
    // ② 读并冻结 predecessor。
    const pred = await readPredecessor(client);

    // predecessor 是自己(连接掉线后同进程重竞:instance_id 稳定不变)→ 直接安装(re-acquire own lease)。
    const predIsSelf = pred.instanceId !== null && pred.instanceId === selfInstance;
    // predecessor 无 holder(seed / 已优雅让位清场)→ 视作已死,直接安装。
    const predHasHolder = pred.instanceId !== null && pred.pid !== null;

    if (!predIsSelf && predHasHolder) {
      // ③ 仅 CAS 写 fence_requested_epoch=pred.epoch(保留旧 holder 字段)。epoch 变了=有人抢先,放弃。
      const reqOk = await requestFence(client, pred.epoch);
      if (!reqOk) return "abandoned";

      // ④ 等 ACK 或 predecessor 死;⑤ 等待期间 desired 反转立即放弃。
      const deadline = now() + fenceWaitMs;
      for (;;) {
        if (stopped) return "abandoned";
        // ⑤ desired 反转 → 立即放弃(Codex 点名竞态)。
        let desiredNow: Slot | null = null;
        try {
          desiredNow = (await opts.desiredWatch.refreshNow()).desiredLeaderSlot;
        } catch {
          desiredNow = opts.desiredWatch.current()?.desiredLeaderSlot ?? null;
        }
        if (desiredNow !== opts.slot) return "abandoned";

        const row = await readPredecessor(client);
        // 若 epoch 已推进(别人安装了新代)→ ABA,放弃。
        if (row.epoch !== pred.epoch) return "abandoned";
        // ACK 到位(旧 holder 优雅让位或响应 fence)。
        if (row.ackEpoch !== null && row.ackEpoch === pred.epoch) break;
        // predecessor 进程确认死。
        if (pred.pid !== null && pred.startTicks !== null && !isProcessAlive(pred.pid, pred.startTicks)) {
          break;
        }
        if (now() >= deadline) {
          log.error("[leaderLease] fence 等待超时 fail-stop:绝不带重叠启动,告警人工裁决", {
            predecessorEpoch: pred.epoch,
            predecessorPid: pred.pid,
          });
          opts.onFenceTimeoutAlert?.({ predecessorEpoch: pred.epoch, predecessorPid: pred.pid });
          return "timeout";
        }
        await sleep(fenceWaitPollMs);
      }
    }

    // ⑤(再次)安装前确认 desired 仍=自己。
    try {
      if ((await opts.desiredWatch.refreshNow()).desiredLeaderSlot !== opts.slot) return "abandoned";
    } catch {
      if (!desiredIsSelf()) return "abandoned";
    }

    // ⑥ CAS 安装新 holder:epoch+1 + 新身份 + 清 request/ack。ABA 由 instance_id 条件挡。
    const installed = await installHolder(client, pred);
    if (!installed) return "abandoned";
    heldEpoch = pred.epoch + 1;
    return "installed";
  }

  async function readPredecessor(
    client: PoolClient,
  ): Promise<FrozenPredecessor & { ackEpoch: number | null; reqEpoch: number | null }> {
    const r = await client.query<LeaseRow>(
      `SELECT lease_epoch, holder_slot, holder_instance_id, holder_pid, holder_pid_start_ticks,
              fence_requested_epoch, fenced_ack_epoch
         FROM leader_lease WHERE singleton = true`,
    );
    const row = r.rows[0];
    if (!row) throw new Error("[leaderLease] leader_lease 单行缺失(0135 seed 未 apply?)");
    return {
      epoch: Number(row.lease_epoch),
      instanceId: row.holder_instance_id,
      pid: row.holder_pid,
      startTicks: row.holder_pid_start_ticks === null ? null : Number(row.holder_pid_start_ticks),
      ackEpoch: row.fenced_ack_epoch === null ? null : Number(row.fenced_ack_epoch),
      reqEpoch: row.fence_requested_epoch === null ? null : Number(row.fence_requested_epoch),
    };
  }

  async function requestFence(client: PoolClient, predEpoch: number): Promise<boolean> {
    // 仅写 fence_requested_epoch,保留 holder 字段;epoch 已变=有人抢先,放弃。
    const r = await client.query(
      `UPDATE leader_lease SET fence_requested_epoch = $1, updated_at = now()
         WHERE singleton = true AND lease_epoch = $2`,
      [predEpoch, predEpoch],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async function installHolder(client: PoolClient, pred: FrozenPredecessor): Promise<boolean> {
    // WHERE 用 IS NOT DISTINCT FROM 处理 seed(instance_id NULL)与同进程重竞(instance=self)。
    const r = await client.query(
      `UPDATE leader_lease
          SET lease_epoch = $1,
              holder_slot = $2,
              holder_instance_id = $3,
              holder_pid = $4,
              holder_pid_start_ticks = $5,
              fence_requested_epoch = NULL,
              fenced_ack_epoch = NULL,
              updated_at = now()
        WHERE singleton = true
          AND lease_epoch = $6
          AND holder_instance_id IS NOT DISTINCT FROM $7`,
      [pred.epoch + 1, opts.slot, selfInstance, selfPid, selfStartTicks, pred.epoch, pred.instanceId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ── leader 期:heartbeat + desired 监听 ────────────────────────────────────
  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => void heartbeatTick(), heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  }

  async function heartbeatTick(): Promise<void> {
    if (stopped || state !== "leader" || !leaseClient || heldEpoch === null || transitioning) return;
    try {
      const r = await leaseClient.query<{ fence_requested_epoch: string | null }>(
        `UPDATE leader_lease SET updated_at = now()
           WHERE singleton = true AND lease_epoch = $1 AND holder_instance_id = $2
         RETURNING fence_requested_epoch`,
        [heldEpoch, selfInstance],
      );
      if ((r.rowCount ?? 0) === 0) {
        // 已被别人安装新代(不该发生:我们持 advisory)→ 自我 fence 兜底。
        log.warn("[leaderLease] heartbeat 发现 lease 已被接管,自我 fence");
        await stepDown("usurped", { writeAck: false });
        return;
      }
      const req = r.rows[0]?.fence_requested_epoch;
      if (req !== null && req !== undefined && Number(req) === heldEpoch) {
        // 有后继请求让位 → 优雅交接(drain + ACK + unlock)。
        await stepDown("fence-requested", { writeAck: true });
      }
    } catch (err) {
      // 连接层错误由 client.on('error') 处理;此处 query 级错误记录即可。
      log.warn("[leaderLease] heartbeat query 失败", err);
    }
  }

  function subscribeDesired(): void {
    unsubDesired?.();
    unsubDesired = opts.desiredWatch.onChange((snap) => {
      if (state === "leader" && snap.desiredLeaderSlot !== opts.slot) {
        // desired 反转(finalize 交接)→ 优雅让位。
        void stepDown("desired-flip", { writeAck: true });
      }
    });
  }

  // ── 让位(graceful/被动)──────────────────────────────────────────────────
  async function stepDown(reason: string, o: { writeAck: boolean }): Promise<void> {
    if (transitioning) return;
    transitioning = true;
    setState("fenced");
    clearHeartbeat();
    unsubDesired?.();
    unsubDesired = null;
    const epoch = heldEpoch;
    const client = leaseClient;
    leaseClient = null;
    heldEpoch = null;
    try {
      // 先 drain bundle(停止一切 mutator),再写 ACK / unlock —— 顺序:必须先停跑再交权。
      const outcome = await drainBundle(reason);
      // BLOCKER 1:drain 未干净(有 stuck mutator 仍在跑)→ 绝不交权。不写 ACK、不 unlock
      //(留 advisory 到进程死;后继经 PID liveness 确认死亡才接管),fail-stop。
      if (!outcome.drained) {
        log.error("[leaderLease] fence drain 未完成,拒绝交权 → fail-stop", { reason, stuck: outcome.stuck });
        // 不 unlock:进程退出时 PG 自动释放 advisory;successor 走 liveness(此进程已死)接管。
        transitioning = false;
        failStop(`fence drain incomplete: stuck=[${outcome.stuck.join(",")}]`, { reason });
        return;
      }
      if (client) {
        if (o.writeAck && epoch !== null) {
          // graceful ACK:先在 lease 连接上写本 epoch ACK(epoch/instance 条件:迟到不污染新代)。
          let acked = false;
          try {
            await client.query(
              `UPDATE leader_lease SET fenced_ack_epoch = $1, updated_at = now()
                 WHERE singleton = true AND holder_instance_id = $2 AND lease_epoch = $3`,
              [epoch, selfInstance, epoch],
            );
            acked = true; // rowCount=0(已被安装新代)也算完成:交接已成,ACK 无意义
          } catch (err) {
            log.warn("[leaderLease] graceful ACK 在 lease 连接上失败(drain 期连接断连?)→ 回退独立短连接", err);
          }
          // BLOCKER 2:stepDown 先清 leaseClient,drain 期断连被 onLeaseClientError 忽略(client!==leaseClient);
          // 若此处 ACK 又吞在坏连接上只 warn,旧进程活着且无 ACK → 后继等 45s liveness 才 fail-stop = 卡死。
          // 修:lease 连接 ACK 失败 → 回退独立短连接写 ACK;短连接也失败 → fail-stop(进程退出供 PID 死亡确认接管)。
          if (!acked) {
            const shortAcked = await writeAckShortConn(epoch);
            if (!shortAcked) {
              log.error(
                "[leaderLease] graceful ACK 主/短连接均失败 → fail-stop(进程退出,后继经 PID 死亡确认接管;绝不留活进程不 ACK 卡后继 45s)",
                { reason, epoch },
              );
              // lease 连接已坏:销毁(不还池);advisory 随进程退出由 PG 释放,后继走 liveness 接管。
              try {
                client.release(new Error("graceful ACK failed on lease conn"));
              } catch {
                /* 连接已断 */
              }
              transitioning = false;
              failStop(`graceful ACK failed on both lease conn and short conn (reason=${reason}, epoch=${epoch})`);
              return;
            }
            log.warn("[leaderLease] graceful ACK 已回退独立短连接成功(lease 连接在 drain 期已坏)");
          }
        }
        await unlockAndRelease(client);
      }
    } finally {
      transitioning = false;
    }
    // 让位后:desired 仍=自己(如 fence-requested 但 desired 未变的异常)→ 重竞;否则 standby 等唤醒。
    if (!stopped) {
      setState(opts.eligibleEnv ? (desiredIsSelf() ? "acquiring" : "standby") : "ineligible");
      scheduleRecompete();
    }
  }

  // 连接掉线(pg_terminate_backend / 网络 / PG 重启):advisory 被 PG 自动释放 → 立即 fence。
  // BLOCKER 2:掉线时**保留 heldEpoch**;drain 成功后用独立短连接写本 epoch ACK(WHERE holder=self
  // AND lease_epoch=self),让新 holder 拿锁即见 ACK 秒级接管(不必等 45s liveness)。短连接也失败
  //           → 无法交出 ACK,进程退出供后继确认死亡(45s liveness 兜底)。drain 未完成 → 同样 fail-stop。
  async function onLeaseClientError(client: PoolClient, err: unknown): Promise<void> {
    if (client !== leaseClient) {
      // 非当前 lease 连接(compete 中途的探测连接)——交由各自路径处理。
      return;
    }
    log.warn("[leaderLease] lease 连接掉线,立即 fence 并重建重竞", err);
    if (transitioning) return;
    transitioning = true;
    setState("fenced");
    clearHeartbeat();
    unsubDesired?.();
    unsubDesired = null;
    const epoch = heldEpoch; // 保留:短连接 ACK 要用
    leaseClient = null;
    heldEpoch = null;
    try {
      const outcome = await drainBundle("connection-lost");
      // 连接已坏,直接销毁(不还池):advisory 随连接死已释放。
      try {
        client.release(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* 已断 */
      }
      if (!outcome.drained) {
        log.error("[leaderLease] 掉线 fence drain 未完成 → fail-stop(后继经 liveness 接管)", { stuck: outcome.stuck });
        transitioning = false;
        failStop(`connection-lost fence drain incomplete: stuck=[${outcome.stuck.join(",")}]`);
        return;
      }
      // drain 成功 → 独立短连接写 ACK(新 holder 秒级接管)。
      if (epoch !== null) {
        const acked = await writeAckShortConn(epoch);
        if (!acked) {
          log.error("[leaderLease] 掉线后短连接 ACK 失败 → fail-stop(无法交出 ACK,后继走 liveness)", { epoch });
          transitioning = false;
          failStop(`connection-lost ACK short-conn failed (epoch=${epoch})`);
          return;
        }
      }
    } finally {
      transitioning = false;
    }
    if (!stopped) {
      setState(opts.eligibleEnv ? (desiredIsSelf() ? "acquiring" : "standby") : "ineligible");
      scheduleRecompete();
    }
  }

  /** onFence 归一:结构化 {drained,stuck};void→drained(兼容非 v5 回调);抛错→drained:false(保守 fail-stop)。 */
  async function drainBundle(reason: string): Promise<FenceDrainOutcome> {
    try {
      const r = await Promise.resolve(opts.callbacks.onFence(reason));
      if (r && typeof r === "object" && typeof (r as FenceDrainOutcome).drained === "boolean") {
        return { drained: (r as FenceDrainOutcome).drained, stuck: (r as FenceDrainOutcome).stuck ?? [] };
      }
      return { drained: true, stuck: [] };
    } catch (e) {
      log.error("[leaderLease] onFence 抛错(视为 drain 未完成 → fail-stop)", e);
      return { drained: false, stuck: ["<onFence-threw>"] };
    }
  }

  /**
   * 独立短连接写本 epoch ACK(掉线 fence 专用)。rowCount=0(新 holder 已安装/epoch 已变)也算成功
   * (交接已完成,ACK 无意义);仅真实 DB 错误返回 false → 调用方 fail-stop。
   */
  async function writeAckShortConn(epoch: number): Promise<boolean> {
    let c: PoolClient | null = null;
    try {
      c = await opts.pool.connect();
      await c.query(
        `UPDATE leader_lease SET fenced_ack_epoch = $1, updated_at = now()
           WHERE singleton = true AND holder_instance_id = $2 AND lease_epoch = $3`,
        [epoch, selfInstance, epoch],
      );
      return true;
    } catch (e) {
      log.warn("[leaderLease] 短连接写 ACK 失败", e);
      return false;
    } finally {
      if (c) {
        try {
          c.release();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function unlockAndRelease(client: PoolClient): Promise<void> {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LEASE_ADVISORY_KEY]);
      client.release();
    } catch (err) {
      // unlock 失败 → 销毁连接(不还池),防未释放的 session lock 卡后续竞锁。
      try {
        client.release(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* ignore */
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      if (t && typeof t === "object" && "unref" in t) (t as { unref: () => void }).unref();
    });
  }

  return {
    start() {
      if (stopped) return;
      // 资格满足时 desired 变更也应唤醒竞争(从 standby → acquiring)。
      if (opts.eligibleEnv) {
        opts.desiredWatch.onChange((snap) => {
          if (!stopped && !leaseClient && !transitioning && snap.desiredLeaderSlot === opts.slot) {
            void compete();
          }
        });
      }
      void compete();
    },
    async shutdown() {
      stopped = true;
      if (recompeteTimer) {
        clearTimeout(recompeteTimer);
        recompeteTimer = null;
      }
      // 如果 lease 已安装而 onAcquire 仍在跑，先等它落定。competeOnce 看到 stopped 后不会
      // 进入 leader；随后本路径统一 drain + ACK + unlock，绝不从 acquiring 直接放锁。
      const acquiring = acquisitionInFlight;
      if (acquiring) await acquiring;
      if (leaseClient) {
        // graceful:无论当前 state 是 leader 还是刚结束 acquiring，都先 drain，再 ACK/unlock。
        await stepDown("shutdown", { writeAck: true });
      } else {
        clearHeartbeat();
      }
    },
    status: () => ({
      state,
      slot: opts.slot,
      generation: opts.desiredWatch.current()?.generation ?? null,
      leasePid: state === "leader" ? selfPid : null,
    }),
  };
}
