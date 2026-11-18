import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { selectJourneyValidation } from "../lib/v5-validation-journey.mjs";

const profile = () => ({
  schemaVersion: 1, profile: "skip-grok", authorizationRef: "user:skip-grok:20261103",
  queueId: "rq-20261103T001000Z-123456789abc",
  sourceSha: "31dedfb0bc4243dbcb32b1d1dfdd9fbcdad3b5fd",
  operationId: "a".repeat(24), matrixModels: ["deepseek-v4-flash"],
  journeyModel: "deepseek-v4-flash", skipped: ["grok-build:matrix", "grok-build:journey"],
});
const canonical = (value) => JSON.stringify(Object.fromEntries(
  Object.keys(value).sort().map((key) => [key, value[key]]),
));
const option = (text) => `--validation-scope=${Buffer.from(text).toString("base64")}`;
const select = (value) => selectJourneyValidation([option(canonical(value))]);

test("default_grok: no scope pins the whole journey despite model environment overrides", () => {
  const previous = process.env.V5_TURN_MODELS;
  process.env.V5_TURN_MODELS = "deepseek-v4-flash";
  try { assert.deepEqual(selectJourneyValidation([]), { model: "grok-build", scope: null }); }
  finally {
    if (previous === undefined) assert.equal(Reflect.deleteProperty(process.env, "V5_TURN_MODELS"), true);
    else process.env.V5_TURN_MODELS = previous;
  }
});

test("bound canonical skip-grok scope selects DeepSeek for the full journey", () => {
  const scope = profile();
  assert.deepEqual(select(scope), { model: "deepseek-v4-flash", scope });
});

test("unknown, incomplete, duplicate and positional CLI arguments fail closed", () => {
  for (const args of [["--help"], ["--model=deepseek-v4-flash"], ["--validation-scope"],
    ["--validation-scope="], ["value"], [option(canonical(profile())), option(canonical(profile()))]]) {
    assert.throws(() => selectJourneyValidation(args), /validation|arguments/);
  }
});

test("malformed base64, UTF-8 and JSON cannot select a model", () => {
  for (const encoded of ["%%%", "e30", "/w==", Buffer.from("not JSON").toString("base64")]) {
    assert.throws(() => selectJourneyValidation([`--validation-scope=${encoded}`]), /validation scope/);
  }
});

test("preflight scopes without an operation binding are refused", () => {
  for (const operationId of [undefined, "", " ", null, 17]) {
    const scope = profile(); scope.operationId = operationId;
    assert.throws(() => select(scope), /bound source, queue and operation/);
  }
});

test("invalid schema, bindings, models and skipped claims are rejected by the real validator", () => {
  const cases = [{ schemaVersion: 2 }, { profile: "normal" }, { authorizationRef: "" },
    { sourceSha: "wrong" }, { queueId: "" }, { operationId: "with space" },
    { matrixModels: ["grok-build"] }, { journeyModel: "grok-build" },
    { skipped: ["grok-build:journey"] }, { extra: true }];
  for (const changes of cases) assert.throws(() => select({ ...profile(), ...changes }), /validation scope/);
});

test("noncanonical and duplicate-key JSON cannot masquerade as a canonical receipt", () => {
  const text = canonical(profile());
  for (const bad of [` ${text}`, JSON.stringify(profile()),
    text.replace('"profile":"skip-grok"', '"profile":"normal","profile":"skip-grok"')]) {
    assert.throws(() => selectJourneyValidation([option(bad)]), /validation scope/);
  }
});

test("a missing validator fails before a scoped model can be accepted", () => {
  const moduleUrl = new URL("../lib/v5-validation-journey.mjs", import.meta.url).href;
  const code = `import { selectJourneyValidation } from ${JSON.stringify(moduleUrl)};
    try { selectJourneyValidation([${JSON.stringify(option(canonical(profile())))}]); process.exit(3); }
    catch (error) { if (!error.message.includes('profile validator')) process.exit(4); }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, PATH: "/nonexistent-journey-validator" }, stdio: "pipe", timeout: 5_000,
  });
});
