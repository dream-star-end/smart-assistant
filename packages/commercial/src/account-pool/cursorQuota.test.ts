import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  asCursorSlotResults,
  coerceSlotFail,
  cursorModelFamily,
  cursorRowForSlot,
  nextCursorQuotaClass,
  parseCursorSlotResults,
  parseQuotaClassSidecar,
  planCursorQuotaUpdates,
  renderQuotaClassSidecar,
  uniqueCursorAccountIdFromSlotResults,
} from "./cursorQuota.js";

describe("cursorQuota", () => {
  test("splits Cursor Models vs Other Models", () => {
    assert.equal(cursorModelFamily("cursor-grok-4.6-high-fast"), "cursor_models");
    assert.equal(cursorModelFamily("composer-2.5"), "cursor_models");
    assert.equal(cursorModelFamily("claude-opus-5-thinking-high"), "other_models");
    assert.equal(cursorModelFamily("gpt-5.6-sol-high"), "other_models");
    assert.equal(cursorModelFamily(""), "cursor_models");
    assert.equal(cursorModelFamily("auto"), "cursor_models");
  });

  test("plans Other Models updates by 1-based full-pool slot", () => {
    const rows = [
      { id: 3n, cursor_quota_class: "unknown" as const },
      { id: 5n, cursor_quota_class: "unknown" as const },
    ];
    assert.deepEqual(
      planCursorQuotaUpdates(rows, [{ slot: 2, result: "ok" }], "other_models", null),
      [{ id: 5n, from: "unknown", to: "other_ok" }],
    );
    assert.deepEqual(
      planCursorQuotaUpdates(rows, [{ slot: 1, result: "fail" }], "other_models", "AUTH_UNAVAILABLE"),
      [{ id: 3n, from: "unknown", to: "cursor_only" }],
    );
    assert.deepEqual(
      planCursorQuotaUpdates(rows, [{ slot: 1, result: "fail_auth" }], "cursor_models", null),
      [],
    );
    assert.deepEqual(asCursorSlotResults([{ slot: 2, result: "ok" }, { slot: 0, result: "ok" }, "x"]), [
      { slot: 2, result: "ok" },
    ]);
  });

  test("maps a unique 1-based slot to the eligible account id and refuses to guess", () => {
    const rows = [{ id: 3n }, { id: 5n }, { id: 6n }];
    assert.equal(cursorRowForSlot(rows, 2)?.id, 5n);
    assert.equal(uniqueCursorAccountIdFromSlotResults(rows, [{ slot: 2, result: "ok" }]), 5n);
    assert.equal(uniqueCursorAccountIdFromSlotResults(rows, [{ slot: 1, result: "fail" }]), 3n);
    assert.equal(uniqueCursorAccountIdFromSlotResults(rows, [{ slot: 2, result: "ok" }, { slot: 2, result: "ok" }]), 5n);
    assert.equal(uniqueCursorAccountIdFromSlotResults(rows, []), null);
    assert.equal(uniqueCursorAccountIdFromSlotResults(rows, null), null);
    assert.equal(uniqueCursorAccountIdFromSlotResults(rows, [{ slot: 9, result: "ok" }]), null);
    assert.equal(
      uniqueCursorAccountIdFromSlotResults(rows, [{ slot: 1, result: "fail_auth" }, { slot: 3, result: "ok" }]),
      null,
    );
  });

  test("parses wrapper slot_result lines only", () => {
    const text = [
      "oc-cursor: using Cursor credential slot 1/4",
      "oc-cursor: slot_result 1 fail_auth",
      "API Error: unauthorized",
      "oc-cursor: slot_result 3 ok",
      "oc-cursor: slot_result 0 fail",
    ].join("\n");
    assert.deepEqual(parseCursorSlotResults(text), [
      { slot: 1, result: "fail_auth" },
      { slot: 3, result: "ok" },
    ]);
  });

  test("learns Other Models only", () => {
    assert.equal(nextCursorQuotaClass("unknown", "ok", "other_models"), "other_ok");
    assert.equal(nextCursorQuotaClass("unknown", "fail_auth", "other_models"), "cursor_only");
    assert.equal(nextCursorQuotaClass("unknown", "fail", "other_models"), "unknown");
    assert.equal(nextCursorQuotaClass("unknown", "fail_auth", "cursor_models"), "unknown");
    assert.equal(nextCursorQuotaClass("cursor_only", "ok", "other_models"), "other_ok");
  });

  test("bare fail inherits the turn terminal code", () => {
    assert.equal(coerceSlotFail("fail", "AUTH_UNAVAILABLE"), "fail_auth");
    assert.equal(coerceSlotFail("fail", "QUOTA_UNAVAILABLE"), "fail_quota");
    assert.equal(coerceSlotFail("fail", "ENGINE_ERROR"), "fail");
    assert.equal(coerceSlotFail("ok", "AUTH_UNAVAILABLE"), "ok");
  });

  test("sidecar round-trips without secrets", () => {
    const text = renderQuotaClassSidecar([
      { name: "api-key", quotaClass: "cursor_only" },
      { name: "api-key.2", quotaClass: "unknown" },
    ]);
    assert.match(text, /^# quota-class v1\n/);
    assert.doesNotMatch(text, /crsr_/);
    const map = parseQuotaClassSidecar(text);
    assert.equal(map.get("api-key"), "cursor_only");
    assert.equal(map.get("api-key.2"), "unknown");
  });
});
