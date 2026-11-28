import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseUsageBoardProjectQuery,
  pgUsageBoardProjectSql,
} from "../../billing/boardProjectAttribution.js";
import { loadLedgerRowContext } from "../../billing/ledgerRowContext.js";
import { getUserUsageReport, isUsageWindow, type UsageWindow } from "../../billing/usageReport.js";
import { query } from "../../db/queries.js";
import { HttpError, sendJson } from "../util.js";
import type { AuthenticatedHttpUser } from "./shared.js";

const USAGE_ID_RE = /^[1-9][0-9]{0,19}$/;
const SAVINGS_ROW_CAP = 10_000;

function parseUsageLimit(raw: string | null, def: number, max: number): number {
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new HttpError(400, "INVALID_USAGE_QUERY", `limit must be integer in [1,${max}]`);
  }
  return n;
}

function parseUsageOffset(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new HttpError(400, "INVALID_USAGE_QUERY", "offset must be non-negative integer");
  }
  return n;
}

interface SessionUsageRow {
  session_id: string;
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  billed_credits: string;
  delegate_credits: string;
  delegate_requests: string;
  delegate_only: boolean;
  last_used_at: Date;
}

async function fetchMyUsageQueries(
  uid: string,
  boardProjectId: string | null | undefined,
  sessionsLimit: number,
  sessionsOffset: number,
) {
  const board = pgUsageBoardProjectSql(boardProjectId, 2);
  const boardUr = pgUsageBoardProjectSql(boardProjectId, 2, "ur");
  const sessBoard = pgUsageBoardProjectSql(boardProjectId, 2);
  const sessLimitIdx = sessBoard.nextIndex;
  const sessOffsetIdx = sessLimitIdx + 1;
  const savBoard = pgUsageBoardProjectSql(boardProjectId, 2);

  return Promise.all([
    query<{
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
      requests_total: string;
    }>(
      `SELECT COALESCE(SUM(input_tokens),0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text        AS billed_credits,
              COUNT(*)::bigint::text                     AS requests_total
         FROM usage_records
        WHERE user_id = $1 AND status = 'success'${board.sql}`,
      [uid, ...board.params],
    ),
    query<{
      requests: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      billed_credits: string;
    }>(
      `SELECT COUNT(*)::bigint::text                      AS requests,
              COALESCE(SUM(input_tokens),0)::text         AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text        AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text    AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text   AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text         AS billed_credits
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND session_id IS NULL${board.sql}`,
      [uid, ...board.params],
    ),
    query<{ debited_credits: string }>(
      `SELECT COALESCE(SUM(-cl.delta), 0)::text AS debited_credits
         FROM usage_records ur
         JOIN credit_ledger cl ON cl.id = ur.ledger_id
        WHERE ur.user_id = $1 AND ur.status = 'success' AND cl.delta < 0${boardUr.sql}`,
      [uid, ...boardUr.params],
    ),
    query<SessionUsageRow>(
      `SELECT COALESCE(
                CASE WHEN mode = 'delegate' THEN parent_session_id END,
                session_id
              )                                          AS session_id,
              COUNT(*)::bigint::text                     AS requests,
              COALESCE(SUM(input_tokens),0)::text        AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text       AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text   AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens),0)::text  AS cache_write_tokens,
              COALESCE(SUM(cost_credits),0)::text        AS billed_credits,
              COALESCE(SUM(cost_credits) FILTER (WHERE mode = 'delegate'),0)::text
                                                         AS delegate_credits,
              COUNT(*) FILTER (WHERE mode = 'delegate')::bigint::text
                                                         AS delegate_requests,
              bool_and(mode = 'delegate')                AS delegate_only,
              MAX(created_at)                            AS last_used_at
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND session_id IS NOT NULL${sessBoard.sql}
        GROUP BY 1
        ORDER BY MAX(created_at) DESC, 1 DESC
        LIMIT $${sessLimitIdx} OFFSET $${sessOffsetIdx}`,
      [uid, ...sessBoard.params, sessionsLimit + 1, sessionsOffset],
    ),
    query<{ cutoff_started_at: Date | null }>(
      `SELECT MIN(created_at) AS cutoff_started_at
         FROM usage_records
        WHERE user_id = $1 AND session_id IS NOT NULL${board.sql}`,
      [uid, ...board.params],
    ),
    query<{ cache_read_tokens: string; price_snapshot: unknown }>(
      `SELECT cache_read_tokens::text AS cache_read_tokens,
              price_snapshot
         FROM usage_records
        WHERE user_id = $1 AND status = 'success' AND cache_read_tokens > 0${savBoard.sql}
        LIMIT ${SAVINGS_ROW_CAP + 1}`,
      [uid, ...savBoard.params],
    ),
  ]);
}

async function computeCacheSavings(
  rows: ReadonlyArray<{ cache_read_tokens: string; price_snapshot: unknown }>,
) {
  const { multiplierToScaled, COST_SCALE } = await import("../../billing/calculator.js");
  if (rows.length > SAVINGS_ROW_CAP) {
    return {
      savings_credits: null,
      savings_is_estimate: false,
      savings_unavailable: true,
      savings_rows_skipped: 0,
    };
  }
  let savingsTotal = 0n;
  let savingsRowsSkipped = 0;
  for (const r of rows) {
    try {
      const snap = r.price_snapshot as {
        input_per_mtok?: unknown;
        cache_read_per_mtok?: unknown;
        multiplier?: unknown;
      } | null;
      if (
        !snap ||
        typeof snap !== "object" ||
        typeof snap.input_per_mtok !== "string" ||
        typeof snap.cache_read_per_mtok !== "string" ||
        typeof snap.multiplier !== "string"
      ) {
        savingsRowsSkipped++;
        continue;
      }
      const inputPer = BigInt(snap.input_per_mtok);
      const cachePer = BigInt(snap.cache_read_per_mtok);
      if (inputPer <= cachePer) continue;
      const mul = multiplierToScaled(snap.multiplier);
      const tokens = BigInt(r.cache_read_tokens);
      const scaled = tokens > 0n ? tokens * (inputPer - cachePer) * mul : 0n;
      if (scaled > 0n) {
        savingsTotal += (scaled + COST_SCALE - 1n) / COST_SCALE;
      }
    } catch {
      savingsRowsSkipped++;
    }
  }
  return {
    savings_credits: savingsTotal.toString(),
    savings_is_estimate: savingsRowsSkipped > 0,
    savings_unavailable: false,
    savings_rows_skipped: savingsRowsSkipped,
  };
}

type DelegateDetail = {
  delegate_agent_id: string | null;
  model: string;
  requests: string;
  billed_credits: string;
};

async function fetchDelegateDetails(
  uid: string,
  boardProjectId: string | null | undefined,
  rowsPage: readonly SessionUsageRow[],
): Promise<Map<string, DelegateDetail[]>> {
  const delegatesByKey = new Map<string, DelegateDetail[]>();
  const delegateKeys = rowsPage
    .filter((r) => r.delegate_requests !== "0")
    .map((r) => r.session_id);
  if (delegateKeys.length === 0) return delegatesByKey;

  const delBoard = pgUsageBoardProjectSql(boardProjectId, 3);
  const detail = await query<DelegateDetail & { session_key: string }>(
    `SELECT COALESCE(parent_session_id, session_id) AS session_key,
            delegate_agent_id,
            model,
            COUNT(*)::bigint::text                  AS requests,
            COALESCE(SUM(cost_credits),0)::text     AS billed_credits
       FROM usage_records
      WHERE user_id = $1 AND status = 'success' AND mode = 'delegate'
        AND session_id IS NOT NULL
        AND COALESCE(parent_session_id, session_id) = ANY($2::text[])${delBoard.sql}
      GROUP BY 1, 2, 3
      ORDER BY 1, SUM(cost_credits) DESC, 2 NULLS LAST, 3`,
    [uid, delegateKeys, ...delBoard.params],
  );
  for (const d of detail.rows) {
    const list = delegatesByKey.get(d.session_key) ?? [];
    list.push({
      delegate_agent_id: d.delegate_agent_id,
      model: d.model,
      requests: d.requests,
      billed_credits: d.billed_credits,
    });
    delegatesByKey.set(d.session_key, list);
  }
  return delegatesByKey;
}

async function fetchUserLedgerPage(
  uid: string,
  ledgerLimit: number,
  ledgerBeforeRaw: string | null,
) {
  const { listLedger } = await import("../../admin/ledger.js");
  const ledgerResult = await listLedger({
    userId: uid,
    limit: ledgerLimit,
    before: ledgerBeforeRaw && ledgerBeforeRaw !== "" ? ledgerBeforeRaw : undefined,
  });
  const ledgerContext = await loadLedgerRowContext(query, uid, ledgerResult.rows);
  return {
    rows: ledgerResult.rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      balance_after: r.balance_after,
      reason: r.reason,
      workload: r.workload,
      ref_type: r.ref_type,
      ref_id: r.ref_id,
      memo: r.memo,
      model_name: ledgerContext.get(r.id)?.model_name ?? null,
      session_title: ledgerContext.get(r.id)?.session_title ?? null,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
    next_before: ledgerResult.next_before,
  };
}

export async function serveGetMyUsage(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const sessionsLimit = parseUsageLimit(url.searchParams.get("sessions_limit"), 20, 100);
  const sessionsOffset = parseUsageOffset(url.searchParams.get("sessions_offset"));
  const ledgerLimit = parseUsageLimit(url.searchParams.get("ledger_limit"), 20, 100);
  const ledgerBeforeRaw = url.searchParams.get("ledger_before");
  if (ledgerBeforeRaw !== null && ledgerBeforeRaw !== "" && !USAGE_ID_RE.test(ledgerBeforeRaw)) {
    throw new HttpError(400, "INVALID_USAGE_QUERY", "ledger_before must be a bigint id");
  }

  const uid = user.id;
  const boardProjectId = parseUsageBoardProjectQuery(url.searchParams.get("boardProjectId"));
  const [summaryRow, legacyRow, debitedRow, sessionsRows, cutoffRow, savingsRows] =
    await fetchMyUsageQueries(uid, boardProjectId, sessionsLimit, sessionsOffset);

  const savings = await computeCacheSavings(savingsRows.rows);
  const sum = summaryRow.rows[0] ?? {
    input_tokens: "0",
    output_tokens: "0",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    billed_credits: "0",
    requests_total: "0",
  };
  const denom = BigInt(sum.input_tokens) + BigInt(sum.cache_read_tokens);
  const hitRate =
    denom > 0n ? Number((BigInt(sum.cache_read_tokens) * 10_000n) / denom) / 10_000 : null;

  const hasMore = sessionsRows.rows.length > sessionsLimit;
  const rowsPage = hasMore ? sessionsRows.rows.slice(0, sessionsLimit) : sessionsRows.rows;
  const [delegatesByKey, ledger] = await Promise.all([
    fetchDelegateDetails(uid, boardProjectId, rowsPage),
    fetchUserLedgerPage(uid, ledgerLimit, ledgerBeforeRaw),
  ]);

  const sessions = rowsPage.map((r) => {
    const delegates = delegatesByKey.get(r.session_id);
    return {
      session_id: r.session_id,
      requests: r.requests,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      billed_credits: r.billed_credits,
      last_used_at: r.last_used_at.toISOString(),
      delegate_credits: r.delegate_credits,
      delegate_requests: r.delegate_requests,
      delegate_only: r.delegate_only,
      ...(delegates && delegates.length > 0 ? { delegates } : {}),
    };
  });

  const leg = legacyRow.rows[0] ?? {
    requests: "0",
    input_tokens: "0",
    output_tokens: "0",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    billed_credits: "0",
  };
  const cutoff = cutoffRow.rows[0]?.cutoff_started_at ?? null;
  sendJson(res, 200, {
    summary: { ...sum, debited_credits: debitedRow.rows[0]?.debited_credits ?? "0" },
    legacy_unattributed: leg,
    savings,
    cache: { hit_rate: hitRate },
    sessions: { rows: sessions, limit: sessionsLimit, offset: sessionsOffset, has_more: hasMore },
    ledger,
    cutoff_started_at: cutoff ? cutoff.toISOString() : null,
  });
}

export async function serveGetMyUsageReport(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const raw = url.searchParams.get("window");
  let window: UsageWindow = "7d";
  if (raw !== null && raw !== "") {
    if (!isUsageWindow(raw)) {
      throw new HttpError(400, "INVALID_USAGE_QUERY", "window must be 24h, 7d or 30d");
    }
    window = raw;
  }
  const boardProjectId = parseUsageBoardProjectQuery(url.searchParams.get("boardProjectId"));
  const report = await getUserUsageReport(user.id, window, boardProjectId);
  sendJson(res, 200, report);
}
