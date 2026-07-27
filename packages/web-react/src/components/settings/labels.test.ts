import { describe, expect, test } from "vitest";

import {
  LEDGER_REASON_LABELS,
  ledgerReasonLabel,
} from "./labels";

describe("ledger reason labels", () => {
  test("covers the 12 real ledger reasons and no legacy aliases", () => {
    expect(Object.keys(LEDGER_REASON_LABELS)).toHaveLength(12);
    expect(LEDGER_REASON_LABELS).not.toHaveProperty("seed_grant");
    expect(LEDGER_REASON_LABELS).not.toHaveProperty("charge");
    expect(LEDGER_REASON_LABELS).not.toHaveProperty("usage");
  });

  test("uses real grant, expiry and spend semantics", () => {
    expect(ledgerReasonLabel("chat")).toBe("对话消耗");
    expect(ledgerReasonLabel("subscription")).toBe("套餐额度发放");
    expect(ledgerReasonLabel("subscription_expire")).toBe("周期额度清零");
    expect(ledgerReasonLabel("pack")).toBe("加量包到账");
    expect(ledgerReasonLabel("future_reason")).toBe("future_reason");
  });
});
