/**
 * OCV5-392: Auto-Dream calls are attributed as mode 'auto_dream' in memory; settlement
 * stores mode/reason 'chat' plus workload='auto_dream' (0304).
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/autoDreamBillingMode.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyWorkloadMode, extractUsageAttribution } from "../http/proxy/shared.js";
import { parseBoxBillingContext, serializeBoxBillingContext } from "../http/proxy/boxBillingContext.js";
import { LEDGER_REASONS } from "../billing/ledger.js";

const chat = extractUsageAttribution({ user_id: JSON.stringify({ session_id: "s1" }) });
const delegate = extractUsageAttribution({
  user_id: JSON.stringify({ session_id: "s2", oc_mode: "delegate", oc_delegate_agent_id: "reviewer" }),
});

describe("applyWorkloadMode", () => {
  test("a chat request tagged auto-dream becomes auto_dream; nothing else changes", () => {
    assert.deepEqual(applyWorkloadMode(chat, "auto-dream"), { ...chat, mode: "auto_dream" });
    assert.equal(applyWorkloadMode(chat, null), chat);
    assert.equal(applyWorkloadMode(chat, "cron"), chat);
  });

  test("delegate attribution wins over the workload tag", () => {
    assert.equal(applyWorkloadMode(delegate, "auto-dream"), delegate);
  });
});

describe("box billing context", () => {
  test("round-trips mode auto_dream and still rejects unknown modes", () => {
    const raw = serializeBoxBillingContext({
      sessionId: "s1", mode: "auto_dream", parentSessionId: null, delegateAgentId: null,
      turnKey: "a".repeat(64), parentTurnKey: null, authority: null,
    } as never);
    assert.equal(parseBoxBillingContext(raw)?.mode, "auto_dream");
    assert.equal(parseBoxBillingContext({ ...(raw as object), mode: "cron" }), null);
  });
});

describe("ledger reasons", () => {
  test("auto_dream is not a ledger reason: the debit stays chat (workload column instead)", () => {
    assert.ok(!(LEDGER_REASONS as readonly string[]).includes("auto_dream"));
  });
});
