#!/usr/bin/env python3
"""Read-only live metrics for the personal-edition refactor (feat/v5-selfhost).

口径（与 subagents/ADMIN-SESSIONS-30D.md、GOAL.md §2 对齐，写进输出）：

人群
  默认：全体用户，排除 uid 765（验收号）。
  --uid 显式传入时只统计这些 uid（因此可以单独复测某一个账号，包括 765）。
  自动化会话：session_id 不以 web 开头（gNNN、ocv、retprobe、探针等）不进入比率。
  人发回合 H：web 会话，且 client_message_id 以 m- 开头，但不是 m-recover-。
  平台自动恢复 S_recover：web 会话里的 m-recover-。
  委派回调 dlgcb-、租约回调 lsc- 单独计数，不进 H，也不进恢复比的分子。

W1
  停止命中已结束回合：turn_control_requests.kind='stop' 且 error_code='TURN_ALREADY_ENDED'，
  仅 Master 的 PG exact dispatch 终态证据确认。分母是同一窗口、同一人群的 web 停止请求。
  TURN_NOT_ACTIVE 单列为历史 runtime miss，包含准入前未命中，不作为已结束证据。
  切后台首绘：product_friction_events.code='FIRST_TEXT_PAINT_AFTER_BACKGROUND' 的
  latency_ms，用 percentile_cont（p50 / p95）。没有 latency 的事件计入 n，但不进分位。
  空白视口：code LIKE 'TIMELINE_BLANK%' 的事件次数（web）。
  断线超过 drain：master 日志里，人发回合的发起连接在终态前断开，且从断开到终态之间
  没有任何同 uid 连接覆盖的时长 > 60s。浏览器在 `user-chat-bridge: enter drain` 时已经断开；
  没有这条日志时，断开时间才用 `user-chat-bridge: closed`。日志不含 session_id，同 uid 的其它标签页会算作「有连接」。
  个人帧缺口：只算 gateway 的 dispatch 流（stream_key 不以 legacy: 开头）。
  缺口 A = max(frame_seq) - count > 200；缺口 B = (max-min+1) - count > 200。
  pruneProjectedLiveFrames 会删掉已投影到 tape 的帧，于是 count=0 且 max 为空。
  这类流标为不可观测：不进缺口分母，也不当成缺口 0。legacy 流序号跨回合共用，不算。
  SERVICE_RESTART：failure_code='SERVICE_RESTART'，按终态时间落入窗口。
  头条用 web 会话（含该会话上的恢复回合）；自动化会话另列，不进头条。
  6 小时 orphan：reconciler 的 fence_hard_cap 不写 failure_code。
  能对上的记录是 product_friction_events.stage='visible_fallback' 且 reason='fence_hard_cap'
  （只在没有 tape、走了 projectFallback 时写）。
  另外单列：producer_fenced_at 非空、outcome=interrupted、终态时刻减去
  accepted/admitted ≥ 6 小时。这是代理，不是动作名本身。
  日志里 fence_hard_cap 的行数只覆盖日志保留期与查询窗口的交集。
  生产日志的用户字段是 userId（bridge 连接日志才是 uid）。缺 userId 的行不计入。
  只统计 ts 落在 [since, until) 且 userId 属于本次查询人群的行；默认人群排除 765。
  container_link_active：information_schema 里有这个列或 container_links 表才计数，
  否则输出「未上线」。

W2
  超限硬失败按三桶：request_too_large、prompt_too_large、context_limit。
  分类规则见 classify_oversize。三处来源分开列，不相加：
  request_finalize_journal（一条记录进一个桶，且能连上 web 会话）、
  client_sessions.messages 里的文本出现次数（web 会话）、
  turn_dispatches.failure_code（目前多半是粗码，对得上才计数）。

W3
  自动恢复比 = S_recover / H，两边都按 admitted_at 落入窗口。
  引擎错误码：turn_recovery_jobs.error_code（web），以及人发回合非 completed 的 failure_code。
  后者含 USER_CANCELLED，不是纯引擎码，输出里分开写。

W5
  Box：人发回合里 model 以 box- 开头。非 completed 率 = outcome 不是 completed 的回合 / 回合数。
  NULL outcome 也计入非 completed；completed 和 non_terminal 另列。
  not_accepted 是其中 outcome='not_accepted' 的次数。失败桶保留模型、status/outcome/failure_code；
  model_family 只按模型前缀分类，不代表实际 transport。stage 按 outcome/status 派生，不是日志阶段。
  续接拒绝：journal.error_msg / failure_code 命中 BOX_TOOL_OWNER_UNKNOWN、BOX_REPLAY_REJECTED、
  BOX_REPLAY_PENDING、ECHO_MISMATCH、echo mismatch、snapshot mismatch。按码分，web 与
  自动化、连不上会话的行分开，头条只加 web；这份旧来源不覆盖准入前拒绝。
  box_continuation_decisions：全个人实例校验事件，按五分钟相交桶、kind/component/release/commit
  汇总 sample_count；没有 uid/model 标签，不能套用 H/uid 过滤，也不与旧 journal 次数相加。
  边缘桶可能包含窗口外事件；没有持久化样本不等于拒绝为零。

日志
  /var/log/openclaude-v5-selfhost.log* 只保留约 15 天。断线和日志侧 orphan 计数
  只覆盖日志与查询窗口的交集，输出里写明起点。
  每一行是 JSON，时间在 "ts" 字段，行首没有独立时间戳。日志窗口取全部行里能解析的 ts
  的最小和最大，不只取 user-chat-bridge / fence_hard_cap 行。没有 ts 的行（例如
  当前文件开头的 writeCalls 摘要）不移动窗口。

安全
  只读。每段 SQL 由本脚本包进 BEGIN READ ONLY … ROLLBACK，statement_timeout=20s。
  库名写死为 openclaude_v5_selfhost（个人版）。不接收数据库 URL。
  查询带时间范围；W5 聚合保留全部分桶，其余分组查询带 LIMIT。
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import re
import subprocess
import sys
from pathlib import Path

ACCEPTANCE_UID = 765
PERSONAL_DB = "openclaude_v5_selfhost"
DRAIN_SECONDS = 60.0
GAP_THRESHOLD = 200
STATEMENT_TIMEOUT_MS = 20_000
LOG_RETENTION_NOTE = (
    "个人版 master 日志 /var/log/openclaude-v5-selfhost.log* 只保留约 15 天"
    "（logrotate 保留 14 个历史切片）。断线超过 drain、以及日志里的 fence_hard_cap 行，"
    "只覆盖日志文件与查询窗口的交集；早于日志起点的时段标为未覆盖，不当成 0。"
)
PRUNE_NOTE = (
    "个人版 pruneProjectedLiveFrames 会删掉已经投影到 tape 的 dispatch 流的帧，"
    "于是 count=0 且 max(frame_seq) 为空。这类流是不可观测：不进入缺口分母，也不当成缺口 0。"
    "legacy: 流的序号在同一容器会话的多个回合之间共用，本指标不算它们。"
    "缺口 A = max(frame_seq) - count > 200。缺口 B = (max - min + 1) - count > 200。"
    "分母是窗口内仍留有帧的 dispatch 流。"
)
COHORT_NOTE = (
    "默认排除 uid 765 验收号。自动化会话（session_id 不以 web 开头）不进入比率。"
    "H 是 web 会话里 cmid 以 m- 开头且不是 m-recover- 的人发回合。"
    "S_recover 是 m-recover-。dlgcb- 与 lsc- 单独计数。"
)
BOX_FAILURE_BUCKETS_NOTE = (
    "model_family 只按模型前缀分类（api_claude / claude / other_box），不代表实际 transport。"
    "stage 是派生分类：outcome=not_accepted → admission；其余非 terminal → in_flight；"
    "其余 terminal → execution，不是日志记录的真实失败阶段。NULL outcome 计入非 completed。"
)
BOX_CONTINUATION_DECISIONS_NOTE = (
    "全个人实例的持久化校验事件，不是人发回合数；没有 uid/model 标签，不能按本报告 H/uid 过滤。"
    "按与查询窗口相交的五分钟桶汇总 sample_count，边缘桶可能含窗口外事件。"
    "这些是当前持久化快照，不与旧 journal 次数相加；刷盘延迟、丢样本需结合运行日志判断。"
    "无持久化样本不证明拒绝为零。"
)

# 顺序有意义：先匹配更具体的请求体积，再匹配 prompt，再匹配上下文。
OVERSIZE_BUCKETS = (
    (
        "request_too_large",
        r"Request too large|PAYLOAD_TOO_LARGE|BODY_FIELD_TOO_LARGE|本轮资料未能完整处理|这轮资料暂时无法完整处理",
    ),
    (
        "prompt_too_large",
        r"PROMPT_TOO_LARGE|ANTIGRAVITY_PROMPT_TOO_LARGE|PROMPT_TOO_LONG|CURSOR_SAND_PROMPT_TOO_LONG|prompt is too long",
    ),
    (
        "context_limit",
        r"context window|BOX_CONTEXT_TOO_LARGE|context_too_long|CONTEXT_LENGTH|ran out of room in the model",
    ),
)
CONTINUATION_CODES = (
    ("BOX_TOOL_OWNER_UNKNOWN", "BOX_TOOL_OWNER_UNKNOWN"),
    ("BOX_REPLAY_REJECTED", "BOX_REPLAY_REJECTED"),
    ("BOX_REPLAY_PENDING", "BOX_REPLAY_PENDING"),
    ("ECHO_MISMATCH", "ECHO_MISMATCH"),
    ("echo mismatch", "ECHO_MISMATCH"),
    ("snapshot mismatch", "SNAPSHOT_MISMATCH"),
)
NEW_METRIC_PROBES = (
    ("container_link_active", "column"),
    ("container_links", "table"),
)

_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$")
_LOG_NAME_RE = re.compile(r"openclaude-v5-selfhost\.log(\.\d+(\.gz)?)?$")
_PREFIX_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\S+Z)\s+")
# 生产日志行首是 "{"，时间只在 JSON 的 ts 字段里。用正则取窗口，避免对每一行 json.loads。
_JSON_TS_RE = re.compile(
    r'"ts"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))"'
)
_URL_RE = re.compile(r"(postgres(ql)?://)[^ \s\"]+")

CLOSED_MSG = "user-chat-bridge: closed"
INBOUND_MSG = "user-chat-bridge: inbound turn start"
ENTER_DRAIN_MSG = "user-chat-bridge: enter drain"


def redact(text: str) -> str:
    return _URL_RE.sub(r"\1<redacted>", text or "")


def sql_ts(value: str) -> str:
    if not isinstance(value, str) or not _TS_RE.fullmatch(value):
        raise ValueError("since/until must be ISO-8601 with timezone and seconds precision")
    return "'" + value + "'"


def parse_uids(values: list[str] | None) -> list[int] | None:
    if not values:
        return None
    out: list[int] = []
    for raw in values:
        if not re.fullmatch(r"[0-9]+", raw or ""):
            raise ValueError("uid must be a non-negative integer")
        number = int(raw)
        if number > 2_147_483_647:
            raise ValueError("uid out of range")
        out.append(number)
    return out


def sql_user_predicate(uids: list[int] | None, column: str = "user_id") -> str:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?", column):
        raise ValueError("bad column")
    if uids:
        return column + " IN (" + ",".join(str(int(u)) for u in uids) + ")"
    return f"{column} <> {ACCEPTANCE_UID}"


def sql_text_user_predicate(uids: list[int] | None, column: str = "user_id") -> str:
    """client_sessions / live streams store user id as text 'c:<n>'."""
    if not re.fullmatch(r"[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?", column):
        raise ValueError("bad column")
    if uids:
        lits = ",".join("'c:%d'" % int(u) for u in uids)
        return f"{column} IN ({lits})"
    return f"{column} <> 'c:{ACCEPTANCE_UID}'"


def turn_class(session_id: str | None, client_message_id: str | None) -> str:
    session = session_id or ""
    cmid = client_message_id or ""
    if not session.startswith("web"):
        return "A_automation"
    if cmid.startswith("m-recover-"):
        return "S_recover"
    if cmid.startswith("dlgcb-"):
        return "S_delegate_cb"
    if cmid.startswith("lsc-"):
        return "S_lease_cb"
    if cmid.startswith("m-"):
        return "H_human"
    return "S_other"


def is_box_model(model: str | None) -> bool:
    return bool(model) and model.startswith("box-")


def percentile_cont(values: list[float], p: float) -> float | None:
    """PostgreSQL percentile_cont: linear interpolation on the sorted sample."""
    if not values:
        return None
    if not 0 <= p <= 1:
        raise ValueError("p out of range")
    xs = sorted(float(v) for v in values)
    if len(xs) == 1:
        return xs[0]
    rank = p * (len(xs) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(xs) - 1)
    frac = rank - lo
    return xs[lo] * (1 - frac) + xs[hi] * frac


def gap_a(max_seq: int | None, count: int | None) -> int | None:
    if max_seq is None or count is None:
        return None
    return int(max_seq) - int(count)


def gap_b(max_seq: int | None, min_seq: int | None, count: int | None) -> int | None:
    if max_seq is None or min_seq is None or count is None:
        return None
    return (int(max_seq) - int(min_seq) + 1) - int(count)


def gap_over(gap: int | None, threshold: int = GAP_THRESHOLD) -> bool:
    return gap is not None and gap > threshold


def is_dispatch_stream(stream_key: str | None) -> bool:
    return bool(stream_key) and not stream_key.startswith("legacy:")


def classify_oversize(text: str | None) -> str | None:
    if not text:
        return None
    for name, pattern in OVERSIZE_BUCKETS:
        if re.search(pattern, text, re.IGNORECASE):
            return name
    return None


def continuation_code(text: str | None) -> str | None:
    if not text:
        return None
    folded = text.lower()
    for needle, code in CONTINUATION_CODES:
        if needle.lower() in folded:
            return code
    return None


def ratio(numerator: int | None, denominator: int | None) -> float | None:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def fmt_ratio(numerator: int | None, denominator: int | None) -> str:
    if numerator is None or denominator is None or denominator == 0:
        return "无样本"
    return f"{(100.0 * numerator / denominator):.1f}% ({numerator}/{denominator})"


def fmt_ms(value) -> str:
    if value is None:
        return "无样本"
    number = float(value)
    if abs(number - round(number)) < 1e-6:
        return str(int(round(number)))
    return f"{number:.1f}"


def new_metric_status(exists: bool, value):
    if not exists:
        return "未上线"
    return value


def uncovered_seconds(intervals: list[tuple[float, float]], start: float, end: float) -> float:
    """Seconds inside [start, end] not covered by any [s, z] interval."""
    if end <= start:
        return 0.0
    segs = []
    for raw_start, raw_end in intervals:
        if raw_end <= start or raw_start >= end:
            continue
        segs.append((max(raw_start, start), min(raw_end, end)))
    segs.sort()
    cursor = start
    gap = 0.0
    for seg_start, seg_end in segs:
        if seg_start > cursor:
            gap += seg_start - cursor
        if seg_end > cursor:
            cursor = seg_end
    if end > cursor:
        gap += end - cursor
    return gap


def box_summary(rows: list[dict]) -> list[dict]:
    """rows: {model, turns, non_completed, not_accepted}. Adds rate. Does not invent models."""
    out = []
    for row in rows:
        model = row.get("model") or ""
        if not is_box_model(model):
            continue
        turns = int(row.get("turns") or 0)
        non_completed = int(row.get("non_completed") or 0)
        not_accepted = int(row.get("not_accepted") or 0)
        out.append({
            "model": model,
            "turns": turns,
            "completed": row.get("completed"),
            "non_completed": non_completed,
            "non_terminal": row.get("non_terminal"),
            "not_accepted": not_accepted,
            "non_completed_rate": ratio(non_completed, turns),
        })
    out.sort(key=lambda item: (-item["turns"], item["model"]))
    return out


def drain_stats(turns: list[dict], closes, inbounds, log_first: float | None, log_last: float | None, drain_s: float = DRAIN_SECONDS) -> dict:
    """Count H turns whose browser connection was gone for longer than drain.

    closes: (uid, conn_id, start_epoch, end_epoch)
    inbounds: (uid, trace_id, ts_epoch, conn_id)
    A turn admitted before log_first is not in the denominator. Missing origin
    is unknown, not a drain exceedance.
    """
    conns_by_uid: dict[int, dict[str, tuple[float, float]]] = {}
    for uid, conn_id, start, end in closes:
        conns_by_uid.setdefault(int(uid), {})[str(conn_id)] = (float(start), float(end))
    origin: dict[tuple[int, str], tuple[float, str]] = {}
    for uid, trace_id, ts, conn_id in inbounds:
        if not trace_id:
            continue
        key = (int(uid), str(trace_id))
        prev = origin.get(key)
        if prev is None or float(ts) < prev[0]:
            origin[key] = (float(ts), str(conn_id))
    stats = {
        "h_turns_input": len(turns),
        "before_log_retention": 0,
        "after_log_snapshot": 0,
        "still_open": 0,
        "h_turns_in_log_window": 0,
        "no_origin_conn": 0,
        "origin_close_not_logged": 0,
        "origin_closed_before_terminal": 0,
        "drain_exceeded_turns": 0,
        "drain_seconds": drain_s,
        "log_first": log_first,
        "log_last": log_last,
    }
    if log_first is None or log_last is None:
        stats["before_log_retention"] = len(turns)
        return stats
    for turn in turns:
        admitted = turn.get("a")
        ended = turn.get("e")
        if ended is None:
            stats["still_open"] += 1
            continue
        if admitted is None or admitted < log_first:
            stats["before_log_retention"] += 1
            continue
        if admitted > log_last:
            stats["after_log_snapshot"] += 1
            continue
        stats["h_turns_in_log_window"] += 1
        uid = int(turn["u"])
        traces: list[str] = []
        if turn.get("t"):
            traces.append(str(turn["t"]))
        for extra in turn.get("tt") or []:
            if extra and str(extra) not in traces:
                traces.append(str(extra))
        found = None
        for trace in traces:
            hit = origin.get((uid, trace))
            if hit is not None and (found is None or hit[0] < found[0]):
                found = hit
        if found is None:
            stats["no_origin_conn"] += 1
            continue
        conns = conns_by_uid.get(uid, {})
        closed = conns.get(found[1])
        if closed is None:
            stats["origin_close_not_logged"] += 1
            continue
        if closed[1] < float(ended) - 1:
            stats["origin_closed_before_terminal"] += 1
            gap = uncovered_seconds(list(conns.values()), closed[1], float(ended))
            if gap > drain_s:
                stats["drain_exceeded_turns"] += 1
    return stats


def _parse_epoch(text: str) -> float | None:
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.timestamp()


def parse_log_json(line: str) -> dict | None:
    body = line if line.startswith("{") else _PREFIX_TS_RE.sub("", line, count=1)
    try:
        obj = json.loads(body)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def _note_stamp(first: float | None, last: float | None, stamp: float | None) -> tuple[float | None, float | None]:
    if stamp is None:
        return first, last
    first = stamp if first is None else min(first, stamp)
    last = stamp if last is None else max(last, stamp)
    return first, last


def _line_stamp(line: str) -> float | None:
    prefix = _PREFIX_TS_RE.match(line)
    if prefix:
        return _parse_epoch(prefix.group(1))
    found = _JSON_TS_RE.search(line)
    if found:
        return _parse_epoch(found.group(1))
    return None


def _digit_id(raw) -> int | None:
    if isinstance(raw, bool) or raw is None:
        return None
    text = str(raw)
    if not text.isdigit():
        return None
    return int(text)


def _stamp_in_window(stamp: float | None, since: float | None, until: float | None) -> bool:
    if stamp is None:
        return False
    if since is not None and stamp < since:
        return False
    if until is not None and stamp >= until:
        return False
    return True


def scan_master_logs(
    paths: list[Path],
    turns: list[dict],
    since: float | None = None,
    until: float | None = None,
    cohort_uids: list[int] | set[int] | None = None,
) -> dict:
    """Scan master logs for browser disconnects and in-window fence_hard_cap lines.

    Bridge lines identify the user with uid. fence_hard_cap lines identify the
    user with userId. A fence line with no userId is not in scope. since/until
    are epoch seconds; None means that side of the window is open. cohort_uids
    None means every user except the acceptance account.
    """
    turn_uids = {int(turn["u"]) for turn in turns if turn.get("u") is not None}
    fence_cohort = None if cohort_uids is None else {int(uid) for uid in cohort_uids}
    closes = []
    inbounds = []
    drain_at: dict[tuple[int, str], float] = {}
    first = None
    last = None
    fence_in_scope = 0
    fence_other = 0
    for path in paths:
        opener = gzip.open if path.suffix == ".gz" else open
        with opener(path, "rt", errors="replace") as handle:
            for line in handle:
                first, last = _note_stamp(first, last, _line_stamp(line))
                interesting = "user-chat-bridge:" in line or "fence_hard_cap" in line
                if not interesting:
                    continue
                obj = parse_log_json(line)
                if obj is None:
                    continue
                if "fence_hard_cap" in line:
                    fence_uid = _digit_id(obj.get("userId"))
                    fence_stamp = _parse_epoch(str(obj.get("ts") or ""))
                    if fence_uid is not None and _stamp_in_window(fence_stamp, since, until):
                        in_cohort = (
                            fence_uid != ACCEPTANCE_UID
                            if fence_cohort is None
                            else fence_uid in fence_cohort
                        )
                        if in_cohort:
                            fence_in_scope += 1
                        else:
                            fence_other += 1
                uid = _digit_id(obj.get("uid"))
                if uid is None or uid not in turn_uids:
                    continue
                msg = obj.get("msg")
                stamp = _parse_epoch(str(obj.get("ts") or ""))
                if stamp is None:
                    continue
                conn_id = obj.get("connId")
                if msg == ENTER_DRAIN_MSG and conn_id:
                    key = (uid, str(conn_id))
                    prev = drain_at.get(key)
                    if prev is None or stamp < prev:
                        drain_at[key] = stamp
                elif msg == CLOSED_MSG and isinstance(obj.get("durationMs"), (int, float)) and conn_id:
                    closes.append((uid, str(conn_id), stamp - float(obj["durationMs"]) / 1000.0, stamp))
                elif msg == INBOUND_MSG and obj.get("traceId") and conn_id:
                    inbounds.append((uid, str(obj["traceId"]), stamp, str(conn_id)))
    adjusted = []
    for uid, conn_id, start, end in closes:
        disconnected = drain_at.get((uid, conn_id))
        if disconnected is not None and start <= disconnected < end:
            end = disconnected
        adjusted.append((uid, conn_id, start, end))
    stats = drain_stats(turns, adjusted, inbounds, first, last)
    stats["fence_hard_cap_lines_in_scope"] = fence_in_scope
    stats["fence_hard_cap_lines_other_uid"] = fence_other
    stats["log_files"] = len(paths)
    return stats


def _oversize_case(expr: str) -> str:
    parts = []
    for name, pattern in OVERSIZE_BUCKETS:
        if "'" in pattern:
            raise ValueError("oversize pattern must not contain a quote")
        parts.append(f"WHEN {expr} ~* '{pattern}' THEN '{name}'")
    return "CASE " + " ".join(parts) + " ELSE NULL END"


def _continuation_case(expr: str) -> str:
    parts = []
    seen = set()
    for needle, code in CONTINUATION_CODES:
        if code in seen:
            continue
        seen.add(code)
        needles = [raw for raw, mapped in CONTINUATION_CODES if mapped == code]
        clause = " OR ".join(f"{expr} ~* '{raw}'" for raw in needles)
        parts.append(f"WHEN {clause} THEN '{code}'")
    return "CASE " + " ".join(parts) + " ELSE NULL END"


def _class_case(session_col: str = "session_id", cmid_col: str = "client_message_id") -> str:
    return f"""CASE
      WHEN {session_col} !~ '^web' THEN 'A_automation'
      WHEN {cmid_col} ~ '^m-recover-' THEN 'S_recover'
      WHEN {cmid_col} ~ '^dlgcb-' THEN 'S_delegate_cb'
      WHEN {cmid_col} ~ '^lsc-' THEN 'S_lease_cb'
      WHEN {cmid_col} ~ '^m-' THEN 'H_human'
      ELSE 'S_other'
    END"""


def _h_sql(alias: str = "") -> str:
    p = f"{alias}." if alias else ""
    return (
        f"{p}session_id ~ '^web' AND {p}client_message_id ~ '^m-' "
        f"AND {p}client_message_id !~ '^m-recover-' "
        f"AND {p}client_message_id !~ '^dlgcb-' "
        f"AND {p}client_message_id !~ '^lsc-'"
    )


def build_queries(since: str, until: str, uids: list[int] | None) -> dict[str, str]:
    since_sql = sql_ts(since)
    until_sql = sql_ts(until)
    since_ms = int(_parse_epoch(since) * 1000)
    until_ms = int(_parse_epoch(until) * 1000)
    user = sql_user_predicate(uids, "user_id")
    user_d = sql_user_predicate(uids, "d.user_id")
    user_j = sql_user_predicate(uids, "j.user_id")
    user_s = sql_text_user_predicate(uids, "user_id")
    user_cs = sql_text_user_predicate(uids, "s.user_id")
    window = f"admitted_at >= {since_sql}::timestamptz AND admitted_at < {until_sql}::timestamptz"
    created = f"created_at >= {since_sql}::timestamptz AND created_at < {until_sql}::timestamptz"
    terminal = (
        f"coalesce(terminal_at, resolved_at) >= {since_sql}::timestamptz "
        f"AND coalesce(terminal_at, resolved_at) < {until_sql}::timestamptz"
    )
    oversize_msg = "|".join(pattern for _, pattern in OVERSIZE_BUCKETS)
    queries = {
        "cohort": f"""
SELECT json_build_object(
  'classes', (
    SELECT coalesce(json_object_agg(cls, n), '{{}}'::json)
    FROM (
      SELECT {_class_case()} AS cls, count(*) AS n
      FROM turn_dispatches
      WHERE {window} AND {user}
      GROUP BY 1
    ) s
  ),
  'h_users', (
    SELECT count(DISTINCT user_id)
    FROM turn_dispatches
    WHERE {window} AND {user} AND {_h_sql()}
  )
);
""",
        "stop": f"""
SELECT json_build_object(
  'stops', count(*),
  'turn_not_active', count(*) FILTER (WHERE error_code = 'TURN_NOT_ACTIVE'),
  'turn_already_ended', count(*) FILTER (WHERE error_code = 'TURN_ALREADY_ENDED')
)
FROM turn_control_requests
WHERE kind = 'stop' AND {created} AND {user} AND session_id ~ '^web';
""",
        "paint": f"""
SELECT json_build_object(
  'n', count(*),
  'n_with_latency', count(latency_ms),
  'p50_ms', percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),
  'p95_ms', percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),
  'max_ms', max(latency_ms)
)
FROM product_friction_events
WHERE code = 'FIRST_TEXT_PAINT_AFTER_BACKGROUND'
  AND {created} AND {user} AND session_id ~ '^web';
""",
        "blank": f"""
SELECT coalesce(json_agg(json_build_object('code', code, 'events', events, 'sessions', sessions) ORDER BY events DESC), '[]'::json)
FROM (
  SELECT code, count(*) AS events, count(DISTINCT session_id) AS sessions
  FROM product_friction_events
  WHERE code LIKE 'TIMELINE_BLANK%' AND {created} AND {user} AND session_id ~ '^web'
  GROUP BY code
  ORDER BY events DESC
  LIMIT 20
) t;
""",
        "restart": f"""
SELECT json_build_object(
  'web', count(*) FILTER (WHERE session_id ~ '^web'),
  'h_human', count(*) FILTER (WHERE {_h_sql()}),
  'automation', count(*) FILTER (WHERE session_id !~ '^web')
)
FROM turn_dispatches
WHERE failure_code = 'SERVICE_RESTART' AND {terminal} AND {user};
""",
        "orphan": f"""
SELECT json_build_object(
  'friction_fence_hard_cap', (
    SELECT count(*) FROM product_friction_events
    WHERE stage = 'visible_fallback' AND reason = 'fence_hard_cap'
      AND {created} AND {user} AND (session_id IS NULL OR session_id ~ '^web')
  ),
  'fenced_interrupted_ge_6h', (
    SELECT count(*) FROM turn_dispatches
    WHERE outcome = 'interrupted' AND producer_fenced_at IS NOT NULL
      AND {terminal} AND {user} AND session_id ~ '^web'
      AND coalesce(terminal_at, resolved_at) - coalesce(accepted_at, admitted_at) >= interval '6 hours'
  ),
  'interrupted_ge_6h', (
    SELECT count(*) FROM turn_dispatches
    WHERE outcome = 'interrupted' AND {terminal} AND {user} AND session_id ~ '^web'
      AND coalesce(terminal_at, resolved_at) - coalesce(accepted_at, admitted_at) >= interval '6 hours'
  ),
  'producer_fenced_web', (
    SELECT count(*) FROM turn_dispatches
    WHERE producer_fenced_at IS NOT NULL AND {terminal} AND {user} AND session_id ~ '^web'
  )
);
""",
        "new_metrics": """
SELECT coalesce(json_agg(json_build_object('name', name, 'kind', kind, 'table_name', table_name)), '[]'::json)
FROM (
  SELECT column_name AS name, 'column' AS kind, table_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'container_link_active'
  UNION ALL
  SELECT table_name, 'table', table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'container_links'
) t;
""",
        "frame_gap": f"""
WITH s AS (
  SELECT stream_key, projection_source
  FROM client_session_live_streams
  WHERE source = 'gateway'
    AND created_at >= {since_sql}::timestamptz AND created_at < {until_sql}::timestamptz
    AND stream_key NOT LIKE 'legacy:%'
    AND {user_s}
    AND session_id ~ '^web'
)
SELECT json_build_object(
  'streams', count(*),
  'tape_marked', count(*) FILTER (WHERE projection_source = 'tape'),
  'no_frames', count(*) FILTER (WHERE g.n IS NULL OR g.n = 0),
  'tape_pruned_or_empty', count(*) FILTER (WHERE projection_source = 'tape' AND (g.n IS NULL OR g.n = 0)),
  'with_frames', count(*) FILTER (WHERE g.n > 0),
  'gap_a_gt200', count(*) FILTER (WHERE g.n > 0 AND g.mx - g.n > {GAP_THRESHOLD}),
  'gap_b_gt200', count(*) FILTER (WHERE g.n > 0 AND (g.mx - g.mn + 1) - g.n > {GAP_THRESHOLD})
)
FROM s
LEFT JOIN LATERAL (
  SELECT count(*)::bigint AS n, max(frame_seq) AS mx, min(frame_seq) AS mn
  FROM client_session_live_frames f
  WHERE f.stream_key = s.stream_key
) g ON true;
""",
        "oversize_journal": f"""
SELECT coalesce(json_agg(json_build_object('scope', scope, 'bucket', bucket, 'n', n) ORDER BY n DESC), '[]'::json)
FROM (
  SELECT scope, bucket, count(*) AS n
  FROM (
    SELECT
      CASE
        WHEN d.dispatch_id IS NULL THEN 'unlinked'
        WHEN d.session_id ~ '^web' THEN 'web'
        ELSE 'automation'
      END AS scope,
      {_oversize_case("coalesce(j.error_msg, '') || ' ' || coalesce(j.failure_code, '')")} AS bucket
    FROM request_finalize_journal j
    LEFT JOIN turn_dispatches d ON d.dispatch_id = j.dispatch_id
    WHERE j.created_at >= {since_sql}::timestamptz AND j.created_at < {until_sql}::timestamptz
      AND {user_j}
  ) x
  WHERE bucket IS NOT NULL
  GROUP BY scope, bucket
  ORDER BY n DESC
  LIMIT 30
) t;
""",
        "oversize_messages": f"""
SELECT coalesce(json_agg(json_build_object('bucket', bucket, 'n', n) ORDER BY n DESC), '[]'::json)
FROM (
  SELECT bucket, count(*) AS n
  FROM (
    SELECT {_oversize_case("tok[1]")} AS bucket
    FROM client_sessions s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN s.messages ~ '^\\s*\\[' THEN s.messages::jsonb ELSE '[]'::jsonb END
    ) elem
    CROSS JOIN LATERAL regexp_matches(elem::text, '{oversize_msg}', 'gi') AS m(tok)
    WHERE {user_cs} AND s.id ~ '^web'
      AND s.last_at >= {since_ms}
      AND (elem->>'ts') ~ '^[0-9]+$'
      AND (elem->>'ts')::bigint >= {since_ms}
      AND (elem->>'ts')::bigint < {until_ms}
  ) x
  WHERE bucket IS NOT NULL
  GROUP BY bucket
  ORDER BY n DESC
  LIMIT 10
) t;
""",
        "oversize_dispatch": f"""
SELECT coalesce(json_agg(json_build_object('failure_code', failure_code, 'n', n) ORDER BY n DESC), '[]'::json)
FROM (
  SELECT failure_code, count(*) AS n
  FROM turn_dispatches
  WHERE {window} AND {user} AND session_id ~ '^web'
    AND {_oversize_case("coalesce(failure_code, '')")} IS NOT NULL
  GROUP BY failure_code
  ORDER BY n DESC
  LIMIT 20
) t;
""",
        "recovery_jobs": f"""
SELECT coalesce(json_agg(json_build_object('error_code', error_code, 'n', n) ORDER BY n DESC), '[]'::json)
FROM (
  SELECT coalesce(error_code, '(none)') AS error_code, count(*) AS n
  FROM turn_recovery_jobs
  WHERE {created} AND {user} AND session_id ~ '^web'
  GROUP BY 1
  ORDER BY n DESC
  LIMIT 40
) t;
""",
        "dispatch_failures": f"""
SELECT coalesce(json_agg(json_build_object('failure_code', failure_code, 'n', n) ORDER BY n DESC), '[]'::json)
FROM (
  SELECT coalesce(failure_code, '(none)') AS failure_code, count(*) AS n
  FROM turn_dispatches
  WHERE {window} AND {user} AND {_h_sql()} AND outcome IS DISTINCT FROM 'completed'
  GROUP BY 1
  ORDER BY n DESC
  LIMIT 40
) t;
""",
        "box": f"""
SELECT coalesce(json_agg(json_build_object(
  'model', model, 'turns', turns, 'completed', completed, 'non_completed', non_completed,
  'non_terminal', non_terminal, 'not_accepted', not_accepted
) ORDER BY turns DESC), '[]'::json)
FROM (
  SELECT model,
         count(*) AS turns,
         count(*) FILTER (WHERE outcome = 'completed') AS completed,
         count(*) FILTER (WHERE outcome IS DISTINCT FROM 'completed') AS non_completed,
         count(*) FILTER (WHERE status IS DISTINCT FROM 'terminal') AS non_terminal,
         count(*) FILTER (WHERE outcome = 'not_accepted') AS not_accepted
  FROM turn_dispatches
  WHERE {window} AND {user} AND {_h_sql()} AND model ~ '^box-'
  GROUP BY model
  ORDER BY turns DESC
) t;
""",
        "box_failure_buckets": f"""
SELECT coalesce(json_agg(t ORDER BY n DESC, model, stage, status, outcome, failure_code), '[]'::json)
FROM (
  SELECT model,
         CASE WHEN model LIKE 'box-api-claude-%' THEN 'api_claude'
              WHEN model LIKE 'box-claude-%' THEN 'claude'
              ELSE 'other_box' END AS model_family,
         CASE WHEN outcome = 'not_accepted' THEN 'admission'
              WHEN status IS DISTINCT FROM 'terminal' THEN 'in_flight'
              ELSE 'execution' END AS stage,
         status, coalesce(outcome, '(none)') AS outcome,
         coalesce(failure_code, '(none)') AS failure_code, count(*) AS n
  FROM turn_dispatches
  WHERE {window} AND {user} AND {_h_sql()} AND model ~ '^box-'
    AND outcome IS DISTINCT FROM 'completed'
  GROUP BY 1, 2, 3, 4, 5, 6
) t;
""",
        "box_continuation_decisions": f"""
SELECT coalesce(json_agg(json_build_object(
  'bucket_start', bucket_start, 'kind', kind,
  'stage', split_part(kind, ':', 1), 'decision', split_part(kind, ':', 2),
  'reason', split_part(kind, ':', 3), 'component', component,
  'control_plane_release', control_plane_release, 'control_plane_commit', control_plane_commit,
  'n', n
) ORDER BY bucket_start, kind, component, control_plane_release, control_plane_commit), '[]'::json)
FROM (
  SELECT bucket_start, labels->>'kind' AS kind, component,
         control_plane_release, control_plane_commit, sum(sample_count) AS n
  FROM telemetry_metric_rollups
  WHERE metric = 'box_continuation_decisions'
    AND bucket_start < {until_sql}::timestamptz
    AND bucket_start + interval '5 minutes' > {since_sql}::timestamptz
  GROUP BY bucket_start, labels->>'kind', component, control_plane_release, control_plane_commit
) t;
""",
        "continuation": f"""
SELECT coalesce(json_agg(json_build_object('scope', scope, 'code', code, 'n', n) ORDER BY n DESC), '[]'::json)
FROM (
  SELECT scope, code, count(*) AS n
  FROM (
    SELECT
      CASE
        WHEN d.dispatch_id IS NULL THEN 'unlinked'
        WHEN d.session_id ~ '^web' THEN 'web'
        ELSE 'automation'
      END AS scope,
      {_continuation_case("coalesce(j.error_msg, '') || ' ' || coalesce(j.failure_code, '')")} AS code
    FROM request_finalize_journal j
    LEFT JOIN turn_dispatches d ON d.dispatch_id = j.dispatch_id
    WHERE j.created_at >= {since_sql}::timestamptz AND j.created_at < {until_sql}::timestamptz
      AND {user_j}
  ) x
  WHERE code IS NOT NULL
  GROUP BY scope, code
  ORDER BY n DESC
  LIMIT 30
) t;
""",
        "drain_turns": f"""
SELECT coalesce(json_agg(item), '[]'::json)
FROM (
  SELECT json_build_object(
    'u', d.user_id,
    't', d.trace_id,
    'tt', coalesce(json_agg(t.trace_id) FILTER (WHERE t.trace_id IS NOT NULL), '[]'::json),
    'a', extract(epoch FROM d.admitted_at),
    'e', extract(epoch FROM coalesce(d.terminal_at, d.resolved_at))
  ) AS item
  FROM turn_dispatches d
  LEFT JOIN turn_traces t ON t.dispatch_id = d.dispatch_id
  WHERE d.admitted_at >= {since_sql}::timestamptz AND d.admitted_at < {until_sql}::timestamptz
    AND {user_d} AND {_h_sql('d')}
  GROUP BY d.dispatch_id
) s;
""",
    }
    return queries


def _failed(result):
    return isinstance(result, dict) and result.get("error")


def _classes(cohort) -> dict:
    if _failed(cohort) or not isinstance(cohort, dict):
        return {}
    classes = cohort.get("classes") or {}
    return {key: int(value) for key, value in classes.items()}


def assemble(window: dict, uids: list[int] | None, sql_results: dict, log_stats: dict | None) -> dict:
    cohort_row = sql_results.get("cohort")
    classes = _classes(cohort_row)
    # GROUP BY omits a class whose count is zero. A successful cohort with no
    # S_recover key is 0 recoveries, not a missing sample.
    if isinstance(cohort_row, dict) and not _failed(cohort_row):
        h_turns = classes.get("H_human", 0)
        recover = classes.get("S_recover", 0)
    else:
        h_turns = None
        recover = None
    stop = sql_results.get("stop")
    if _failed(stop) or not isinstance(stop, dict):
        stop_section = stop if _failed(stop) else {"error": "missing"}
        ended_stop_section = stop_section
    else:
        stops = int(stop.get("stops") or 0)
        not_active = int(stop.get("turn_not_active") or 0)
        stop_section = {
            "stops": stops,
            "turn_not_active": not_active,
            "ratio": ratio(not_active, stops),
            "display": fmt_ratio(not_active, stops),
            "note": "历史 runtime miss，包含准入前未命中；不是已结束证据。",
        }
        already_ended = int(stop.get("turn_already_ended") or 0)
        ended_stop_section = {
            "stops": stops,
            "turn_already_ended": already_ended,
            "ratio": ratio(already_ended, stops),
            "display": fmt_ratio(already_ended, stops),
            "note": "仅 Master 的 PG exact dispatch 终态证据确认；与历史 runtime miss 分开计数。",
        }
    paint = sql_results.get("paint")
    gap = sql_results.get("frame_gap")
    if isinstance(gap, dict) and not _failed(gap):
        with_frames = int(gap.get("with_frames") or 0)
        gap = {
            **gap,
            "gap_a_rate_of_frames_left": ratio(int(gap.get("gap_a_gt200") or 0), with_frames),
            "prune_note": PRUNE_NOTE,
        }
    orphan = sql_results.get("orphan")
    if isinstance(orphan, dict) and not _failed(orphan):
        orphan = {
            **orphan,
            "note": (
                "fence_hard_cap 不写 turn_dispatches.failure_code。"
                "friction 的 reason=fence_hard_cap 只在无 tape 的 projectFallback 路径写入。"
                "fenced_interrupted_ge_6h 是 producer_fenced 且时长≥6 小时的代理，动作名无法从终态列回放。"
                "日志行读 userId，缺该字段的不计入，并且只保留 ts 落在查询窗口内的行。"
            ),
        }
        if log_stats and "fence_hard_cap_lines_in_scope" in log_stats:
            orphan["log_fence_hard_cap_lines_in_scope"] = log_stats["fence_hard_cap_lines_in_scope"]
            orphan["log_fence_hard_cap_lines_other_uid"] = log_stats.get("fence_hard_cap_lines_other_uid")
    new_rows = sql_results.get("new_metrics")
    if new_rows is None:
        new_metrics = None
    elif _failed(new_rows):
        new_metrics = new_rows
    else:
        new_metrics = []
        found = {}
        for row in new_rows or []:
            found[(row.get("name"), row.get("kind"))] = row
        for name, kind in NEW_METRIC_PROBES:
            row = found.get((name, kind))
            if row is None:
                new_metrics.append({"name": name, "kind": kind, "status": new_metric_status(False, None)})
            else:
                new_metrics.append({
                    "name": name,
                    "kind": kind,
                    "table_name": row.get("table_name"),
                    "status": new_metric_status(True, row.get("value")),
                    "exists": True,
                })
    box_rows = sql_results.get("box")
    box = box_rows if box_rows is None or _failed(box_rows) else box_summary(box_rows)
    journal = sql_results.get("oversize_journal")
    messages = sql_results.get("oversize_messages")
    dispatch_over = sql_results.get("oversize_dispatch")
    continuation = sql_results.get("continuation")
    return {
        "window": window,
        "cohort": {
            "uids": uids if uids is not None else "all_except_765",
            "excluded_acceptance_uid": None if uids is not None else ACCEPTANCE_UID,
            "note": COHORT_NOTE,
            "classes": classes if not _failed(sql_results.get("cohort")) else sql_results.get("cohort"),
            "h_users": None if _failed(sql_results.get("cohort")) else (sql_results.get("cohort") or {}).get("h_users"),
        },
        "log_retention": {
            "note": LOG_RETENTION_NOTE,
            "log_first": None if not log_stats else log_stats.get("log_first"),
            "log_last": None if not log_stats else log_stats.get("log_last"),
            "log_files": None if not log_stats else log_stats.get("log_files"),
        },
        "w1": {
            "stop_turn_already_ended": ended_stop_section,
            "stop_turn_not_active": stop_section,
            "first_text_paint_after_background": paint,
            "blank_viewport": sql_results.get("blank"),
            "disconnect_over_drain": None if log_stats is None else {
                "drain_seconds": log_stats.get("drain_seconds", DRAIN_SECONDS),
                "h_turns_in_log_window": log_stats.get("h_turns_in_log_window"),
                "drain_exceeded_turns": log_stats.get("drain_exceeded_turns"),
                "before_log_retention": log_stats.get("before_log_retention"),
                "after_log_snapshot": log_stats.get("after_log_snapshot"),
                "still_open": log_stats.get("still_open"),
                "no_origin_conn": log_stats.get("no_origin_conn"),
                "origin_close_not_logged": log_stats.get("origin_close_not_logged"),
                "origin_closed_before_terminal": log_stats.get("origin_closed_before_terminal"),
                "note": (
                    "分母是 admitted 落在日志时间范围内的人发回合。"
                    "浏览器在 enter drain 时断开；没有 enter drain 的连接用 closed 时间。"
                    "关闭记录没有 session_id，同一 uid 的其它连接会算作覆盖。"
                    "找不到发起连接的回合记入 no_origin_conn，不算断线超过 drain。"
                ),
            },
            "frame_gap_dispatch": gap,
            "service_restart": sql_results.get("restart"),
            "orphan_6h": orphan,
            "new_metrics": new_metrics,
        },
        "w2": {
            "note": (
                "三个来源分开计数，不相加。同一事件可能同时出现在 journal 和会话消息里。"
                "会话消息只数 web 会话里 ts 落在窗口内的 JSON 元素，按出现次数，不去重成回合。"
                "dispatch 的 failure_code 目前是粗码，对得上超限桶才会计入。"
            ),
            "journal_web_and_unlinked": journal,
            "session_message_occurrences": messages,
            "dispatch_failure_code": dispatch_over,
        },
        "w3": {
            "h_human": h_turns,
            "s_recover": recover,
            "recovery_ratio": ratio(recover, h_turns) if h_turns is not None else None,
            "recovery_display": fmt_ratio(recover, h_turns) if h_turns is not None else "无样本",
            "recovery_job_error_codes": sql_results.get("recovery_jobs"),
            "h_non_completed_failure_codes": sql_results.get("dispatch_failures"),
            "note": (
                "恢复比的分子是 m-recover- 回合，分母是 H。"
                "turn_recovery_jobs.error_code 是另一张表，和 m-recover 回合不是一一对应。"
                "人发回合的 failure_code 含 USER_CANCELLED，不是纯引擎错误。"
            ),
        },
        "w5": {
            "box_models": box,
            "box_failure_buckets": sql_results.get("box_failure_buckets"),
            "box_failure_buckets_note": BOX_FAILURE_BUCKETS_NOTE,
            "box_continuation_decisions": sql_results.get("box_continuation_decisions"),
            "box_continuation_decisions_note": BOX_CONTINUATION_DECISIONS_NOTE,
            "continuation_rejects": continuation,
            "note": (
                "非 completed 率的分母是该模型的人发回合。non_terminal 单列尚非 terminal 的回合。"
                "续接拒绝旧来源只计 scope=web 的 journal 行，不覆盖准入前拒绝。"
            ),
        },
    }


def _md_query(value, render) -> str:
    if value is None:
        return "未跑"
    if _failed(value):
        return "查询失败：" + str(value.get("error"))
    return render(value)


def render_markdown(report: dict) -> str:
    window = report.get("window") or {}
    cohort = report.get("cohort") or {}
    lines = [
        "# 个人版重构指标",
        "",
        f"- 窗口：{window.get('since')} ≤ t < {window.get('until')}（timestamptz）",
        f"- 人群：{json.dumps(cohort.get('uids'), ensure_ascii=False)}。{cohort.get('note')}",
        f"- {LOG_RETENTION_NOTE}",
        "",
    ]
    classes = cohort.get("classes")
    if _failed(classes):
        lines.append("回合分类：查询失败：" + str(classes.get("error")))
    elif isinstance(classes, dict):
        parts = [f"{key}={value}" for key, value in sorted(classes.items())]
        lines.append("回合分类（admitted 落入窗口）：" + (", ".join(parts) if parts else "无"))
        lines.append(f"人发回合涉及用户数：{cohort.get('h_users')}")
    lines.append("")
    w1 = report.get("w1") or {}
    lines.append("## W1")
    lines.append("")
    stop = w1.get("stop_turn_already_ended")
    lines.append("### 停止请求命中已结束回合（TURN_ALREADY_ENDED）")
    lines.append("")
    if _failed(stop):
        lines.append("查询失败：" + str(stop.get("error")))
    elif isinstance(stop, dict):
        lines.append(
            f"比率 {stop.get('display')}。停止请求 {stop.get('stops')}，其中 TURN_ALREADY_ENDED {stop.get('turn_already_ended')}。"
            f"{stop.get('note')}"
        )
    lines.append("")
    stop = w1.get("stop_turn_not_active")
    lines.append("### 停止请求历史 runtime miss（TURN_NOT_ACTIVE）")
    lines.append("")
    if _failed(stop):
        lines.append("查询失败：" + str(stop.get("error")))
    elif isinstance(stop, dict):
        lines.append(
            f"比率 {stop.get('display')}。停止请求 {stop.get('stops')}，其中 TURN_NOT_ACTIVE {stop.get('turn_not_active')}。"
            f"{stop.get('note')}"
        )
    lines.append("")
    lines.append("### 切后台回来后首绘（FIRST_TEXT_PAINT_AFTER_BACKGROUND）")
    lines.append("")
    paint = w1.get("first_text_paint_after_background")

    def _paint(row):
        return (
            f"n={row.get('n')}（有 latency 的 {row.get('n_with_latency')}）。"
            f"p50={fmt_ms(row.get('p50_ms'))} ms，p95={fmt_ms(row.get('p95_ms'))} ms，max={fmt_ms(row.get('max_ms'))} ms。"
        )

    lines.append(_md_query(paint, _paint))
    lines.append("")
    lines.append("### 空白视口")
    lines.append("")
    blank = w1.get("blank_viewport")
    if blank is None:
        lines.append("未跑")
    elif _failed(blank):
        lines.append("查询失败：" + str(blank.get("error")))
    elif not blank:
        lines.append("0")
    else:
        for row in blank:
            lines.append(f"- {row.get('code')}：{row.get('events')} 次，{row.get('sessions')} 个会话")
    lines.append("")
    lines.append("### 回合期间断线超过 drain（60s）")
    lines.append("")
    drain = w1.get("disconnect_over_drain")
    if drain is None:
        lines.append("未跑日志。")
    elif _failed(drain):
        lines.append("查询失败：" + str(drain.get("error")))
    else:
        lines.append(
            f"日志窗口内人发回合 {drain.get('h_turns_in_log_window')}，"
            f"断线超过 drain {drain.get('drain_exceeded_turns')}。"
            f"早于日志起点未覆盖 {drain.get('before_log_retention')}，"
            f"仍未终态 {drain.get('still_open')}，"
            f"日志里没有发起连接 {drain.get('no_origin_conn')}，"
            f"发起连接的关闭没有记下 {drain.get('origin_close_not_logged')}。"
        )
        lines.append(drain.get("note") or "")
    lines.append("")
    lines.append("### 个人口径帧缺口（只算 dispatch 流）")
    lines.append("")
    gap = w1.get("frame_gap_dispatch")
    if _failed(gap):
        lines.append("查询失败：" + str(gap.get("error")))
    elif isinstance(gap, dict):
        lines.append(
            f"dispatch 流 {gap.get('streams')}，其中 tape 标记 {gap.get('tape_marked')}，"
            f"无帧 {gap.get('no_frames')}（tape 且无帧 {gap.get('tape_pruned_or_empty')}），"
            f"仍有帧 {gap.get('with_frames')}。"
            f"有帧流里缺口 A>200 为 {gap.get('gap_a_gt200')}，缺口 B>200 为 {gap.get('gap_b_gt200')}。"
        )
        lines.append(PRUNE_NOTE)
    lines.append("")
    lines.append("### SERVICE_RESTART 打断的回合")
    lines.append("")
    restart = w1.get("service_restart")

    def _restart(row):
        return (
            f"web 会话 {row.get('web')}（其中人发 {row.get('h_human')}）。"
            f"自动化会话另计 {row.get('automation')}，不进上面的 web 数。"
            "按终态时间落入窗口，不按 admitted。"
        )

    lines.append(_md_query(restart, _restart))
    lines.append("")
    lines.append("### 6 小时 orphan 误判")
    lines.append("")
    orphan = w1.get("orphan_6h")

    def _orphan(row):
        return (
            f"friction reason=fence_hard_cap：{row.get('friction_fence_hard_cap')}。"
            f"producer_fenced 且 interrupted 且时长≥6h：{row.get('fenced_interrupted_ge_6h')}。"
            f"web 上任意 interrupted 且时长≥6h：{row.get('interrupted_ge_6h')}。"
            f"web 上 producer_fenced（不限时长）：{row.get('producer_fenced_web')}。"
            f"日志 fence_hard_cap 行（范围内 uid）：{row.get('log_fence_hard_cap_lines_in_scope')}。"
            f"{row.get('note')}"
        )

    lines.append(_md_query(orphan, _orphan))
    lines.append("")
    lines.append("### 新指标")
    lines.append("")
    new_metrics = w1.get("new_metrics")
    if new_metrics is None:
        lines.append("未跑")
    elif _failed(new_metrics):
        lines.append("查询失败：" + str(new_metrics.get("error")))
    else:
        for row in new_metrics or []:
            lines.append(f"- {row.get('name')}（{row.get('kind')}）：{row.get('status')}")
    lines.append("")
    lines.append("## W2 超限硬失败")
    lines.append("")
    w2 = report.get("w2") or {}
    lines.append(w2.get("note") or "")
    lines.append("")
    lines.append("journal（scope=web 才进头条；unlinked 是连不上 dispatch 的行；automation 已排除在头条外）：")
    lines.append("")
    journal = w2.get("journal_web_and_unlinked")
    if journal is None:
        lines.append("未跑")
    elif _failed(journal):
        lines.append("查询失败：" + str(journal.get("error")))
    elif not journal:
        lines.append("0")
    else:
        for row in journal:
            lines.append(f"- {row.get('scope')} / {row.get('bucket')}：{row.get('n')}")
    lines.append("")
    lines.append("会话消息里的出现次数（web，一次匹配计一次，不是去重回合）：")
    lines.append("")
    messages = w2.get("session_message_occurrences")
    if messages is None:
        lines.append("未跑")
    elif _failed(messages):
        lines.append("查询失败：" + str(messages.get("error")))
    elif not messages:
        lines.append("0")
    else:
        for row in messages:
            lines.append(f"- {row.get('bucket')}：{row.get('n')}")
    lines.append("")
    lines.append("turn_dispatches.failure_code 直接命中超限桶：")
    lines.append("")
    dispatch_over = w2.get("dispatch_failure_code")
    if dispatch_over is None:
        lines.append("未跑")
    elif _failed(dispatch_over):
        lines.append("查询失败：" + str(dispatch_over.get("error")))
    elif not dispatch_over:
        lines.append("0")
    else:
        for row in dispatch_over:
            lines.append(f"- {row.get('failure_code')}：{row.get('n')}")
    lines.append("")
    lines.append("## W3 自动恢复与引擎错误")
    lines.append("")
    w3 = report.get("w3") or {}
    lines.append(
        f"人发回合 H={w3.get('h_human')}，自动恢复回合 S_recover={w3.get('s_recover')}，"
        f"比例 {w3.get('recovery_display')}。"
    )
    lines.append(w3.get("note") or "")
    lines.append("")
    lines.append("turn_recovery_jobs.error_code（web）：")
    lines.append("")
    jobs = w3.get("recovery_job_error_codes")
    if jobs is None:
        lines.append("未跑")
    elif _failed(jobs):
        lines.append("查询失败：" + str(jobs.get("error")))
    elif not jobs:
        lines.append("0")
    else:
        for row in jobs:
            lines.append(f"- {row.get('error_code')}：{row.get('n')}")
    lines.append("")
    lines.append("人发回合非 completed 的 failure_code：")
    lines.append("")
    fails = w3.get("h_non_completed_failure_codes")
    if fails is None:
        lines.append("未跑")
    elif _failed(fails):
        lines.append("查询失败：" + str(fails.get("error")))
    elif not fails:
        lines.append("0")
    else:
        for row in fails:
            lines.append(f"- {row.get('failure_code')}：{row.get('n')}")
    lines.append("")
    lines.append("## W5 Box")
    lines.append("")
    w5 = report.get("w5") or {}
    lines.append(w5.get("note") or "")
    lines.append("")
    box = w5.get("box_models")
    if box is None:
        lines.append("未跑")
    elif _failed(box):
        lines.append("查询失败：" + str(box.get("error")))
    elif not box:
        lines.append("Box 人发回合：0（无样本，不能据此判断非 completed 率达标）")
    else:
        lines.append("| 模型 | 回合 | completed | 非 completed | 非 completed 率 | non_terminal | not_accepted |")
        lines.append("|---|---:|---:|---:|---:|---:|---:|")
        for row in box:
            completed = row.get("completed")
            non_terminal = row.get("non_terminal")
            lines.append(
                f"| {row.get('model')} | {row.get('turns')} | {completed if completed is not None else '未采集'} | "
                f"{row.get('non_completed')} | {fmt_ratio(row.get('non_completed'), row.get('turns'))} | "
                f"{non_terminal if non_terminal is not None else '未采集'} | {row.get('not_accepted')} |"
            )
    lines.append("")
    lines.append("非 completed 回合分桶：")
    lines.append("")
    lines.append(w5.get("box_failure_buckets_note") or "")
    lines.append("")
    buckets = w5.get("box_failure_buckets")
    if buckets is None:
        lines.append("未跑")
    elif _failed(buckets):
        lines.append("查询失败：" + str(buckets.get("error")))
    elif not buckets:
        lines.append("无非 completed 回合分桶（需结合上方回合样本数判断）")
    else:
        lines.append("| 模型 | model_family | 派生 stage | status | outcome | failure_code | 回合 |")
        lines.append("|---|---|---|---|---|---|---:|")
        for row in buckets:
            lines.append(
                f"| {row.get('model')} | {row.get('model_family')} | {row.get('stage')} | {row.get('status')} | "
                f"{row.get('outcome')} | {row.get('failure_code')} | {row.get('n')} |"
            )
    lines.append("")
    lines.append("续接校验事件（durable rollup）：")
    lines.append("")
    lines.append(w5.get("box_continuation_decisions_note") or "")
    lines.append("")
    decisions = w5.get("box_continuation_decisions")
    if decisions is None:
        lines.append("未跑")
    elif _failed(decisions):
        lines.append("查询失败：" + str(decisions.get("error")))
    elif not decisions:
        lines.append("未采集／窗口无持久化样本，不能判定拒绝为零")
    else:
        lines.append("| 五分钟桶起点 | component | release | commit | stage | decision | reason | 事件 |")
        lines.append("|---|---|---|---|---|---|---|---:|")
        for row in decisions:
            lines.append(
                f"| {row.get('bucket_start')} | {row.get('component')} | {row.get('control_plane_release')} | "
                f"{row.get('control_plane_commit')} | {row.get('stage')} | {row.get('decision')} | "
                f"{row.get('reason')} | {row.get('n')} |"
            )
    lines.append("")
    lines.append("续接拒绝（journal）：")
    lines.append("")
    cont = w5.get("continuation_rejects")
    if cont is None:
        lines.append("未跑")
    elif _failed(cont):
        lines.append("查询失败：" + str(cont.get("error")))
    elif not cont:
        lines.append("0")
    else:
        for row in cont:
            lines.append(f"- {row.get('scope')} / {row.get('code')}：{row.get('n')}")
    lines.append("")
    return "\n".join(lines)


def enrich_new_metrics(rows):
    """If a probed field exists, count it. Identifiers are whitelisted."""
    if _failed(rows) or not isinstance(rows, list):
        return rows
    allowed = {name for name, _kind in NEW_METRIC_PROBES}
    enriched = []
    for row in rows:
        name = row.get("name")
        kind = row.get("kind")
        table = row.get("table_name") or ""
        if name not in allowed or not re.fullmatch(r"[a-z_][a-z0-9_]*", table):
            enriched.append({**row, "value": {"error": "unexpected identifier"}})
            continue
        if kind == "table":
            value = run_sql(f"SELECT json_build_object('rows', count(*)) FROM {table};")
        elif kind == "column" and name == "container_link_active":
            value = run_sql(
                "SELECT json_build_object('rows', count(*), 'active', "
                f"count(*) FILTER (WHERE {name} IS TRUE)) FROM {table};"
            )
        else:
            value = {"error": "no counter for this probe"}
        enriched.append({**row, "value": value})
    return enriched


def run_sql(body: str) -> object:
    wrapped = (
        "BEGIN READ ONLY;\n"
        "SET LOCAL TIME ZONE 'Asia/Shanghai';\n"
        f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT_MS}';\n"
        + body.strip()
        + "\nROLLBACK;\n"
    )
    try:
        completed = subprocess.run(
            [
                "sudo", "-n", "-u", "postgres", "env",
                f"PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout={STATEMENT_TIMEOUT_MS}",
                "PGCLIENTENCODING=UTF8",
                "psql", "-d", PERSONAL_DB, "-X", "-qtA", "-v", "ON_ERROR_STOP=1",
            ],
            input=wrapped,
            capture_output=True,
            text=True,
            timeout=40,
        )
    except subprocess.TimeoutExpired:
        return {"error": "psql timeout"}
    if completed.returncode != 0:
        err = redact((completed.stderr or completed.stdout or "").strip())
        return {"error": err[:300]}
    text = (completed.stdout or "").strip()
    if not text:
        return {"error": "empty psql output"}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"error": "psql output was not json: " + redact(text)[:200]}


def log_paths(log_dir: Path) -> list[Path]:
    found = []
    for path in sorted(log_dir.glob("openclaude-v5-selfhost.log*")):
        if _LOG_NAME_RE.fullmatch(path.name):
            found.append(path)
    return found


def epoch_to_iso(stamp: float | None) -> str | None:
    if stamp is None:
        return None
    return dt.datetime.fromtimestamp(stamp, dt.timezone.utc).isoformat()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only personal-edition refactor metrics")
    parser.add_argument("--since", required=True, help="inclusive ISO-8601 timestamp with timezone")
    parser.add_argument("--until", required=True, help="exclusive ISO-8601 timestamp with timezone")
    parser.add_argument("--uid", action="append", default=None, help="repeatable; default is every user except 765")
    parser.add_argument("--json-out", required=True)
    parser.add_argument("--md-out", required=True)
    parser.add_argument("--log-dir", default="/var/log")
    parser.add_argument("--skip-logs", action="store_true", help="skip the 15-day master log scan")
    args = parser.parse_args(argv)
    uids = parse_uids(args.uid)
    since_sql = sql_ts(args.since)
    until_sql = sql_ts(args.until)
    if args.since >= args.until and args.since.endswith("Z") and args.until.endswith("Z"):
        raise SystemExit("since must be earlier than until")
    # Lexical compare is not valid across offsets. Compare as instants.
    since_epoch = _parse_epoch(args.since)
    until_epoch = _parse_epoch(args.until)
    if since_epoch is None or until_epoch is None or since_epoch >= until_epoch:
        raise SystemExit("since must be earlier than until")
    queries = build_queries(args.since, args.until, uids)
    # touch the validated literals so a bad timestamp cannot reach SQL
    del since_sql, until_sql
    sql_results = {}
    failures = []
    for name, body in queries.items():
        result = run_sql(body)
        sql_results[name] = result
        if _failed(result):
            failures.append(name)
    sql_results["new_metrics"] = enrich_new_metrics(sql_results.get("new_metrics"))
    if _failed(sql_results.get("new_metrics")) and "new_metrics" not in failures:
        failures.append("new_metrics")
    log_stats = None
    if not args.skip_logs and not _failed(sql_results.get("drain_turns")):
        turns = sql_results.get("drain_turns") or []
        try:
            log_stats = scan_master_logs(
                log_paths(Path(args.log_dir)),
                turns,
                since=since_epoch,
                until=until_epoch,
                cohort_uids=None if uids is None else uids,
            )
        except OSError as exc:
            log_stats = {"error": redact(str(exc))[:300]}
            failures.append("logs")
    elif args.skip_logs:
        log_stats = {"error": "skipped"}
    else:
        log_stats = {"error": "drain turn query failed"}
        failures.append("logs")
    if isinstance(log_stats, dict) and log_stats.get("log_first") is not None and not _failed(log_stats):
        log_stats = {
            **log_stats,
            "log_first": epoch_to_iso(log_stats.get("log_first")),
            "log_last": epoch_to_iso(log_stats.get("log_last")),
        }
    # drain_turns is an input to the log scan, not a published table
    published = {key: value for key, value in sql_results.items() if key != "drain_turns"}
    report = assemble(
        {"since": args.since, "until": args.until, "tz": "timestamptz"},
        uids,
        published,
        None if _failed(log_stats) else log_stats,
    )
    if _failed(log_stats):
        report["w1"]["disconnect_over_drain"] = log_stats
    report["queries_failed"] = failures
    report["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    json_path = Path(args.json_out)
    md_path = Path(args.md_out)
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path} {md_path} failures={','.join(failures) if failures else 'none'}")
    return 2 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
