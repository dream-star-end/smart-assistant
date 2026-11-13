import test from "node:test";
import assert from "node:assert/strict";
import { classifyBoxFailureCause, boxFailureObservation } from "./boxFailureCause.js";

test("cause whitelist classifies native network codes without retaining private text", () => {
  const error = new Error("SECRET https://token.example", { cause: { code: "ECONNRESET",
    body: "SECRET", headers: { authorization: "SECRET" } } });
  assert.equal(classifyBoxFailureCause(error), "connection_reset");
  assert.deepEqual(boxFailureObservation(error, "fetch"), { causeTag: "connection_reset", stage: "fetch" });
  for (const code of ["ECONNRESET SECRET", "__proto__", "constructor", "toString"]) {
    assert.equal(classifyBoxFailureCause({ code }), "unknown");
  }
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  assert.equal(classifyBoxFailureCause(cycle), "unknown");
});

test("poisoned descriptors, proxies, cause cycles and spoofed tags never escape or invoke getters", () => {
  let calls = 0;
  const poison = Object.defineProperties({}, Object.fromEntries(
    ["code", "name", "cause", "message", "stack", "causeTag", "stage"].map(key => [key,
      { get() { calls++; throw new Error("SECRET"); } }])));
  assert.deepEqual(boxFailureObservation(poison, "stream"), { causeTag: "unknown", stage: "stream" });
  assert.equal(calls, 0);
  assert.deepEqual(boxFailureObservation(new Proxy({}, { getOwnPropertyDescriptor() {
    throw new Error("SECRET"); } }), "fetch"), { causeTag: "unknown", stage: "fetch" });
  assert.deepEqual(boxFailureObservation({ causeTag: "SECRET", stage: "SECRET" }, "fetch"),
    { causeTag: "unknown", stage: "fetch" });
});

test("numeric observations are bounded and HTTP statuses come only from exact fixed codes", () => {
  assert.deepEqual(boxFailureObservation({ code: "BOX_EXEC_HTTP_429", causeTag: "http", stage: "http",
    remoteExitCode: 1, terminalKnown: false }, "fetch"), { causeTag: "http", stage: "http",
    httpStatus: 429, remoteExitCode: 1, terminalKnown: false });
  assert.deepEqual(boxFailureObservation({ code: "BOX_EXEC_HTTP_429 SECRET", remoteExitCode: Infinity,
    terminalKnown: "SECRET" }, "fetch"), { causeTag: "unknown", stage: "fetch" });
});
