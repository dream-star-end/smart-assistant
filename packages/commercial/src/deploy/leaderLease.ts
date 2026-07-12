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

export interface LeaseCallbacks {
  /** 竞得并安装 lease 后调用:start LeaderBundle(幂等)。 */
  onAcquire: () => Promise<void> | void;
  /** lease loss / graceful 让位:stopAndDrain LeaderBundle(有界)。reason 供诊断。 */
  onFence: (reason: string) => Promise<void> | void;
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

  let state: LeadershipState = opts.eligibleEnv ? "standby" : "ineligible";
  let stopped = false;
  let leaseClient: PoolClient | null = null;
  let heldEpoch: number | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let recompeteTimer: ReturnType<typeof setTimeout> | null = null;
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
        leaseClient = client;
        setState("leader");
        startHeartbeat();
        subscribeDesired();
        await Promise.resolve(opts.callbacks.onAcquire()).catch((err) =>
          log.error("[leaderLease] onAcquire 抛错", err),
        );
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
      await Promise.resolve(opts.callbacks.onFence(reason)).catch((err) =>
        log.error("[leaderLease] onFence 抛错", err),
      );
      if (client) {
        if (o.writeAck && epoch !== null) {
          // 写本 epoch ACK(epoch/instance 条件:迟到不污染新代)。best-effort。
          try {
            await client.query(
              `UPDATE leader_lease SET fenced_ack_epoch = $1, updated_at = now()
                 WHERE singleton = true AND holder_instance_id = $2 AND lease_epoch = $3`,
              [epoch, selfInstance, epoch],
            );
          } catch (err) {
            log.warn("[leaderLease] 写 ACK 失败(后继将回退 liveness 判定)", err);
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
    leaseClient = null;
    heldEpoch = null;
    try {
      await Promise.resolve(opts.callbacks.onFence("connection-lost")).catch((e) =>
        log.error("[leaderLease] onFence 抛错", e),
      );
      // 连接已坏,直接销毁(不还池):advisory 随连接死已释放。
      try {
        client.release(err instanceof Error ? err : new Error(String(err)));
      } catch {
        /* 已断 */
      }
    } finally {
      transitioning = false;
    }
    if (!stopped) {
      setState(opts.eligibleEnv ? (desiredIsSelf() ? "acquiring" : "standby") : "ineligible");
      scheduleRecompete();
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
      if (state === "leader" && leaseClient) {
        // graceful:drain + 写本 epoch ACK + unlock(新 holder 零等待接管)。
        await stepDown("shutdown", { writeAck: true });
      } else if (leaseClient) {
        const c = leaseClient;
        leaseClient = null;
        clearHeartbeat();
        await unlockAndRelease(c);
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
