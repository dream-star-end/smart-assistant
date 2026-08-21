import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { meetsMinPlan } from "../billing/planEntitlement.js";

describe("meetsMinPlan", () => {
  test("no floor → allow", () => {
    assert.equal(meetsMinPlan({}), true);
    assert.equal(meetsMinPlan({ minPlanCode: null, userPlanTier: 0 }), true);
  });

  test("Max floor allows max/ultra personal tiers", () => {
    assert.equal(
      meetsMinPlan({ minPlanCode: "max", minPlanTier: 3, userPlanTier: 2 }),
      false,
    );
    assert.equal(
      meetsMinPlan({ minPlanCode: "max", minPlanTier: 3, userPlanTier: 3 }),
      true,
    );
    assert.equal(
      meetsMinPlan({ minPlanCode: "max", minPlanTier: 3, userPlanTier: 4 }),
      true,
    );
    assert.equal(
      meetsMinPlan({ minPlanCode: "max", minPlanTier: 3, userPlanTier: null }),
      false,
    );
  });

  test("org-max / org-ultra satisfy user Max", () => {
    assert.equal(
      meetsMinPlan({
        minPlanCode: "max",
        minPlanTier: 3,
        userPlanTier: 0,
        orgPlanCode: "org-pro",
      }),
      false,
    );
    assert.equal(
      meetsMinPlan({
        minPlanCode: "max",
        minPlanTier: 3,
        orgPlanCode: "org-max",
      }),
      true,
    );
    assert.equal(
      meetsMinPlan({
        minPlanCode: "max",
        minPlanTier: 3,
        orgPlanCode: "org-ultra",
      }),
      true,
    );
  });
});
