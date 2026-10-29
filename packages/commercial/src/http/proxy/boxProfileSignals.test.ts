import test from "node:test";
import assert from "node:assert/strict";
import { readBoxProfileSignals } from "./boxProfileSignals.js";

// Captured from Claude Code 2.1.288 on the Box, 2026-10-06 19:34 (zero usage, rc=1).
const REJECTED = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791300000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":1791300000},"seven_day":{"utilization":0.4,"resetsAt":1791316800}}},"uuid":"b0c0e8e4","session_id":"3501cbf6"}';
const LIMIT_TEXT = '{"type":"assistant","message":{"id":"0babad70","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"You\'ve hit your session limit · resets 11:20pm (Asia/Taipei)"}]},"session_id":"3501cbf6"}';
const NOT_LOGGED_IN = '{"type":"assistant","message":{"id":"8446428a","model":"<synthetic>","role":"assistant","type":"message","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"session_id":"02fac775"}';
// The interactive runner's record of a login whose refresh failed (CLI 2.1.312 on the Box, 2026-10-29).
const LOGIN_EXPIRED = '{"type":"assistant","message":{"id":"msg_ocb_93377609c7c540c181dcf095_0","type":"message","role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"Login expired · Please run /login"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"parent_tool_use_id":null,"session_id":"8c925f7f","uuid":"c7c846e6","is_api_error_message":true}';
// The same failure under -p, as CLI 2.1.312's error table words and tags it.
const AUTH_FAILED = '{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]},"error":"authentication_failed","is_api_error_message":true}';
const ALLOWED = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791300000,"rateLimitType":"five_hour","utilization":0.81}}';

test("a real rejection reports the binding window's reset", () => {
  assert.deepEqual(readBoxProfileSignals(`${REJECTED}\n${LIMIT_TEXT}\n`),
    [{ kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: 1791300000000,
      windows: { fiveHour: { utilization: 1.04, resetsAtMs: 1791300000000 },
        sevenDay: { utilization: 0.4, resetsAtMs: 1791316800000 } } }]);
});
test("OCV5-424: the 5-hour and weekly windows are kept separately; other windows are ignored", () => {
  const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"seven_day":{"utilization":0.31},"seven_day_opus":{"utilization":0.9,"resetsAt":1791316800}}}}';
  const [signal] = readBoxProfileSignals(line);
  assert.deepEqual(signal, { kind: "rate_limit", status: "allowed", utilization: 0.9, resetsAtMs: 1791316800000,
    windows: { sevenDay: { utilization: 0.31, resetsAtMs: null } } });
});
test("a real logged-out run is a login signal", () => {
  assert.deepEqual(readBoxProfileSignals(NOT_LOGGED_IN), [{ kind: "login_required" }]);
});
test("a login whose refresh failed is a login signal under both runners", () => {
  assert.deepEqual(readBoxProfileSignals(`${LOGIN_EXPIRED}\n${AUTH_FAILED}\n`),
    [{ kind: "login_required" }, { kind: "login_required" }]);
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
