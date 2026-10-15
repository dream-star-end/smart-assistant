import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseModels, parseOptions, turnPolicy, engineMatrix, tapResult, assertOutbound, turnEvidence, continuationCode, continuationPrompts, assertSameSession, assertContinuationAnswer } from "../lib/user-contract.mjs";
const catalog = [{ id: "grok-build", engine: "grok" }, { id: "deepseek-v4-flash", engine: "ccb" }];
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
const sent = { type: "inbound.message", model: "grok-build", content: { text: "probe" }, peer: { id: "p" }, clientMessageId: "m" };
test("outbound proof rejects wrong model engine text and team override", () => {
  const expected = { model: sent.model, text: "probe", engine: "grok" };
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
test("continuation code is random letters+digits and only the first prompt carries it", () => {
  const codes = new Set(Array.from({ length: 200 }, () => continuationCode()));
  assert.ok(codes.size > 195);
  for (const c of codes) assert.match(c, /^[A-HJ-NP-Z]{4}[0-9]{4}$/);
  const p = continuationPrompts("QWER1234");
  assert.match(p.first, /QWER1234/);
  assert.doesNotMatch(p.second, /QWER1234/);
  assert.notEqual(p.first, p.second);
  assert.throws(() => continuationPrompts("abc"));
  // OCV5-417: wording that grok-build treats as a prompt-injection canary must not come back.
  for (const text of [p.first, p.second]) assert.doesNotMatch(text, /暗号|口令|密码|记住|只回答|只回复/);
});
test("continuation answer must contain the exact code as one token", () => {
  for (const ok of ["QWER1234", "编号是 PO-QWER1234。", "`qwer1234`", "**QWER1234**"]) assertContinuationAnswer(ok, "QWER1234");
  for (const bad of ["", "2", "不知道", "QWER-1234", "QWER12345", "XQWER1234", "QWER"]) assert.throws(() => assertContinuationAnswer(bad, "QWER1234"));
});
test("continuation must stay in the first turn's session with a new message id", () => {
  const a = { peer: { id: "p1" }, clientMessageId: "m1" };
  assertSameSession(a, { peer: { id: "p1" }, clientMessageId: "m2" });
  assert.throws(() => assertSameSession(a, { peer: { id: "p2" }, clientMessageId: "m2" }));
  assert.throws(() => assertSameSession(a, { peer: { id: "p1" }, clientMessageId: "m1" }));
  assert.throws(() => assertSameSession({ peer: {} }, { peer: {}, clientMessageId: "m2" }));
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
  assert.match(shellFunction("cutover_smoke_against_release"), /user_contract_gate \|\| \{ cutover_fail "[^"]+"; return 1; \}/);
  assert.doesNotMatch(shellFunction("cutover_smoke_healthz_only"), /user_contract_gate/);
  assert.doesNotMatch(shellFunction("cmd_smoke"), /user_contract_gate/);
  const fn = shellFunction("user_contract_gate");
  assert.match(fn, /V5_CONTRACT_COST=live/);
  assert.match(fn, /node "\$SCRIPT_DIR\/v5-user-contract-smoke.mjs"/);
});
test("OCV5-429: canary prewarm runs before the smoke and never decides the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-429-"));
  const pw = join(dir, "pw");
  writeFileSync(pw, "x");
  const fn = shellFunction("user_contract_gate").replace("/etc/openclaude/selfhost-canary.password", pw);
  const run = (prewarmRc: number, smokeRc: number) => execFileSync("bash", ["-c",
    `${fn}\nSCRIPT_DIR=/s; V5_PORT=1; node(){ echo "RUN $1 $V5_CONTRACT_COST"; case "$1" in *prewarm*) return ${prewarmRc};; *) return ${smokeRc};; esac; }; user_contract_gate; echo rc=$?`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = run(1, 0);
  assert.match(ok, /RUN \/s\/v5-user-contract-prewarm\.mjs \nRUN \/s\/v5-user-contract-smoke\.mjs live\nrc=0/);
  assert.match(run(0, 1), /rc=1/);
  assert.match(run(1, 1), /rc=1/);
});
test("OCV5-429: prewarm is a UI login that sends nothing and waits for relay_ready", async () => {
  const src = readFileSync(new URL("../v5-user-contract-prewarm.mjs", import.meta.url), "utf8");
  assert.match(src, /await coldUiLogin\(page, options, password\)/);
  assert.match(src, /await waitRelayReady\(probe, PREWARM_TIMEOUT\)/);
  assert.doesNotMatch(src, /fetch\(|sendContractTurn|\/api\/auth/);
  const { waitRelayReady } = await import("../lib/user-contract-browser.mjs");
  const probe = { received: [{ type: "sys.frontend_build" }] as Array<{ type: string }> };
  setTimeout(() => probe.received.push({ type: "sys.relay_ready" }), 30);
  assert.equal((await waitRelayReady(probe, 1000)).type, "sys.relay_ready");
  await assert.rejects(waitRelayReady({ received: [] }, 50), /Canary relay not ready/);
});
