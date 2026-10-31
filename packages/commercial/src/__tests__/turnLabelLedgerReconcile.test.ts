import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  TURN_LABEL_LEDGER_RECONCILE_SQL,
  TURN_LABEL_LEDGER_RECONCILE_USERS_SQL,
  reconcileSqlIsReadOnly,
  reconcileWindow,
  redactDbUrl,
  turnLabelLedgerGap,
} from "../billing/turnLabelLedgerReconcile.js";

describe("turnLabelLedgerGap", () => {
  it("alarms when the unattributed vision charges are missing from the label", () => {
    assert.equal(turnLabelLedgerGap({ ledgerChatDebit: 132n, labeled: 97n, knownNonTurn: 0n }), 35n);
  });

  it("matches once those charges are on the turn", () => {
    assert.equal(turnLabelLedgerGap({ ledgerChatDebit: 132n, labeled: 132n, knownNonTurn: 0n }), 0n);
  });

  it("matches when the skip was explicit and the label stays at the model charge", () => {
    assert.equal(turnLabelLedgerGap({ ledgerChatDebit: 132n, labeled: 97n, knownNonTurn: 35n }), 0n);
  });
});

describe("reconcile sql", () => {
  it("is a read", () => {
    assert.equal(reconcileSqlIsReadOnly(TURN_LABEL_LEDGER_RECONCILE_SQL), true);
    assert.equal(reconcileSqlIsReadOnly(TURN_LABEL_LEDGER_RECONCILE_USERS_SQL), true);
    assert.match(TURN_LABEL_LEDGER_RECONCILE_SQL, /openTurnAttribution/);
    assert.match(TURN_LABEL_LEDGER_RECONCILE_SQL, /turn_tape_cost_components/);
    assert.match(TURN_LABEL_LEDGER_RECONCILE_SQL, /reason = 'chat'/);
  });

  it("the cli script starts a read-only transaction and hides database urls", () => {
    const src = readFileSync(
      new URL("../../../../scripts/ops/turn-label-ledger-reconcile.ts", import.meta.url),
      "utf8",
    );
    assert.match(src, /BEGIN READ ONLY/);
    assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(src), false);
    assert.equal(
      redactDbUrl("connect failed postgres://user:secret@db.internal:5432/app?ssl=1"),
      "connect failed postgres://redacted",
    );
  });
});

describe("reconcileWindow", () => {
  it("defaults to the trailing 24 hours and requires a paired bound", () => {
    const now = new Date("2026-10-31T12:00:00.000Z");
    const window = reconcileWindow([], now);
    assert.equal("error" in window, false);
    if ("error" in window) return;
    assert.equal(window.until.toISOString(), now.toISOString());
    assert.equal(window.since.toISOString(), "2026-10-30T12:00:00.000Z");
    assert.deepEqual(reconcileWindow(["--since", "2026-10-31"], now), {
      error: "--since and --until must be passed together",
    });
  });
});
