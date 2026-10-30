import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "../../../..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

describe("V5 release verification wiring", () => {
  test("CCB bridge persists the freshly minted turn id before sealing the same id", () => {
    const source = read("packages/commercial/src/ws/userChatBridge.ts");
    const ccb = source.indexOf("dispatchRecordC = lookupAdmittedDispatch(enrichedParsed)");
    const mint = source.indexOf("signer.mintAuthorityTurnId()", ccb);
    const admit = source.indexOf("bindAuthorityTurnDispatch", mint);
    const seal = source.indexOf("sealAuthorityFieldsOrReject", admit);
    assert.ok(ccb >= 0 && ccb < mint && mint < admit && admit < seal);
    const bindingBlock = source.slice(admit, seal);
    assert.match(bindingBlock, /authorityTurnId/);
    assert.match(bindingBlock, /rejectPromptQueueDispatch\("DURABLE_DISPATCH_UNAVAILABLE"\)/);
    assert.match(source.slice(seal, seal + 900), /authorityTurnId/);
  });

  test("Cursor bridge persists the freshly minted turn id before sealing the same id", () => {
    const source = read("packages/commercial/src/ws/userChatBridge.ts");
    const cursor = source.indexOf("failDispatchPreForward(dispatchRecord, 'cursor_authority_rejected')");
    const mint = source.indexOf("signer.mintAuthorityTurnId()", cursor);
    const admit = source.indexOf("bindAuthorityTurnDispatch", mint);
    const seal = source.indexOf("sealAuthorityFieldsOrReject", admit);
    assert.ok(cursor >= 0 && cursor < mint && mint < admit && admit < seal);
    const bindingBlock = source.slice(admit, seal);
    assert.match(bindingBlock, /authorityTurnId: cursorAuthorityTurnId/);
    assert.match(bindingBlock, /rejectPromptQueueDispatch\('DURABLE_DISPATCH_UNAVAILABLE'\)/);
    assert.match(source.slice(seal, seal + 400), /authorityTurnId: cursorAuthorityTurnId/);
  });

  test("lease-only renewal accepts an open dispatch binding when the journal has no evidence", () => {
    const source = read("packages/commercial/src/http/internalTurnLeaseRenew.ts");
    const journal = source.indexOf("FROM request_finalize_journal");
    const dispatch = source.indexOf("FROM authority_turn_dispatches atd");
    const legacy = source.indexOf("if (!active || active.turn_key === null)", dispatch);
    assert.ok(dispatch >= 0 && dispatch < legacy && legacy < journal);
    const block = source.slice(dispatch, legacy);
    assert.match(block, /FOR UPDATE OF atd, td/);
    assert.match(block, /!\['admitted', 'accepted'\]\.includes\(active\.status\)/);
    assert.match(block, /active\.terminal_at !== null/);
    assert.match(block, /active\.producer_fenced_at !== null/);
    assert.match(block, /active\.attempt_no !== active\.dispatch_attempt_no/);
    assert.match(source.slice(legacy, journal + 500), /created_at >= to_timestamp/);
  });

  test("lease-only proxy restores both sponsorship and exact dispatch identity", () => {
    const source = read("packages/commercial/src/http/proxy/index.ts");
    const lease = source.indexOf("const leaseAdmission = await resolveAuthorityTurnDispatchSponsorship");
    assert.ok(lease >= 0);
    const block = source.slice(lease, lease + 5_000);
    assert.match(block, /gate\.authorityTurnId/);
    // 身份比对用票据里的 turn 主模型,而不是本请求 body.model 的归一值;否则同 turn 的 aux 请求
    // (CCB SMALL_FAST / cursor 子 agent 次级模型)全部 409 VERIFICATION_SPONSORSHIP_CONFLICT。
    const callEnd = block.indexOf("});");
    const callArgs = block.slice(0, callEnd);
    assert.match(callArgs, /model: body\.model/);
    assert.match(callArgs, /canonicalModel: gate\.authorityCanonicalModel/);
    assert.doesNotMatch(callArgs, /canonicalModel: gate\.canonicalModel/);
    assert.match(block, /dispatchIdentity = leaseAdmission\.dispatchIdentity/);
    assert.match(block, /verificationSponsorship = leaseAdmission\.sponsorship/);
    assert.match(block, /VERIFICATION_SPONSORSHIP_CONFLICT/);
  });

  test("every live turn spec has the exact-model database guard; UI journeys also select by id", () => {
    for (const name of ["01-login-relogin-display", "03-reconnect-inflight", "04-terminal-reconcile"]) {
      const source = read(`e2e/session-display/tests/${name}.spec.ts`);
      assert.match(source, /selectExactModel\(page, cfg\.model\)/, name);
      assert.match(source, /track\(sid, \{ expectTurn: true \}\)/, name);
    }
    for (const name of ["07-resend-dedup", "09-fixed-model-billing-evidence"]) {
      const source = read(`e2e/session-display/tests/${name}.spec.ts`);
      assert.match(source, /track\(sid, \{ expectTurn: true \}\)/, name);
      assert.match(source, /model: cfg\.model/, name);
    }
    const selector = read("packages/web-react/src/components/ModelSelector.tsx");
    assert.match(selector, /data-model-id=\{m\.id\}/);
    const fixture = read("e2e/session-display/fixtures.ts");
    assert.match(fixture, /assertSessionDispatchModel\(userId, id, config\(\)\.model\)/);
  });
});
