import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CURSOR_SLOT_WEIGHT_MAX,
  CURSOR_SLOT_WEIGHT_MIN,
  asCursorSlotResults,
  coerceSlotFail,
  computeCursorSlotWeight,
  renderSlotWeightSidecar,
  cursorModelFamily,
  cursorRowForSlot,
  nextCursorQuotaClass,
  parseCursorSlotResults,
  parseQuotaClassSidecar,
  planCursorQuotaUpdates,
  planStableCursorQuotaUpdate,
  renderQuotaClassSidecar,
  uniqueCursorAccountIdFromSlotResults,
} from "./cursorQuota.js";

describe("cursorQuota", () => {
  test("splits Cursor Models vs Other Models", () => {
    assert.equal(cursorModelFamily("cursor-grok-4.6-high-fast"), "cursor_models");
    assert.equal(cursorModelFamily("composer-2.5"), "cursor_models");
    assert.equal(cursorModelFamily("claude-opus-5-thinking-high"), "other_models");
    assert.equal(cursorModelFamily("claude-opus-4-8-thinking-high"), "other_models");
    assert.equal(cursorModelFamily("gpt-5.6-sol-high"), "other_models");
    assert.equal(cursorModelFamily(""), "cursor_models");
    assert.equal(cursorModelFamily("auto"), "cursor_models");
  });

  test("stable account identity never reinterprets an old slot after pool compaction", () => {
    const compacted = [
      { id: 2n, cursor_quota_class: "unknown" as const },
      { id: 3n, cursor_quota_class: "cursor_only" as const },
    ];
    assert.deepEqual(
      planStableCursorQuotaUpdate(
        compacted,
        2n,
        [{ slot: 2, result: "ok" }],
        "other_models",
        null,
      ),
      [{ id: 2n, from: "unknown", to: "other_ok" }],
    );
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
      [],
    );
    assert.deepEqual(
      planCursorQuotaUpdates(rows, [{ slot: 1, result: "fail_quota" }], "other_models", null),
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
    assert.equal(nextCursorQuotaClass("unknown", "fail_auth", "other_models"), "unknown");
    assert.equal(nextCursorQuotaClass("unknown", "fail_quota", "other_models"), "cursor_only");
    assert.equal(nextCursorQuotaClass("unknown", "fail", "other_models"), "unknown");
    assert.equal(nextCursorQuotaClass("unknown", "fail_auth", "cursor_models"), "unknown");
    assert.equal(nextCursorQuotaClass("cursor_only", "ok", "other_models"), "other_ok");
  });

  test("bare fail never inherits a turn-level terminal code", () => {
    assert.equal(coerceSlotFail("fail", "AUTH_UNAVAILABLE"), "fail");
    assert.equal(coerceSlotFail("fail", "QUOTA_UNAVAILABLE"), "fail");
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

import {
  parseSandModeSidecar,
  renderSandModeSidecar,
} from "./cursorQuota.js";

describe("sand mode sidecar", () => {
  test("renders and parses sidecar round-trip", () => {
    const rendered = renderSandModeSidecar([
      { name: "api-key", sandEnabled: true },
      { name: "api-key.2", sandEnabled: false },
    ]);
    assert.match(rendered, /^# sand-mode v1\n/);
    assert.match(rendered, /api-key 1/);
    assert.match(rendered, /api-key\.2 0/);

    const parsed = parseSandModeSidecar(rendered);
    assert.equal(parsed.get("api-key"), true);
    assert.equal(parsed.get("api-key.2"), false);
    assert.equal(parsed.get("api-key.3"), undefined);
  });
});

describe("slot weight (0262)", () => {
  const now = new Date("2026-09-05T00:00:00.000Z");
  const h = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

  test("never-observed usage is neutral; headroom scales linearly with a floor", () => {
    assert.equal(computeCursorSlotWeight({ sandUsagePct: null, sandNextResetAt: null, billingCycleEnd: null, sandAccessState: null }, now), 500);
    assert.equal(computeCursorSlotWeight({ sandUsagePct: 0, sandNextResetAt: null, billingCycleEnd: null, sandAccessState: null }, now), 1000);
    assert.equal(computeCursorSlotWeight({ sandUsagePct: 72, sandNextResetAt: null, billingCycleEnd: null, sandAccessState: null }, now), 280);
    assert.equal(computeCursorSlotWeight({ sandUsagePct: 100, sandNextResetAt: null, billingCycleEnd: null, sandAccessState: null }, now), 20);
    assert.equal(computeCursorSlotWeight({ sandUsagePct: 130, sandNextResetAt: null, billingCycleEnd: null, sandAccessState: null }, now), 20);
  });

  test("soon reset and soon plan expiry boost; expired plan and blocked access sink", () => {
    const base = { sandUsagePct: 50, sandAccessState: null };
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: h(200), billingCycleEnd: null }, now), 500);
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: h(48), billingCycleEnd: null }, now), 600);
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: h(6), billingCycleEnd: null }, now), 750);
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: null, billingCycleEnd: h(24 * 5) }, now), 600);
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: null, billingCycleEnd: h(24) }, now), 750);
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: h(6), billingCycleEnd: h(24) }, now), 1125);
    assert.equal(computeCursorSlotWeight({ ...base, sandNextResetAt: null, billingCycleEnd: h(-1) }, now), 100);
    assert.equal(
      computeCursorSlotWeight({ sandUsagePct: 0, sandNextResetAt: h(1), billingCycleEnd: h(1), sandAccessState: "SAND_ACCESS_STATE_BLOCKED" }, now),
      CURSOR_SLOT_WEIGHT_MIN,
    );
  });

  test("sidecar renders clamped integers and carries no secrets", () => {
    const text = renderSlotWeightSidecar([
      { name: "api-key", weight: 750 },
      { name: "api-key.2", weight: 0 },
      { name: "api-key.3", weight: 99_999 },
      { name: "api-key.4", weight: Number.NaN },
    ]);
    assert.equal(text, `# slot-weight v1\napi-key 750\napi-key.2 ${CURSOR_SLOT_WEIGHT_MIN}\napi-key.3 ${CURSOR_SLOT_WEIGHT_MAX}\napi-key.4 ${CURSOR_SLOT_WEIGHT_MIN}\n`);
  });
});
