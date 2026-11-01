import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rejectedDispatchFailureCode } from "../dispatch/attachmentTotalFailure.js";

describe("attachment total failure code", () => {
  it("rejected dispatch keeps DISPATCH_NOT_ACCEPTED unless the attachment total code parses", () => {
    assert.equal(
      rejectedDispatchFailureCode({ kind: "ok", state: "rejected", outcome: "not_accepted" }),
      "DISPATCH_NOT_ACCEPTED",
    );
    assert.equal(
      rejectedDispatchFailureCode({ kind: "ok", userFailureCode: "PLEASE_RETRY" }),
      "DISPATCH_NOT_ACCEPTED",
    );
    assert.equal(
      rejectedDispatchFailureCode({ kind: "unreachable", detail: "down", userFailureCode: "ATTACHMENT_TOTAL_EXCEEDED:1" }),
      "DISPATCH_NOT_ACCEPTED",
    );
    assert.equal(
      rejectedDispatchFailureCode({ kind: "ok", userFailureCode: "ATTACHMENT_TOTAL_EXCEEDED:345649213" }),
      "ATTACHMENT_TOTAL_EXCEEDED:345649213",
    );
  });
});
