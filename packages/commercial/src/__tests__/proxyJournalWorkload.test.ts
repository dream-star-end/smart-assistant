/**
 * OCV5-392: the CCB proxy journal ctx carries the CCB billing-header workload
 * (`cc_workload=auto-dream;`) so an Auto-Dream call is distinguishable from chat.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/proxyJournalWorkload.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildProxyJournalCtxJson, extractCcWorkload } from "../http/proxy/index.js";

const header = (pairs: string) => `x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=sdk-cli;${pairs} cch=00000;`;

describe("extractCcWorkload", () => {
  test("reads the tag from system block 0 (array and string forms)", () => {
    const text = `${header(" cc_workload=auto-dream;")}\nYou are Claude Code.`;
    assert.equal(extractCcWorkload([{ type: "text", text }, { type: "text", text: "rest" }]), "auto-dream");
    assert.equal(extractCcWorkload(text), "auto-dream");
    assert.equal(extractCcWorkload([{ type: "text", text: header(" cc_workload=cron;") }]), "cron");
  });

  test("no header, no tag, or a tag outside the header line → null", () => {
    assert.equal(extractCcWorkload(undefined), null);
    assert.equal(extractCcWorkload([{ type: "text", text: header("") }]), null);
    assert.equal(extractCcWorkload([{ type: "text", text: "plain prompt cc_workload=auto-dream;" }]), null);
    assert.equal(extractCcWorkload([{ type: "text", text: `${header("")}\ncc_workload=auto-dream;` }]), null);
    assert.equal(extractCcWorkload([{ type: "text", text: "intro" }, { type: "text", text: header(" cc_workload=cron;") }]), null);
  });

  test("only CCB's tag alphabet is accepted", () => {
    assert.equal(extractCcWorkload(header(" cc_workload=Auto Dream;")), null);
    assert.equal(extractCcWorkload(header(` cc_workload=${"a".repeat(33)};`)), null);
    assert.equal(extractCcWorkload(header(' cc_workload=x"};')), null);
  });
});

describe("buildProxyJournalCtxJson workload", () => {
  test("is written when present and absent otherwise", () => {
    assert.deepEqual(buildProxyJournalCtxJson({ gate: null, workload: "auto-dream" }), { workload: "auto-dream" });
    assert.deepEqual(
      buildProxyJournalCtxJson({ gate: null, runtimeKind: "desktop", workload: "cron" }),
      { workload: "cron", source: "ccb_proxy", runtimeKind: "desktop" },
    );
    assert.equal(buildProxyJournalCtxJson({ gate: null, workload: null }), undefined);
    assert.equal(buildProxyJournalCtxJson({ gate: null }), undefined);
  });
});
