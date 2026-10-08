import test from "node:test";
import assert from "node:assert/strict";
import { classify, parseLog, summarize } from "../v5-smoke-flake-report.mjs";

test("classifies real failures, UI-settle false-failure candidates, env and step timeouts", () => {
  assert.equal(classify("Exact turn returned an error"), "real");
  assert.equal(classify("Turn finished with a failure card"), "real");
  assert.equal(classify("assistant 最终正文未包含附件秘密探针(附件未送达 Agent、未读取或回复不完整)"), "real");
  assert.equal(classify('Completed turn UI did not settle: model=deepseek-v4-flash, before=0, state={"rows":0}'), "ui_settle");
  assert.equal(classify("assistant 回复在 180s 内未完成(无失败卡亦无完整回复 = turn 挂起)"), "ui_settle");
  assert.equal(classify("找不到可用的 Chrome/Chromium。"), "env");
  assert.equal(classify("locator.click: Timeout 20000ms exceeded. Call log:"), "ui_step_timeout");
  assert.equal(classify("something new"), "other");
});

test("parses user-contract TAP and journey lines; prerequisite skips are not counted; slow warnings counted", () => {
  const log = [
    "TAP version 13", "1..3",
    "ok 1 - C1 cold UI login without auth hint", "# duration_ms 1 5610",
    "ok 2 - C2 collapsed model reaches outbound request", "# duration_ms 2 9372",
    "# warn slow_ui_settle model=deepseek-v4-flash settled_ms=31000 strict_ms=20000 state_at_strict={}",
    "not ok 3 - C3 one model per engine", "# duration_ms 3 47051", '# error Completed turn UI did not settle: model=x, before=0, state={}',
    "TAP version 13", "1..3",
    "not ok 1 - C1 cold UI login without auth hint", "# duration_ms 1 1", "# error 找不到可用的 Chrome/Chromium",
    "not ok 2 - C2 collapsed model reaches outbound request", "# duration_ms 2 0", "# error Prerequisite failed; not executed",
    "[e2e] e2e-journey: 旅程全过(登录/附件读取/目标创建清除/发送/送达)",
    "[e2e] e2e-journey: ✗ 步骤「J5 送达硬断言:失败卡零容忍+最终正文含附件探针」失败: assistant 回复在 180s 内未完成(无失败卡亦无完整回复 = turn 挂起)",
  ].join("\n");
  const s = summarize(parseLog(log));
  assert.equal(s.slowUiSettleWarnings, 1);
  assert.deepEqual(s.checks["user-contract:C3"], { runs: 1, pass: 0, fail: 1, classes: { ui_settle: 1 } });
  assert.deepEqual(s.checks["user-contract:C1"], { runs: 2, pass: 1, fail: 1, classes: { env: 1 } });
  assert.deepEqual(s.checks["user-contract:C2"], { runs: 1, pass: 1, fail: 0, classes: {} });
  assert.deepEqual(s.checks["journey:J1-J5"], { runs: 1, pass: 1, fail: 0, classes: {} });
  assert.deepEqual(s.checks["journey:J5"], { runs: 1, pass: 0, fail: 1, classes: { ui_settle: 1 } });
});

test("post-grace UI failures are real (ui_after_backend), and every J5 grace start is counted", () => {
  assert.equal(classify("Completed turn UI did not settle within 60000ms after backend completion: model=x"), "ui_after_backend");
  assert.equal(classify("后端已有含探针的回复,但 UI 在宽限 60s 内仍未收尾(回复未在界面完成 = 真失败)"), "ui_after_backend");
  const s = summarize(parseLog([
    "[e2e] e2e-journey: J5 到 180s 未判定;后端已有含探针的 assistant 回复(assistant tape records with probe: 1),UI 判据不变,再等至多 60s",
    "[e2e] e2e-journey: ✗ 步骤「J5 送达硬断言」失败: 后端已有含探针的回复,但 UI 在宽限 60s 内仍未收尾(回复未在界面完成 = 真失败)",
    "[e2e] e2e-journey: J5 到 180s 未判定;后端已有含探针的 assistant 回复(n=1),UI 判据不变,再等至多 60s",
    "[e2e] e2e-journey: warn slow_ui_settle J5 ui_settled_ms_after_backend=3000 turn_wait_ms=180000",
    "[e2e] e2e-journey: 旅程全过(登录/附件读取/目标创建清除/发送/送达)",
  ].join("\n")));
  assert.equal(s.j5GraceStarted, 2);
  assert.equal(s.slowUiSettleWarnings, 1);
  assert.deepEqual(s.checks["journey:J5"], { runs: 1, pass: 0, fail: 1, classes: { ui_after_backend: 1 } });
});
