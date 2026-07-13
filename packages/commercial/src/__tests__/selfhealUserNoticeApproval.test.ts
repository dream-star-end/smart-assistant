import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTrustedRepairAttestation } from "../selfheal/userNoticeApproval.js";
import { captureUserImpactFence, isUserImpactFenceCurrent, recordUserImpact } from "../selfheal/userImpact.js";

const expected = { repairId: "12", incidentId: "34", conditionKey: "ops.monitor:svc_v5" };
const valid = {
  trusted_attestation: {
    version: 1,
    repairId: "12",
    incidentId: "34",
    conditionKey: "ops.monitor:svc_v5",
    target: "service:v5",
    action: "deploy_v5",
    executionMode: "fully_automatic",
    executed: true,
    remoteResult: {
      ok: true,
      target: "service:v5",
      healthOk: true,
      checkedAt: "2026-07-13T01:00:00.000Z",
    },
  },
};

describe("selfheal trusted repair attestation", () => {
  it("accepts a root-authored fully automatic matching attestation", () => {
    assert.equal(parseTrustedRepairAttestation(valid, expected)?.target, "service:v5");
  });

  it("rejects mismatched repair/incident/condition/target and non-automatic results", () => {
    for (const mutate of [
      { repairId: "13" },
      { incidentId: "35" },
      { conditionKey: "other" },
      { executionMode: "manual" },
      { executed: false },
      { action: "restart_service" },
      { remoteResult: { ...valid.trusted_attestation.remoteResult, target: "provider:other" } },
      { remoteResult: { ...valid.trusted_attestation.remoteResult, healthOk: false } },
    ]) {
      const candidate = {
        trusted_attestation: { ...valid.trusted_attestation, ...mutate },
      };
      assert.equal(parseTrustedRepairAttestation(candidate, expected), null);
    }
  });
});

describe("selfheal pending impact fence",()=>{
  it("blocks delivery while an evidence INSERT is in flight and invalidates older tokens",async()=>{
    let release!:()=>void;
    const blocked=new Promise<void>((resolve)=>{release=resolve;});
    const input={conditionKey:"ops.monitor:svc_v5",userId:1n,requestId:"r",target:"service:v5",failureCode:"INTERNAL"};
    const before=captureUserImpactFence(input.conditionKey,input.target);
    assert.notEqual(before,null);
    const write=recordUserImpact(input,(async()=>{await blocked;return {rowCount:1};}) as any);
    assert.equal(captureUserImpactFence(input.conditionKey,input.target),null);
    assert.equal(isUserImpactFenceCurrent(input.conditionKey,input.target,before!),false);
    release();
    assert.equal(await write,true);
    assert.notEqual(captureUserImpactFence(input.conditionKey,input.target),null);
  });
});
