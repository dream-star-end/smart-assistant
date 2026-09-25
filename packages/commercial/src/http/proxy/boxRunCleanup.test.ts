import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { constants, existsSync, mkdirSync, openSync, readFileSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeBoxRunCleanup } from "./boxRunCleanup.js";

function fixture() {
  const nonce = randomBytes(12).toString("hex");
  const cwd = `/tmp/ocv5-289-run-${nonce}`;
  mkdirSync(cwd, { mode: 0o700 });
  const run = () => {
    const step = makeBoxRunCleanup(nonce);
    return spawnSync(step.command, step.args, { cwd: step.cwd,
      env: { ...process.env, ...step.environment }, encoding: "utf8", timeout: 5000 });
  };
  return { nonce, cwd, run, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("known-terminal cleanup removes private files but keeps empty replay-fence spool", () => {
  const f = fixture();
  const put = (name: string, value: string) => writeFileSync(`${f.cwd}/${name}`, value,
    { mode: 0o600, flag: "wx" });
  try {
    put("stdout.jsonl", "private model output");
    put("stderr.log", "private stderr");
    put("stdin.jsonl", "private prompt");
    put("system.txt", "private system");
    put("tool-catalog.json", "private catalog");
    put("pending.toolu_A.json", "private arguments");
    put("result.toolu_A.json", "private result");
    put("result.toolu_B.json.part", "partial result");
    put("pending.toolu_C.json.12345.987654321.tmp", "interrupted private MCP write");
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), "clean");
    for (const name of ["stdin.jsonl", "system.txt", "tool-catalog.json",
      "pending.toolu_A.json", "result.toolu_A.json", "result.toolu_B.json.part",
      "pending.toolu_C.json.12345.987654321.tmp"]) {
      assert.equal(existsSync(`${f.cwd}/${name}`), false);
    }
    assert.equal(readFileSync(`${f.cwd}/stdout.jsonl`).length, 0);
    assert.equal(readFileSync(`${f.cwd}/stderr.log`).length, 0);
    assert.throws(() => openSync(`${f.cwd}/stdout.jsonl`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
    /EEXIST/, "Box detached launch still cannot recreate stdout and replay");
    const repeated = f.run();
    assert.equal(repeated.status, 0, repeated.stderr);
  } finally { f.close(); }
});

test("symlinked spool is refused without touching decoy", () => {
  const f = fixture();
  const decoy = `/tmp/ocv5-289-decoy-${randomBytes(8).toString("hex")}`;
  writeFileSync(decoy, "must-stay", { mode: 0o600, flag: "wx" });
  try {
    symlinkSync(decoy, `${f.cwd}/stdout.jsonl`);
    writeFileSync(`${f.cwd}/stderr.log`, "private", { mode: 0o600 });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(decoy, "utf8"), "must-stay");
  } finally { f.close(); rmSync(decoy, { force: true }); }
  assert.throws(() => makeBoxRunCleanup("../wrong"), /BOX_RUN_CLEANUP_ID_INVALID/);
});
