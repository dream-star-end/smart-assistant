import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  TEST_ACCOUNT_DENIED_MODEL_ID,
  deniedModelIdsForTrafficClass,
} from "../auth/userModelAuthz.js";

describe("test-account model denials", () => {
  test("synthetic_canary/e2e deny deepseek-v4-pro", () => {
    for (const trafficClass of ["synthetic_canary", "e2e"]) {
      assert.deepEqual(
        [...deniedModelIdsForTrafficClass(trafficClass)],
        [TEST_ACCOUNT_DENIED_MODEL_ID],
      );
    }
  });

  test("production_user/internal_admin have no account-level model denial", () => {
    for (const trafficClass of ["production_user", "internal_admin", null]) {
      assert.equal(deniedModelIdsForTrafficClass(trafficClass).size, 0);
    }
  });
});
