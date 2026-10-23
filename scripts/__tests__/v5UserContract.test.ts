import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseModels, parseOptions, turnPolicy, engineMatrix, tapResult, assertOutbound, turnEvidence, continuationCode, continuationPrompts, assertSameSession, assertContinuationAnswer, offloadedRequestReads } from "../lib/user-contract.mjs";
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
const diagnostics = readFileSync(new URL("../lib/v5-selfhost-diagnostics.sh", import.meta.url), "utf8");
function shellFunction(name: string) {
  const source = name === "cmd_smoke" ? diagnostics : deploy;
  assert.ok(deploy.includes('source "$SCRIPT_DIR/lib/v5-selfhost-diagnostics.sh"'));
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 3);
}
test("deploy gate missing credential fails closed without executing node", () => {
  const fn = shellFunction("user_contract_gate").replace("/etc/openclaude/selfhost-canary.password", "/nonexistent-r2-canary-password");
  const out = execFileSync("bash", ["-c", `${fn}\nnode(){ echo NODE_MUST_NOT_RUN; }; user_contract_gate; echo rc=$?`], { encoding: "utf8" });
  assert.match(out, /rc=1/); assert.doesNotMatch(out, /NODE_MUST_NOT_RUN/);
});
test("new gate is within forward smoke before smoked and absent from rollback", () => {
  assert.match(shellFunction("cutover_smoke_against_release"), /user_contract_gate "\$rel" \|\| \{ cutover_fail "[^"]+"; return 1; \}/);
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
  const run = (prewarmRc: number, smokeRc: number, goCacheRc = 0) => execFileSync("bash", ["-c",
    `${fn}\nSCRIPT_DIR=/s; V5_PORT=1; node(){ echo "RUN $1 $V5_CONTRACT_COST"; case "$1" in *prewarm*) return ${prewarmRc};; *go-cache*) return ${goCacheRc};; *) return ${smokeRc};; esac; }; user_contract_gate; echo rc=$?`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = run(1, 0);
  assert.match(ok, /RUN \/s\/v5-user-contract-prewarm\.mjs \nRUN \/s\/v5-user-contract-smoke\.mjs live\nRUN \/s\/v5-go-cache-contract\.mjs \nRUN \/s\/v5-stop-before-start-contract\.mjs \nrc=0/);
  assert.match(run(0, 1), /rc=1/);
  assert.match(run(1, 1), /rc=1/);
});
test("OCV5-432: the go-cache check runs after a passing C1–C3 and decides the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-432-"));
  const pw = join(dir, "pw");
  writeFileSync(pw, "x");
  const fn = shellFunction("user_contract_gate").replace("/etc/openclaude/selfhost-canary.password", pw);
  const run = (smokeRc: number, goCacheRc: number) => execFileSync("bash", ["-c",
    `${fn}\nSCRIPT_DIR=/s; V5_PORT=1; node(){ echo "RUN $1"; case "$1" in *prewarm*) return 0;; *go-cache*) return ${goCacheRc};; *) return ${smokeRc};; esac; }; user_contract_gate; echo rc=$?`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const smokeFailed = run(1, 0);
  assert.match(smokeFailed, /rc=1/);
  assert.doesNotMatch(smokeFailed, /go-cache/);
  const goCacheFailed = run(0, 1);
  assert.match(goCacheFailed, /RUN \/s\/v5-go-cache-contract\.mjs\nrc=1/);
  assert.doesNotMatch(goCacheFailed, /stop-before-start/);
  assert.match(run(0, 0), /RUN \/s\/v5-go-cache-contract\.mjs\nRUN \/s\/v5-stop-before-start-contract\.mjs\nrc=0/);
});
test("OCV5-435: the stop-before-start check runs after a passing go-cache check and decides the verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-435-"));
  const pw = join(dir, "pw");
  writeFileSync(pw, "x");
  const fn = shellFunction("user_contract_gate").replace("/etc/openclaude/selfhost-canary.password", pw);
  const run = (stopRc: number) => execFileSync("bash", ["-c",
    `${fn}\nSCRIPT_DIR=/s; V5_PORT=1; node(){ echo "RUN $1"; case "$1" in *stop-before-start*) return ${stopRc};; *) return 0;; esac; }; user_contract_gate; echo rc=$?`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(run(1), /RUN \/s\/v5-go-cache-contract\.mjs\nRUN \/s\/v5-stop-before-start-contract\.mjs\nrc=1/);
  assert.match(run(0), /RUN \/s\/v5-stop-before-start-contract\.mjs\nrc=0/);
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
test("OCV5-460: a contract turn that reads an offloaded request file is caught", () => {
  const sent = { peer: { id: "p1" }, clientMessageId: "m1" };
  const read = { kind: "tool_use", toolName: "Read", inputJson: { file_path: "/home/agent/.openclaude/grok-build/caller/x/sessions/w/01a14455-86c8-7140-bd18-5fad8286980d/prompts/prompt_0.txt" } };
  const other = { kind: "tool_use", toolName: "Read", inputJson: { file_path: "src/prompts/prompt_guide.md" } };
  const frame = (blocks, clientMessageId = "m1") => ({ type: "outbound.message", peer: { id: "p1" }, clientMessageId, blocks });
  assert.deepEqual(offloadedRequestReads([frame([read])], sent), ["Read"]);
  assert.deepEqual(offloadedRequestReads([frame([{ kind: "text", text: "收到" }, other])], sent), []);
  assert.deepEqual(offloadedRequestReads([frame([read], "m2")], sent), []);
  assert.deepEqual(offloadedRequestReads([{ type: "outbound.turn_status", peer: { id: "p1" }, clientMessageId: "m1" }], sent), []);
});
test("OCV5-460: the smoke fails C3 when any continuation turn read an offloaded request file", () => {
  const smoke = readFileSync(new URL("../v5-user-contract-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /const run = await runContinuationTurns\(/);
  assert.match(smoke, /for \(const sent of run\.sent \?\? \[\]\) \{\n\s+const reads = offloadedRequestReads\(probe\.received, sent\);\n\s+if \(reads\.length\) throw new Error/);
});

// The user-approved OCV5-496 exception is per candidate SHA and only concerns G1.
test("OCV5-496: exact-SHA approval skips only Go and keeps other verdicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-496-gate-"));
  const pw = join(dir, "pw");
  const policy = join(dir, "policy");
  const sha = "a".repeat(40);
  writeFileSync(pw, "x");
  const gate = shellFunction("user_contract_gate").replace("/etc/openclaude/selfhost-canary.password", pw);
  const functions = [shellFunction("selfhost_policy_get"), shellFunction("go_cache_user_waiver_matches"), gate].join("\n");
  const run = (want: string, actual: string | null, smokeRc = 0, goRc = 1, stopRc = 0) => {
    writeFileSync(policy, `OC_V5_SELFHOST_SKIP_GO_CACHE_SHA=${want}\n`, { mode: 0o600 });
    writeFileSync(join(dir, ".complete"), JSON.stringify(actual === null ? {} : { sourceCommit: actual }));
    return execFileSync("bash", ["-c", `${functions}
      unset OC_V5_SELFHOST_SKIP_GO_CACHE_SHA
      SELFHOST_POLICY_FILE="$1"; SCRIPT_DIR=/s; V5_PORT=1
      cutover_clog(){ echo "$*"; }
      node(){ echo "RUN $1"; case "$1" in *prewarm*) return 0;; *user-contract-smoke*) return ${smokeRc};; *go-cache*) return ${goRc};; *stop-before-start*) return ${stopRc};; esac; }
      user_contract_gate "$2"; echo rc=$?
    `, "gate", policy, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  for (const [want, actual] of [["", sha], ["a", sha], ["b".repeat(40), sha], [sha, "c".repeat(40)], [sha, null]]) {
    const result = run(want!, actual);
    assert.match(result, /RUN \/s\/v5-go-cache-contract\.mjs\nrc=1/);
    assert.doesNotMatch(result, /经用户批准跳过|RUN .*stop-before-start/);
  }
  const approved = run(sha, sha);
  assert.match(approved, /RUN \/s\/v5-user-contract-smoke\.mjs/);
  assert.match(approved, /经用户批准跳过，原因是 Go 无额度/);
  assert.match(approved, /RUN \/s\/v5-stop-before-start-contract\.mjs\nrc=0/);
  assert.doesNotMatch(approved, /RUN .*go-cache/);
  const smokeFailed = run(sha, sha, 1);
  assert.match(smokeFailed, /rc=1/);
  assert.doesNotMatch(smokeFailed, /经用户批准跳过|RUN .*stop-before-start/);
  assert.match(run(sha, sha, 0, 1, 1), /RUN \/s\/v5-stop-before-start-contract\.mjs\nrc=1/);
});
