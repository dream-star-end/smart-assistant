import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BoxCliQuotaObserver } from "./boxCliQuotaEvidence.js";

const captured = readFileSync(new URL(
  "./__fixtures__/box-cli-upstream-refusal/real-session-limit.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const [rejected, refused] = captured;
const sessionId = rejected.session_id as string;
const other = "00000000-0000-4000-8000-000000000002";
function paired(info: Record<string, unknown>) {
  const observer = new BoxCliQuotaObserver(sessionId);
  assert.equal(observer.take({ ...rejected, rate_limit_info: info }), null);
  return observer.take(refused, true);
}

test("captured quota pairs only with an independently bound native session", () => {
  assert.deepEqual(paired(rejected.rate_limit_info), {
    quotaWindow: "five_hour", quotaResetAtMs: rejected.rate_limit_info.resetsAt * 1000 });
  const unbound = new BoxCliQuotaObserver();
  unbound.take(rejected);
  assert.equal(unbound.take(refused, true), null, "event cannot grant its own session binding");
  unbound.bindNativeSession(sessionId);
  unbound.take(rejected);
  assert.equal(unbound.take(refused, true)?.quotaWindow, "five_hour");
  assert.equal(unbound.take(refused, true), null, "evidence is consumed once");
});

test("short, unknown, allowed and overage-allowed signals are not subscription exhaustion", () => {
  for (const delta of [
    { rateLimitType: "requests_per_minute" }, { rateLimitType: "unknown" },
    { rateLimitType: "overage" }, { rateLimitType: undefined },
    { status: "allowed" }, { status: "allowed_warning" },
    { overageStatus: "allowed" }, { overageStatus: undefined }, { isUsingOverage: true },
    { isUsingOverage: "false" },
  ]) assert.equal(paired({ ...rejected.rate_limit_info, ...delta }), null);
  assert.deepEqual(paired({ ...rejected.rate_limit_info, rateLimitType: "seven_day" }), {
    quotaWindow: "seven_day", quotaResetAtMs: rejected.rate_limit_info.resetsAt * 1000 });
});

test("session mismatch, intervening records and a new round cannot borrow quota evidence", () => {
  for (const interposed of [
    { ...rejected, session_id: other }, { type: "system", session_id: sessionId },
    { ...rejected, rate_limit_info: { ...rejected.rate_limit_info, status: "allowed" } },
  ]) {
    const observer = new BoxCliQuotaObserver(sessionId);
    observer.take(rejected); observer.take(interposed);
    assert.equal(observer.take(refused, true), null);
  }
  const observer = new BoxCliQuotaObserver(sessionId);
  observer.take(rejected);
  assert.equal(observer.take({ ...refused, session_id: other }, true), null);
  observer.bindNativeSession(other); observer.take(rejected);
  assert.equal(observer.take(refused, true), null, "conflicting init invalidates binding");
  assert.equal(new BoxCliQuotaObserver(sessionId).take(refused, true), null);
});

test("reset is optional bounded metadata, never an exhaustion classifier", () => {
  for (const resetsAt of [undefined, NaN, Infinity, -1, 9e20]) {
    assert.deepEqual(paired({ ...rejected.rate_limit_info, resetsAt }), { quotaWindow: "five_hour" });
  }
  assert.equal(paired({ ...rejected.rate_limit_info, rateLimitType: "minute", resetsAt: 9e12 }), null);
  const observer = new BoxCliQuotaObserver(sessionId);
  observer.take(rejected);
  assert.equal(observer.take(refused, false), null, "telemetry alone cannot reject model output");
});
