import test from "node:test";
import assert from "node:assert/strict";
import { assertLongTaskTap } from "../check-v5-box-longtask.js";

const titles = [
  "260 paid-result boundaries span three bounded generations and finish idle",
  "resource boundaries apply to one generation and reserve a complete next message",
  "only a durable stopped generation reaches fresh launch; unknown and cancellation keep the claim",
  "an authenticated Stop durably cancels the rollover gap before looking for another run",
  "authenticated route","rejected identity","coalesced stop",
];
const complete = ["TAP version 13",...titles.map((title,i) => `ok ${i+1} - ${title}`),
  "1..7","# tests 7","# suites 0","# pass 7","# fail 0","# cancelled 0","# skipped 0","# todo 0"].join("\n");

test("long-task release proof accepts complete executed behavior with zero skip", () => {
  assert.deepEqual(assertLongTaskTap(complete),{ tests: 7,pass: 7,skipped: 0 });
});
test("long-task release proof rejects silent skip, missing behavior, truncation and false exit-zero TAP", () => {
  for (const invalid of [
    complete.replace("# skipped 0","# skipped 1"),
    complete.replace("# cancelled 0","# cancelled 1"),
    complete.replace("# todo 0","# todo 1"),
    complete.replace("# fail 0","# fail 1"),
    complete.replace("1..7","1..8"),
    complete.replace("1..7",""),
    complete.replace("ok 5 - authenticated route","ok 5 - authenticated route # SKIP unavailable DB"),
    complete.replace(titles[0]!,"unrelated passing test"),
    complete.replace("# tests 7","# tests 0"),
    complete + "\n# tests 7",
  ]) assert.throws(() => assertLongTaskTap(invalid));
});
