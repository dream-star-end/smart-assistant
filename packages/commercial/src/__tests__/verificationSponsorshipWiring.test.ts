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

  test("lease-only proxy restores both sponsorship and exact dispatch identity", () => {
    const source = read("packages/commercial/src/http/proxy/index.ts");
    const lease = source.indexOf("const leaseAdmission = await resolveAuthorityTurnDispatchSponsorship");
    assert.ok(lease >= 0);
    const block = source.slice(lease, lease + 5_000);
    assert.match(block, /gate\.authorityTurnId/);
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
