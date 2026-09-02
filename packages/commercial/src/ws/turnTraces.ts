// turn_traces 登记 — traceId(响应底部请求ID)的唯一持久落点。
//
// bridge 在 inbound.message 铸造 canonical traceId(userChatBridge CG2a)后调用本函数
// fire-and-forget 落一行;运维拿用户报的请求ID一条 SQL 定位 user/session/时间:
//   select * from turn_traces where trace_id = '<id>';
// 失败绝不影响 turn 主链路:观测面挂了不能拖垮对话面,只 warn 一条。
import type { Pool } from "pg";
import { controlPlaneIdentity } from "../admin/observabilityIdentity.js";

export interface TurnTraceRow {
  traceId: string;
  userId: bigint;
  sessionKey: string;
  agentId?: string | null;
  model?: string | null;
  // durable turn dispatch(RFC §2):纯展示,记 dispatch 身份/请求 id 供运维定位,不参与任何判定。
  dispatchId?: string | null;
  requestId?: string | null;
  /** Actual container platform bundle label returned by ensureRunning. */
  bundleRev?: string | null;
  /** Browser DOM oc-build reported in inbound.hello; absent/invalid stays NULL. */
  clientBuild?: string | null;
}

/**
 * OCV5-57 audit r3: INSERT and dispatch-id backfill share the same bounded
 * backoff so a single PG blip does not drop the row. Timers are unref'd.
 * ON CONFLICT DO NOTHING rowCount=0 is success (row already exists).
 */
export const TURN_TRACE_WRITE_RETRY_DELAYS_MS = [0, 50, 250] as const;
export const TURN_TRACE_DISPATCH_BACKFILL_DELAYS_MS = TURN_TRACE_WRITE_RETRY_DELAYS_MS;

function retryPoolWrite(opts: {
  delays: readonly number[];
  run: () => Promise<{ rowCount?: number | null }>;
  /** When true, rowCount=0 schedules another attempt (UPDATE miss). INSERT conflict is success. */
  retryOnEmpty: boolean;
  onDone: (ok: boolean, err: unknown | undefined, attempts: number) => void;
}): void {
  const attempt = (index: number): void => {
    void opts.run()
      .then((result) => {
        if (!opts.retryOnEmpty || (result.rowCount ?? 0) > 0) {
          opts.onDone(true, undefined, index + 1);
          return;
        }
        schedule(index, undefined);
      })
      .catch((err) => schedule(index, err));
  };
  const schedule = (index: number, err: unknown | undefined): void => {
    const next = index + 1;
    if (next >= opts.delays.length) {
      opts.onDone(false, err, next);
      return;
    }
    const timer = setTimeout(() => attempt(next), opts.delays[next]);
    timer.unref?.();
  };
  attempt(0);
}

export function recordTurnTrace(
  pool: Pool | undefined,
  warn: ((msg: string, fields?: Record<string, unknown>) => void) | undefined,
  row: TurnTraceRow,
): void {
  if (!pool) return;
  const version = controlPlaneIdentity();
  retryPoolWrite({
    delays: TURN_TRACE_WRITE_RETRY_DELAYS_MS,
    retryOnEmpty: false,
    run: () => pool.query(
      `INSERT INTO turn_traces
         (trace_id,user_id,session_key,agent_id,model,dispatch_id,request_id,
          control_plane_release,control_plane_commit,bundle_rev,client_build)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (trace_id) DO NOTHING`,
      [
        row.traceId,
        row.userId.toString(),
        row.sessionKey,
        row.agentId ?? null,
        row.model ?? null,
        row.dispatchId ?? null,
        row.requestId ?? null,
        version.release,
        version.commit,
        row.bundleRev ?? null,
        row.clientBuild ?? null,
      ],
    ),
    onDone: (ok, err, attempts) => {
      if (ok) return;
      warn?.("turn-trace record failed", { err: String(err ?? "exhausted"), attempts });
    },
  });
}

/**
 * MIN1:trace 登记发生在**分类阶段**(同步,dispatch 尚未受理),此时 dispatch_id/request_id
 * 还没铸;受理成功后本函数 **fire-and-forget** 补填这两个纯展示列(RFC §2 I3)。绝不动受理主链,
 * 失败只 warn(观测挂了不能拖垮对话)。COALESCE 兜底:trace 行若尚未落(极端时序),UPDATE
 * 命中 0 行无害,下次进会话仍可靠 dispatch/usage 表定位。
 *
 * OCV5-57 audit r1 B2 / r3: bounded retry (3 attempts, backoff) on both
 * empty rowCount and thrown PG errors. Still non-blocking; timers are unref'd.
 */
export function updateTurnTraceDispatch(
  pool: Pool | undefined,
  warn: ((msg: string, fields?: Record<string, unknown>) => void) | undefined,
  input: { traceId: string; dispatchId: string; requestId: string },
): void {
  if (!pool) return;
  retryPoolWrite({
    delays: TURN_TRACE_DISPATCH_BACKFILL_DELAYS_MS,
    retryOnEmpty: true,
    run: () => pool.query(
      `UPDATE turn_traces
          SET dispatch_id = COALESCE(dispatch_id, $2),
              request_id  = COALESCE(request_id, $3)
        WHERE trace_id = $1`,
      [input.traceId, input.dispatchId, input.requestId],
    ),
    onDone: (ok, err, attempts) => {
      if (ok) return;
      warn?.(
        err ? "turn-trace dispatch backfill failed" : "turn-trace dispatch backfill missed",
        { err: err !== undefined ? String(err) : undefined, traceId: input.traceId, attempts },
      );
    },
  });
}
