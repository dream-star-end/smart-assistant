import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LEDGER_REASON_LABELS,
  LEDGER_REASONS,
  ledgerReasonLabel,
} from "../ledger.js";

describe("credit ledger protocol contract", () => {
  test("exports the exact 12 database reasons with a label for each", () => {
    assert.deepEqual(LEDGER_REASONS, [
      "topup",
      "chat",
      "agent_chat",
      "agent_subscription",
      "refund",
      "admin_adjust",
      "promotion",
      "minimax_media",
      "image_generation",
      "subscription",
      "subscription_expire",
      "pack",
    ]);
    assert.deepEqual(Object.keys(LEDGER_REASON_LABELS), [...LEDGER_REASONS]);
  });

  test("describes grants, expiry and spend with their real direction", () => {
    assert.equal(ledgerReasonLabel("chat"), "对话消耗");
    assert.equal(ledgerReasonLabel("subscription"), "套餐额度发放");
    assert.equal(ledgerReasonLabel("subscription_expire"), "周期额度清零");
    assert.equal(ledgerReasonLabel("pack"), "加量包到账");
    assert.notEqual(ledgerReasonLabel("subscription"), "订阅扣费");
  });

  test("keeps an unknown future reason observable", () => {
    assert.equal(ledgerReasonLabel("future_reason"), "future_reason");
  });
});
