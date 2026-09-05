import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseModels, parseOptions, turnPolicy, engineMatrix, tapResult, assertOutbound, turnEvidence } from "../lib/user-contract.mjs";
const catalog = [{ id: "gpt-5.6-sol", engine: "codex" }, { id: "deepseek-v4-flash", engine: "ccb" }];
test("contract options default dry and reject malformed modes/origins", () => {
  assert.equal(parseOptions({}).cost, "dry");
  assert.equal(parseOptions({ V5_CONTRACT_COST: "live" }).cost, "live");
  for (const env of [{ V5_CONTRACT_COST: "LIVE" }, { V5_E2E_BASE: "file:///a" }, { V5_E2E_BASE: "http://a/x" }, { V5_CANARY_EMAIL: "bad" }, { V5_CONTRACT_MODEL_ID: "a,b" }]) assert.throws(() => parseOptions(env));
});
test("model parser trims exact ids and rejects duplicates empty and selector injection", () => {
  assert.deepEqual(parseModels(" a, b "), ["a", "b"]);
  for (const s of ["", "a,", "a,a", 'a\" ]']) assert.throws(() => parseModels(s));
});
test("dry and live policy are disjoint and unknown is fatal", () => {
  assert.deepEqual(turnPolicy("dry"), { forward: false, waitForCompletion: false });
  assert.deepEqual(turnPolicy("live"), { forward: true, waitForCompletion: true });
  assert.throws(() => turnPolicy(""));
});
test("matrix uses catalog and requires distinct known engines", () => {
  assert.deepEqual(engineMatrix(parseModels(), catalog), catalog);
  assert.throws(() => engineMatrix(["absent", "deepseek-v4-flash"], catalog));
  assert.throws(() => engineMatrix(parseModels(), catalog.map((m) => ({ ...m, engine: "ccb" }))));
  assert.throws(() => engineMatrix(["gpt-5.6-sol"], catalog));
});
test("TAP emits one result per line with timings and sanitizes diagnostics", () => {
  assert.equal(tapResult(false, 2, "case\nname", 1.6, "bad\nreason"), "not ok 2 - case name\n# duration_ms 2 2\n# error bad reason");
  assert.match(tapResult(true, 1, "C1", 0), /^ok 1 - C1/);
});
const sent = { type: "inbound.message", model: "gpt-5.6-sol", content: { text: "probe" }, peer: { id: "p" }, clientMessageId: "m" };
test("outbound proof rejects wrong model engine text and team override", () => {
  const expected = { model: sent.model, text: "probe", engine: "codex" };
  assert.equal(assertOutbound(sent, expected, catalog), sent);
  for (const f of [{ ...sent, model: "deepseek-v4-flash" }, { ...sent, teamMode: true }, { ...sent, clientMessageId: "" }]) assert.throws(() => assertOutbound(f, expected, catalog));
  assert.throws(() => assertOutbound(sent, { ...expected, engine: "ccb" }, catalog));
});
test("completion requires exact peer/message and errors trump final", () => {
  const final = { type: "outbound.message", peer: sent.peer, clientMessageId: "m", isFinal: true };
  assert.deepEqual(turnEvidence([{ ...final, clientMessageId: "other" }], sent), { complete: false, error: false });
  assert.deepEqual(turnEvidence([final], sent), { complete: true, error: false });
  assert.deepEqual(turnEvidence([final, { ...final, type: "outbound.error" }], sent), { complete: true, error: true });
});
const deploy = readFileSync(new URL("../deploy-v5-selfhost.sh", import.meta.url), "utf8");
function shellFunction(name: string) {
  const start = deploy.indexOf(`${name}() {`);
  assert.ok(start >= 0);
  const end = deploy.indexOf("\n}\n", start);
  return deploy.slice(start, end + 3);
}
test("deploy gate missing credential fails closed without executing node", () => {
  const fn = shellFunction("user_contract_gate").replace("/etc/openclaude/selfhost-canary.password", "/nonexistent-r2-canary-password");
  const out = execFileSync("bash", ["-c", `${fn}\nnode(){ echo NODE_MUST_NOT_RUN; }; user_contract_gate; echo rc=$?`], { encoding: "utf8" });
  assert.match(out, /rc=1/); assert.doesNotMatch(out, /NODE_MUST_NOT_RUN/);
});
test("new gate is within forward smoke before smoked and absent from rollback", () => {
  assert.match(shellFunction("cutover_smoke_against_release"), /user_contract_gate \|\| return 1/);
  assert.doesNotMatch(shellFunction("cutover_smoke_healthz_only"), /user_contract_gate/);
  assert.doesNotMatch(shellFunction("cmd_smoke"), /user_contract_gate/);
  const fn = shellFunction("user_contract_gate");
  assert.match(fn, /V5_CONTRACT_COST=live/);
  assert.match(fn, /node "\$SCRIPT_DIR\/v5-user-contract-smoke.mjs"/);
});
