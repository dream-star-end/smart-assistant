// 反馈 / 响应评分页共享的后端形状（以 packages/commercial/src/http/admin 的 handler 为准）。

// ─── 用户反馈（GET /api/admin/feedback） ─────────────────────────────
export type FeedbackStatus = "open" | "acked" | "closed";
export type FeedbackPriority = "low" | "normal" | "high" | "urgent";
export type FeedbackTrafficClass =
  | "production_user"
  | "anonymous"
  | "legacy_unavailable"
  | "internal_admin"
  | "synthetic_canary"
  | "e2e";

export interface FeedbackRow {
  id: string;
  user_id: string | null;
  username: string | null;
  category: string;
  description: string;
  request_id: string | null;
  version: string | null;
  session_id: string | null;
  user_agent: string | null;
  meta: Record<string, unknown> | null;
  status: FeedbackStatus;
  handled_by: string | null;
  handled_at: string | null;
  assigned_to: string | null;
  priority: FeedbackPriority | null;
  resolution: string | null;
  created_at: string;
  traffic_class: FeedbackTrafficClass;
}

export interface FeedbackTotals {
  total: number;
  by_status: Record<FeedbackStatus, number>;
  by_priority: Record<FeedbackPriority | "unassigned", number>;
}

export interface FeedbackListResp {
  rows: FeedbackRow[];
  totals: FeedbackTotals;
  next_before_created_at: string | null;
  next_before_id: string | null;
}

// ─── 响应评分（GET /api/admin/response-ratings） ─────────────────────
export interface RatingBucket {
  up: number;
  down: number;
  total: number;
  /** up / total（0..1）；total=0 时为 null。 */
  up_rate: number | null;
  ci95_low: number | null;
  ci95_high: number | null;
  sample_note: "no_sample" | "small_sample" | "observed";
}

export interface ModelRatingStat extends RatingBucket {
  model: string | null;
}

export interface ResponseRatingStats {
  overall: RatingBucket;
  last_7d: RatingBucket;
  last_30d: RatingBucket;
  by_model: ModelRatingStat[];
  rating_users: number;
  completed_turns: { last_7d: number; last_30d: number };
  explicit_coverage: { last_7d: number | null; last_30d: number | null };
  implicit_per_100_completed_turns: { last_7d: number | null; last_30d: number | null };
  trace_completeness: {
    total: number;
    with_trace: number;
    missing_trace: number;
  };
}

export interface DownRatingRow {
  id: string;
  model: string | null;
  tags: string[];
  comment: string | null;
  trace_id: string | null;
  session_id: string | null;
  created_at: string;
  username: string | null;
  traffic_class: "production_user" | "internal_admin" | "synthetic_canary" | "e2e";
}

export interface ResponseRatingsResp {
  stats: ResponseRatingStats;
  down_ratings: {
    source: "explicit" | "implicit" | "all";
    traffic_class: string;
    rows: DownRatingRow[];
    next_before_created_at: string | null;
    next_before_id: string | null;
  };
}

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "未处理",
  acked: "已确认",
  closed: "已关闭",
};

/** open=待处理（warning），acked=已确认（success），closed=已关闭（neutral）。 */
export const FEEDBACK_STATUS_TONE: Record<FeedbackStatus, "warning" | "success" | "neutral"> = {
  open: "warning",
  acked: "success",
  closed: "neutral",
};
