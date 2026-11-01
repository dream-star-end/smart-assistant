import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rejectedDispatchFailureCode } from "../dispatch/attachmentTotalFailure.js";

describe("attachment total failure code", () => {
  it("rejected dispatch keeps DISPATCH_NOT_ACCEPTED unless the attachment total code parses", () => {
    const plain = { kind: "ok", state: "rejected", outcome: "not_accepted" };
    const foreign = { kind: "ok", userFailureCode: "PLEASE_RETRY" };
    const unreachable = { kind: "unreachable", detail: "down", userFailureCode: "ATTACHMENT_TOTAL_EXCEEDED:1" };
    const over = { kind: "ok", userFailureCode: "ATTACHMENT_TOTAL_EXCEEDED:345649213" };
    assert.equal(rejectedDispatchFailureCode(plain), "DISPATCH_NOT_ACCEPTED");
    assert.equal(rejectedDispatchFailureCode(foreign), "DISPATCH_NOT_ACCEPTED");
    assert.equal(rejectedDispatchFailureCode(unreachable), "DISPATCH_NOT_ACCEPTED");
    assert.equal(rejectedDispatchFailureCode(over), "ATTACHMENT_TOTAL_EXCEEDED:345649213");
  });
});
