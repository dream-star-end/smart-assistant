import test from "node:test";
import assert from "node:assert/strict";
import { readBoxProfileSignals } from "./boxProfileSignals.js";

// Captured from Claude Code 2.1.288 on the Box, 2026-10-06 19:34 (zero usage, rc=1).
const REJECTED = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791300000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":1791300000},"seven_day":{"utilization":0.4,"resetsAt":1791316800}}},"uuid":"b0c0e8e4","session_id":"3501cbf6"}';
const LIMIT_TEXT = '{"type":"assistant","message":{"id":"0babad70","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"You\'ve hit your session limit · resets 11:20pm (Asia/Taipei)"}]},"session_id":"3501cbf6"}';
const NOT_LOGGED_IN = '{"type":"assistant","message":{"id":"8446428a","model":"<synthetic>","role":"assistant","type":"message","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"session_id":"02fac775"}';
const ALLOWED = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791300000,"rateLimitType":"five_hour","utilization":0.81}}';

test("a real rejection reports the binding window's reset", () => {
  assert.deepEqual(readBoxProfileSignals(`${REJECTED}\n${LIMIT_TEXT}\n`),
    [{ kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: 1791300000000 }]);
});
test("a real logged-out run is a login signal", () => {
  assert.deepEqual(readBoxProfileSignals(NOT_LOGGED_IN), [{ kind: "login_required" }]);
});
test("allowed events carry utilization", () => {
  assert.deepEqual(readBoxProfileSignals(ALLOWED),
    [{ kind: "rate_limit", status: "allowed_warning", utilization: 0.81, resetsAtMs: 1791300000000 }]);
});
test("ordinary model output, half lines and junk are ignored", () => {
  assert.deepEqual(readBoxProfileSignals('{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Not logged in"}]}}\n'), []);
  assert.deepEqual(readBoxProfileSignals(REJECTED.slice(0, 120)), []);
  assert.deepEqual(readBoxProfileSignals("rate_limit_event <synthetic> not json\n"), []);
  assert.deepEqual(readBoxProfileSignals(""), []);
});
