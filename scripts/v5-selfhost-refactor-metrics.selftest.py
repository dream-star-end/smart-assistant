#!/usr/bin/env python3
"""Pure-function tests for the personal-edition metrics口径. No database."""

import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_PATH = Path(__file__).with_name("v5-selfhost-refactor-metrics.py")
_SPEC = importlib.util.spec_from_file_location("v5_selfhost_refactor_metrics", _PATH)
m = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(m)


class CohortTest(unittest.TestCase):
    def test_turn_class_matches_admin_report(self):
        self.assertEqual(m.turn_class("webabc", "m-1"), "H_human")
        self.assertEqual(m.turn_class("webabc", "m-recover-9"), "S_recover")
        self.assertEqual(m.turn_class("webabc", "dlgcb-1"), "S_delegate_cb")
        self.assertEqual(m.turn_class("webabc", "lsc-1"), "S_lease_cb")
        self.assertEqual(m.turn_class("webabc", "other"), "S_other")
        self.assertEqual(m.turn_class("g014-session", "m-1"), "A_automation")
        self.assertEqual(m.turn_class("ocv-probe", "m-1"), "A_automation")
        self.assertEqual(m.turn_class("", "m-1"), "A_automation")

    def test_default_uid_excludes_acceptance_account(self):
        self.assertIsNone(m.parse_uids(None))
        self.assertEqual(m.sql_user_predicate(None), "user_id <> 765")
        self.assertEqual(m.sql_text_user_predicate(None), "user_id <> 'c:765'")

    def test_explicit_uid_is_only_those_ids(self):
        self.assertEqual(m.parse_uids(["3", "765"]), [3, 765])
        self.assertEqual(m.sql_user_predicate([3]), "user_id IN (3)")
        self.assertEqual(m.sql_text_user_predicate([3, 22]), "user_id IN ('c:3','c:22')")

    def test_uid_and_timestamp_reject_injection(self):
        with self.assertRaises(ValueError):
            m.parse_uids(["3;DROP TABLE turn_dispatches"])
        with self.assertRaises(ValueError):
            m.sql_ts("2026-10-29; DROP TABLE users")
        with self.assertRaises(ValueError):
            m.sql_user_predicate(None, "user_id; select")


class StatTest(unittest.TestCase):
    def test_percentile_cont_matches_postgres_definition(self):
        sample = [155, 20, 122, 70, 31]
        self.assertEqual(m.percentile_cont(sample, 0.5), 70)
        self.assertAlmostEqual(m.percentile_cont(sample, 0.95), 148.4)
        self.assertEqual(m.percentile_cont([9], 0.95), 9)
        self.assertIsNone(m.percentile_cont([], 0.5))

    def test_gap_null_is_unobservable(self):
        self.assertIsNone(m.gap_a(None, 0))
        self.assertFalse(m.gap_over(None))
        self.assertEqual(m.gap_a(250, 40), 210)
        self.assertTrue(m.gap_over(201))
        self.assertFalse(m.gap_over(200))
        self.assertEqual(m.gap_b(300, 100, 150), 51)
        self.assertFalse(m.is_dispatch_stream("legacy:c:s"))
        self.assertTrue(m.is_dispatch_stream("dispatch:abc"))

    def test_oversize_buckets_and_order(self):
        self.assertEqual(m.classify_oversize("Request too large (max 20MB)."), "request_too_large")
        self.assertEqual(m.classify_oversize("PAYLOAD_TOO_LARGE"), "request_too_large")
        self.assertEqual(m.classify_oversize("本轮资料未能完整处理，文件和对话均已保留。"), "request_too_large")
        self.assertEqual(m.classify_oversize("ANTIGRAVITY_PROMPT_TOO_LARGE: 10 > 1"), "prompt_too_large")
        self.assertEqual(m.classify_oversize("Prompt is too long: hello"), "prompt_too_large")
        self.assertEqual(m.classify_oversize("the context window was exceeded"), "context_limit")
        self.assertEqual(
            m.classify_oversize("PROMPT_TOO_LONG and the context window was exceeded"),
            "prompt_too_large",
        )
        self.assertIsNone(m.classify_oversize("all good"))
        self.assertIsNone(m.classify_oversize(""))

    def test_continuation_code(self):
        self.assertEqual(m.continuation_code("BoxContinuationDecisionError: BOX_TOOL_OWNER_UNKNOWN"), "BOX_TOOL_OWNER_UNKNOWN")
        self.assertEqual(m.continuation_code("echo mismatch on tool_result"), "ECHO_MISMATCH")
        self.assertEqual(m.continuation_code("snapshot mismatch"), "SNAPSHOT_MISMATCH")
        self.assertIsNone(m.continuation_code("USER_CANCELLED"))

    def test_ratios(self):
        self.assertEqual(m.fmt_ratio(72, 411), "17.5% (72/411)")
        self.assertEqual(m.fmt_ratio(7, 31), "22.6% (7/31)")
        self.assertEqual(m.fmt_ratio(0, 0), "无样本")
        self.assertIsNone(m.ratio(1, 0))

    def test_box_summary_drops_non_box(self):
        rows = m.box_summary([
            {"model": "gpt-5", "turns": 10, "non_completed": 1, "not_accepted": 0},
            {"model": "box-claude-haiku", "turns": 16, "non_completed": 5, "not_accepted": 2},
            {"model": "box-api-claude-opus", "turns": 42, "non_completed": 8, "not_accepted": 8},
        ])
        self.assertEqual([row["model"] for row in rows], ["box-api-claude-opus", "box-claude-haiku"])
        self.assertAlmostEqual(rows[1]["non_completed_rate"], 5 / 16)

    def test_new_metric_absent_is_not_online(self):
        self.assertEqual(m.new_metric_status(False, None), "未上线")
        self.assertEqual(m.new_metric_status(True, 4), 4)


class DrainTest(unittest.TestCase):
    def test_uncovered_seconds_merges_overlaps(self):
        self.assertEqual(m.uncovered_seconds([(0, 10), (5, 15)], 0, 20), 5)
        self.assertEqual(m.uncovered_seconds([], 0, 10), 10)
        self.assertEqual(m.uncovered_seconds([(0, 100)], 10, 20), 0)

    def test_drain_exceeded_only_same_uid_and_known_origin(self):
        turns = [{"u": 3, "t": "tr1", "tt": [], "a": 1000, "e": 2000}]
        closes = [(3, "c1", 1000, 1100), (3, "c2", 1800, 2000), (9, "c9", 1100, 2000)]
        inbounds = [(3, "tr1", 1005, "c1")]
        stats = m.drain_stats(turns, closes, inbounds, 0, 5000)
        self.assertEqual(stats["h_turns_in_log_window"], 1)
        self.assertEqual(stats["drain_exceeded_turns"], 1)
        covered = [(3, "c1", 1000, 2000)]
        quiet = m.drain_stats(turns, covered, inbounds, 0, 5000)
        self.assertEqual(quiet["drain_exceeded_turns"], 0)
        self.assertEqual(quiet["origin_closed_before_terminal"], 0)
        old = m.drain_stats([{"u": 3, "t": "tr1", "tt": [], "a": -5, "e": 2000}], closes, inbounds, 0, 5000)
        self.assertEqual(old["before_log_retention"], 1)
        self.assertEqual(old["drain_exceeded_turns"], 0)
        missing = m.drain_stats([{"u": 3, "t": "nope", "tt": ["also-no"], "a": 1000, "e": 2000}], closes, inbounds, 0, 5000)
        self.assertEqual(missing["no_origin_conn"], 1)
        self.assertEqual(missing["drain_exceeded_turns"], 0)

    def test_scan_log_line_and_file(self):
        line = '2026-10-20T01:02:03Z {"ts":"2026-10-20T01:02:03Z","msg":"user-chat-bridge: inbound turn start","uid":"3","traceId":"tr1","connId":"c1"}\n'
        parsed = m.parse_log_json(line)
        self.assertEqual(parsed["traceId"], "tr1")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "openclaude-v5-selfhost.log"
            path.write_text(
                "\n".join([
                    '2026-10-20T00:00:00Z {"ts":"2026-10-20T00:00:00Z","msg":"user-chat-bridge: inbound turn start","uid":"3","traceId":"tr1","connId":"c1"}',
                    '2026-10-20T00:00:10Z {"ts":"2026-10-20T00:00:10Z","msg":"user-chat-bridge: closed","uid":"3","connId":"c1","durationMs":10000,"cause":"client_close"}',
                    '2026-10-20T00:02:00Z {"ts":"2026-10-20T00:02:00Z","msg":"dispatch transition by reconciler","uid":"3","action":"fence_hard_cap"}',
                    '2026-10-20T00:03:00Z {"ts":"2026-10-20T00:03:00Z","msg":"user-chat-bridge: closed","uid":"9","connId":"other","durationMs":1000,"cause":"client_close"}',
                ]) + "\n",
                encoding="utf-8",
            )
            turns = [{"u": 3, "t": "tr1", "tt": [], "a": 1_000, "e": 200_000}]
            # admitted at epoch 1000 is 1970, before this log, so it is outside retention
            stats = m.scan_master_logs([path], turns)
            self.assertEqual(stats["before_log_retention"], 1)
            self.assertEqual(stats["fence_hard_cap_lines_in_scope"], 1)
            self.assertGreater(stats["log_files"], 0)

    def test_json_log_without_prefix_sets_full_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / "openclaude-v5-selfhost.log"
            current.write_text(
                "\n".join([
                    '{"service":"openclaude-v3","writeCalls":1}',
                    '{"ts":"2026-10-20T00:00:00.000Z","msg":"user-chat-bridge: inbound turn start","uid":"3","traceId":"tr1","connId":"c1"}',
                    '{"ts":"2026-10-20T00:00:10.000Z","msg":"user-chat-bridge: closed","uid":"3","connId":"c1","durationMs":10000,"cause":"client_close"}',
                    '{"ts":"2026-10-20T00:05:00.000Z","msg":"dispatch transition by reconciler","uid":"3","action":"fence_hard_cap"}',
                ]) + "\n",
                encoding="utf-8",
            )
            older = Path(tmp) / "openclaude-v5-selfhost.log.14.gz"
            with gzip.open(older, "wt", encoding="utf-8") as handle:
                handle.write('{"ts":"2026-10-14T00:00:05.561Z","level":"info","msg":"boot"}\n')
            admitted = m._parse_epoch("2026-10-20T00:00:00.000Z")
            ended = m._parse_epoch("2026-10-20T00:05:00.000Z")
            turns = [{"u": 3, "t": "tr1", "tt": [], "a": admitted, "e": ended}]
            stats = m.scan_master_logs([current, older], turns)
            self.assertEqual(stats["log_first"], m._parse_epoch("2026-10-14T00:00:05.561Z"))
            self.assertEqual(stats["log_last"], m._parse_epoch("2026-10-20T00:05:00.000Z"))
            self.assertEqual(stats["h_turns_in_log_window"], 1)
            self.assertEqual(stats["before_log_retention"], 0)
            self.assertEqual(stats["drain_exceeded_turns"], 1)
            self.assertEqual(stats["fence_hard_cap_lines_in_scope"], 1)
            self.assertEqual(stats["log_files"], 2)


class QueryAndReportTest(unittest.TestCase):
    def test_sql_is_scoped_and_read_only_body(self):
        queries = m.build_queries("2026-10-01T00:00:00+08:00", "2026-10-15T00:00:00+08:00", None)
        joined = "\n".join(queries.values()).lower()
        self.assertNotIn("begin", joined)
        self.assertNotIn("commit", joined)
        self.assertNotIn("insert ", joined)
        self.assertNotIn("update ", joined)
        self.assertNotIn("delete ", joined)
        for body in queries.values():
            if body.strip().startswith("SELECT coalesce") and "container_link" in body:
                continue
            self.assertIn("765", body if "information_schema" not in body else "765")
        self.assertIn("user_id <> 765", queries["cohort"])
        self.assertIn("NOT LIKE 'legacy:%'", queries["frame_gap"])
        self.assertIn("user_id <> 'c:765'", queries["frame_gap"])
        self.assertIn("fence_hard_cap", queries["orphan"])
        self.assertIn("TURN_NOT_ACTIVE", queries["stop"])
        self.assertIn("FIRST_TEXT_PAINT_AFTER_BACKGROUND", queries["paint"])
        self.assertLess(queries["oversize_journal"].index("request_too_large"), queries["oversize_journal"].index("prompt_too_large"))
        self.assertLess(queries["oversize_journal"].index("prompt_too_large"), queries["oversize_journal"].index("context_limit"))
        explicit = m.build_queries("2026-10-01T00:00:00+08:00", "2026-10-15T00:00:00+08:00", [3])
        self.assertIn("user_id IN (3)", explicit["cohort"])
        self.assertNotIn("<> 765", explicit["cohort"])

    def test_report_renders_baseline_phrases(self):
        report = m.assemble(
            {"since": "2026-09-29T00:00:00+08:00", "until": "2026-10-29T00:00:00+08:00"},
            None,
            {
                "cohort": {"classes": {"H_human": 411, "S_recover": 72, "A_automation": 549}, "h_users": 1},
                "stop": {"stops": 31, "turn_not_active": 7},
                "paint": {"n": 5, "n_with_latency": 5, "p50_ms": 70, "p95_ms": 148.4, "max_ms": 155},
                "blank": [{"code": "TIMELINE_BLANK_VIEWPORT_GAP_UNKNOWN", "events": 88, "sessions": 35}],
                "restart": {"web": 14, "h_human": 10, "automation": 18},
                "orphan": {
                    "friction_fence_hard_cap": 0,
                    "fenced_interrupted_ge_6h": 0,
                    "interrupted_ge_6h": 0,
                    "producer_fenced_web": 0,
                    "note": "fence note",
                },
                "new_metrics": [],
                "frame_gap": {
                    "streams": 799, "tape_marked": 797, "no_frames": 749,
                    "tape_pruned_or_empty": 749, "with_frames": 50,
                    "gap_a_gt200": 1, "gap_b_gt200": 0,
                },
                "oversize_journal": [],
                "oversize_messages": [{"bucket": "context_limit", "n": 1}],
                "oversize_dispatch": [],
                "recovery_jobs": [{"error_code": "engine_error", "n": 62}],
                "dispatch_failures": [{"failure_code": "USER_CANCELLED", "n": 20}],
                "box": [
                    {"model": "box-claude-haiku", "turns": 16, "non_completed": 5, "not_accepted": 2},
                ],
                "continuation": [{"scope": "web", "code": "BOX_TOOL_OWNER_UNKNOWN", "n": 4}],
            },
            {
                "drain_seconds": 60,
                "h_turns_in_log_window": 166,
                "drain_exceeded_turns": 8,
                "before_log_retention": 20,
                "after_log_snapshot": 0,
                "still_open": 0,
                "no_origin_conn": 3,
                "origin_close_not_logged": 1,
                "origin_closed_before_terminal": 10,
                "fence_hard_cap_lines_in_scope": 0,
                "fence_hard_cap_lines_other_uid": 0,
                "log_first": "2026-10-14T00:00:00+00:00",
                "log_last": "2026-10-29T00:00:00+00:00",
                "log_files": 15,
            },
        )
        self.assertEqual(report["w3"]["recovery_display"], "17.5% (72/411)")
        self.assertEqual(report["w1"]["stop_turn_not_active"]["display"], "22.6% (7/31)")
        self.assertEqual(report["w1"]["new_metrics"][0]["status"], "未上线")
        self.assertIn("pruneProjectedLiveFrames", report["w1"]["frame_gap_dispatch"]["prune_note"])
        text = m.render_markdown(report)
        self.assertIn("未上线", text)
        self.assertIn("15 天", text)
        self.assertIn("pruneProjectedLiveFrames", text)
        self.assertIn("17.5% (72/411)", text)
        self.assertIn("22.6% (7/31)", text)
        self.assertNotIn("postgres://", text)
        self.assertIn("BOX_TOOL_OWNER_UNKNOWN", text)
        failed = m.assemble(
            {"since": "2026-10-01T00:00:00+08:00", "until": "2026-10-02T00:00:00+08:00"},
            None,
            {"cohort": {"error": "statement timeout"}, "frame_gap": {"error": "statement timeout"}},
            {"error": "psql timeout"},
        )
        failed_text = m.render_markdown(failed)
        self.assertIn("查询失败", failed_text)
        self.assertNotIn("17.5%", failed_text)

    def test_redact(self):
        self.assertIn("<redacted>", m.redact("fail postgres://user:secret@localhost/db tail"))
        self.assertNotIn("secret", m.redact("postgres://user:secret@localhost/db"))


if __name__ == "__main__":
    unittest.main()
