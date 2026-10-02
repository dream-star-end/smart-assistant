import test from "node:test";
import assert from "node:assert/strict";
import { observeGateBody, gateSequenceExit } from "./ccbEfficiencyHookShapeProbe.js";

const body = { model: "box-api-claude-opus-5-5", messages: [] };

test("a deliberate gate throw stays failed even when strip also throws", () => {
  const observed = observeGateBody(0, body, {
    validateBoxRequest() { throw new Error("deliberate-gate"); },
  }, {
    stripBoxCcbToolBudgetTail() { throw new Error("deliberate-strip"); },
  });
  assert.equal(observed.code, null);
  assert.match(observed.error ?? "", /gate: deliberate-gate/);
  assert.match(observed.error ?? "", /strip: deliberate-strip/);
  const three = [0, 1, 2].map((index) => ({ ...observed, index }));
  assert.equal(gateSequenceExit(3, three), 2);
});

test("a later successful strip does not clear an earlier gate error", () => {
  const observed = observeGateBody(0, body, {
    validateBoxRequest() { throw new Error("deliberate-gate"); },
  }, {
    stripBoxCcbToolBudgetTail() { return body; },
  });
  assert.match(observed.error ?? "", /deliberate-gate/);
  assert.equal(gateSequenceExit(3, [
    observed,
    { index: 1, code: null, error: null, strippedRoles: [] },
    { index: 2, code: null, error: null, strippedRoles: [] },
  ]), 2);
});

test("only three null codes and null errors pass", () => {
  const clean = [0, 1, 2].map((index) => ({ index, code: null, error: null,
    strippedRoles: [] }));
  assert.equal(gateSequenceExit(3, clean), 0);
  assert.equal(gateSequenceExit(2, clean.slice(0, 2)), 2);
  assert.equal(gateSequenceExit(3, clean.map((item, index) => index === 2
    ? { ...item, code: "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION" } : item)), 2);
});
