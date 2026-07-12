// deployState.ts — 部署状态机(deploy_state)读取 + CAS 转移 + desired watch。
//
// RFC-v5-dual-master-cohort §3:流量角色 / 18894 所有者 / leader 所有者 / systemd slot 四个
// 角色面全部由 deploy_state 单行派生,禁止三个独立竞态"通常一致"。本模块是该单行的读写权威:
//   · readDeployState        单行 SELECT(供脚本/恢复矩阵/展示)
//   · casDeployState         乐观并发转移(WHERE lock_version=$n),附 journal 同事务
//   · startDesiredWatch      5s 轮询缓存 desired_*,供 leaderLease / controlListener 消费
//
// 为什么 CAS 用 lock_version 而非 updated_at:并发权威必须是严格单调计数(R2 MINOR),
// 挂钟会被 NTP 回拨/同毫秒并发骗过。为什么 journal 必须与 UPDATE 同事务:崩溃诊断要求
// "状态推进"与"审计记录"原子——半条 journal 比没有 journal 更误导。

import type { Pool, PoolClient } from "pg";

export type Slot = "A" | "B";
export type DeployPhase = "stable" | "canary" | "finalizing" | "aborting";

/** deploy_state 单行(camelCase 映射;BIGINT→number,allowlist→string[] 保精度)。 */
export interface DeployStateRow {
  generation: number;
  phase: DeployPhase;
  activeSlot: Slot;
  candidateSlot: Slot | null;
  activeRelease: string | null;
  candidateRelease: string | null;
  desiredLeaderSlot: Slot;
  desiredControlSlot: Slot;
  cohortPercent: number;
  cohortSalt: string;
  /** BIGINT[] → uid 字符串数组(uid 是 bigint,不转 number 以免丢精度)。 */
  cohortAllowlist: string[];
  lockVersion: number;
  transitionStep: number;
  operationId: string | null;
  updatedAt: string;
}

/** desired watch 对外快照:leaderLease 读 desiredLeaderSlot,controlListener 读 desiredControlSlot。 */
export interface DesiredSnapshot {
  desiredLeaderSlot: Slot;
  desiredControlSlot: Slot;
  activeSlot: Slot;
  phase: DeployPhase;
  generation: number;
}

// ── 行映射 ──────────────────────────────────────────────────────────────────
interface RawDeployRow {
  generation: string;
  phase: DeployPhase;
  active_slot: Slot;
  candidate_slot: Slot | null;
  active_release: string | null;
  candidate_release: string | null;
  desired_leader_slot: Slot;
  desired_control_slot: Slot;
  cohort_percent: number;
  cohort_salt: string;
  cohort_allowlist: string[] | null;
  lock_version: string;
  transition_step: number;
  operation_id: string | null;
  updated_at: Date | string;
}

/** BIGINT(node-postgres 返回 string)→ number,并断言未溢出 safe int(与 P2 行 mapper 同纪律)。 */
function bigintToSafeNumber(v: string, field: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`[deployState] ${field}=${v} 超出 safe integer,拒绝静默丢精度`);
  }
  return n;
}

function mapRow(r: RawDeployRow): DeployStateRow {
  return {
    generation: bigintToSafeNumber(r.generation, "generation"),
    phase: r.phase,
    activeSlot: r.active_slot,
    candidateSlot: r.candidate_slot,
    activeRelease: r.active_release,
    candidateRelease: r.candidate_release,
    desiredLeaderSlot: r.desired_leader_slot,
    desiredControlSlot: r.desired_control_slot,
    cohortPercent: r.cohort_percent,
    cohortSalt: r.cohort_salt,
    cohortAllowlist: r.cohort_allowlist ?? [],
    lockVersion: bigintToSafeNumber(r.lock_version, "lock_version"),
    transitionStep: r.transition_step,
    operationId: r.operation_id,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

const SELECT_COLS = `generation, phase, active_slot, candidate_slot, active_release, candidate_release,
  desired_leader_slot, desired_control_slot, cohort_percent, cohort_salt, cohort_allowlist,
  lock_version, transition_step, operation_id, updated_at`;

/** 读单行 deploy_state。行不存在(迁移未 seed)→ 抛错(fail-closed:状态机权威缺失绝不静默默认)。 */
export async function readDeployState(pool: Pool): Promise<DeployStateRow> {
  const r = await pool.query<RawDeployRow>(
    `SELECT ${SELECT_COLS} FROM deploy_state WHERE singleton = true`,
  );
  if (r.rowCount === 0 || !r.rows[0]) {
    throw new Error("[deployState] deploy_state 单行缺失(0135 seed 未 apply?),拒绝默认化");
  }
  return mapRow(r.rows[0]);
}

// ── CAS 转移 ────────────────────────────────────────────────────────────────
/** 可 CAS 写入的字段子集(camelCase→列)。singleton/lock_version/updated_at 由本模块托管。 */
export interface DeployStatePatch {
  generation?: number;
  phase?: DeployPhase;
  activeSlot?: Slot;
  candidateSlot?: Slot | null;
  activeRelease?: string | null;
  candidateRelease?: string | null;
  desiredLeaderSlot?: Slot;
  desiredControlSlot?: Slot;
  cohortPercent?: number;
  cohortSalt?: string;
  cohortAllowlist?: string[];
  transitionStep?: number;
  operationId?: string | null;
}

// 白名单映射:防 patch key 拼接进 SQL 造成注入面(值仍走参数化)。
const PATCH_COLUMN: Record<keyof DeployStatePatch, string> = {
  generation: "generation",
  phase: "phase",
  activeSlot: "active_slot",
  candidateSlot: "candidate_slot",
  activeRelease: "active_release",
  candidateRelease: "candidate_release",
  desiredLeaderSlot: "desired_leader_slot",
  desiredControlSlot: "desired_control_slot",
  cohortPercent: "cohort_percent",
  cohortSalt: "cohort_salt",
  cohortAllowlist: "cohort_allowlist",
  transitionStep: "transition_step",
  operationId: "operation_id",
};

export interface JournalEntry {
  operationId: string;
  step: number;
  action: string;
}

export interface CasResult {
  /** true=CAS 命中并已提交;false=lock_version 不匹配(有人抢先转移)。 */
  ok: boolean;
  /** 最新行(ok=true 时为转移后行;ok=false 时为当前实际行,供调用方重算恢复方向)。 */
  row: DeployStateRow;
}

/**
 * 乐观并发转移:WHERE lock_version=$expected;命中则写 patch + lock_version+1 + updated_at,
 * 并在**同事务**插入 journal(若提供)。未命中 → ok:false + 返回当前行(不改任何东西)。
 *
 * 语义保证:成功即 lock_version 严格 +1(调用方可据此续作幂等恢复);journal 与状态推进原子。
 */
export async function casDeployState(
  pool: Pool,
  opts: { expectedLockVersion: number; patch: DeployStatePatch; journal?: JournalEntry | JournalEntry[] },
): Promise<CasResult> {
  const keys = (Object.keys(opts.patch) as Array<keyof DeployStatePatch>).filter(
    (k) => opts.patch[k] !== undefined,
  );
  return withDeployTx(pool, async (client) => {
    const setFrags: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const k of keys) {
      setFrags.push(`${PATCH_COLUMN[k]} = $${i++}`);
      values.push(opts.patch[k]);
    }
    setFrags.push("lock_version = lock_version + 1");
    setFrags.push("updated_at = now()");
    values.push(opts.expectedLockVersion); // $i = expected lock_version
    const r = await client.query<RawDeployRow>(
      `UPDATE deploy_state SET ${setFrags.join(", ")}
         WHERE singleton = true AND lock_version = $${i}
       RETURNING ${SELECT_COLS}`,
      values,
    );
    if (r.rowCount === 0 || !r.rows[0]) {
      // CAS 落空:读当前行(同事务快照)返回,让调用方按恢复矩阵重算,而非盲重试。
      const cur = await client.query<RawDeployRow>(
        `SELECT ${SELECT_COLS} FROM deploy_state WHERE singleton = true`,
      );
      if (!cur.rows[0]) throw new Error("[deployState] CAS 落空且单行缺失,状态机损坏");
      return { ok: false, row: mapRow(cur.rows[0]) };
    }
    const journals = opts.journal
      ? Array.isArray(opts.journal)
        ? opts.journal
        : [opts.journal]
      : [];
    for (const j of journals) {
      await client.query(
        `INSERT INTO deploy_state_journal (operation_id, step, action) VALUES ($1, $2, $3)`,
        [j.operationId, j.step, j.action],
      );
    }
    return { ok: true, row: mapRow(r.rows[0]) };
  });
}

// ── desired watch(5s 轮询缓存)─────────────────────────────────────────────
export interface DesiredWatch {
  /** 最近一次成功读取的快照;首次读取前为 null。 */
  current(): DesiredSnapshot | null;
  /** 首次成功读取完成(供启动期同步等待一次真实值)。 */
  waitReady(): Promise<DesiredSnapshot>;
  /** 立即拉一次(消费者在关键决策点需要精确判定,不等下一轮 5s tick)。 */
  refreshNow(): Promise<DesiredSnapshot>;
  /** 订阅 desired 变更(仅在 leader/control slot 或 generation 变化时回调);返回退订函数。 */
  onChange(cb: (snap: DesiredSnapshot) => void): () => void;
  stop(): void;
}

function toSnapshot(row: DeployStateRow): DesiredSnapshot {
  return {
    desiredLeaderSlot: row.desiredLeaderSlot,
    desiredControlSlot: row.desiredControlSlot,
    activeSlot: row.activeSlot,
    phase: row.phase,
    generation: row.generation,
  };
}

function snapshotEq(a: DesiredSnapshot | null, b: DesiredSnapshot): boolean {
  return (
    a !== null &&
    a.desiredLeaderSlot === b.desiredLeaderSlot &&
    a.desiredControlSlot === b.desiredControlSlot &&
    a.activeSlot === b.activeSlot &&
    a.phase === b.phase &&
    a.generation === b.generation
  );
}

export interface DesiredWatchOptions {
  pool: Pool;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * 启动 desired watch:每 intervalMs(默认 5s)读一次 deploy_state,缓存 desired 快照;变化时
 * 触发 onChange 订阅者。轮询失败保留旧缓存 + 上报 onError(短暂 PG 抖动不该让消费者误判 desired)。
 * timer unref,不阻止进程退出。
 */
export function startDesiredWatch(opts: DesiredWatchOptions): DesiredWatch {
  const intervalMs = opts.intervalMs ?? 5_000;
  let snap: DesiredSnapshot | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs = new Set<(s: DesiredSnapshot) => void>();
  let readyResolve: ((s: DesiredSnapshot) => void) | null = null;
  const ready = new Promise<DesiredSnapshot>((res) => {
    readyResolve = res;
  });

  async function pollOnce(): Promise<DesiredSnapshot> {
    const row = await readDeployState(opts.pool);
    const next = toSnapshot(row);
    const changed = !snapshotEq(snap, next);
    snap = next;
    if (readyResolve) {
      readyResolve(next);
      readyResolve = null;
    }
    if (changed && !stopped) {
      for (const cb of subs) {
        try {
          cb(next);
        } catch (err) {
          opts.onError?.(err);
        }
      }
    }
    return next;
  }

  function scheduleTick(): void {
    timer = setInterval(() => {
      void pollOnce().catch((err) => opts.onError?.(err));
    }, intervalMs);
    if (timer && typeof timer === "object" && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  // 首轮立即拉一次(不等第一个 interval),失败也起周期轮询(可能是启动瞬时 PG 未就绪)。
  void pollOnce().catch((err) => opts.onError?.(err));
  scheduleTick();

  return {
    current: () => snap,
    waitReady: () => ready,
    refreshNow: () => pollOnce(),
    onChange: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      subs.clear();
    },
  };
}

// ── 本地 withTx(不复用 pgSessionsBackend 的私有版本,保持模块自洽)──────────────
async function withDeployTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // ROLLBACK 失败 = 连接事务态未知,绝不还池(会污染下个借出者)。销毁。
      destroyed = true;
      try {
        client.release(rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)));
      } catch {
        /* 连接已断 */
      }
    }
    throw err;
  } finally {
    if (!destroyed) client.release();
  }
}
