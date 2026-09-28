import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { makeBoxStagedCatalogRead } from "./boxStagedCatalogRead.js";

test("catalog read script rejects symlink, loose mode and bad utf-8", () => {
  const nonce = randomBytes(12).toString("hex");
  const request = makeBoxStagedCatalogRead(nonce);
  const syntax = spawnSync("python3", ["-c", "import ast,sys;ast.parse(sys.stdin.read())"],
    { input: request.args[2], encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const run = `/tmp/ocv5-289-run-${nonce}`;
  mkdirSync(run, { mode: 0o700 });
  const script = request.args[2]!;
  const runScript = () => spawnSync(request.command, ["-I", "-c", script, nonce],
    { encoding: "utf8" });
  try {
    writeFileSync(`${run}/tool-catalog.json`, "{\"tools\":[]}");
    chmodSync(`${run}/tool-catalog.json`, 0o644);
    assert.notEqual(runScript().status, 0);
    rmSync(`${run}/tool-catalog.json`);
    symlinkSync("/etc/passwd", `${run}/tool-catalog.json`);
    assert.notEqual(runScript().status, 0);
    rmSync(`${run}/tool-catalog.json`);
    writeFileSync(`${run}/tool-catalog.json`, Buffer.from([0xff, 0xfe]));
    chmodSync(`${run}/tool-catalog.json`, 0o600);
    assert.notEqual(runScript().status, 0);
    assert.throws(() => makeBoxStagedCatalogRead("not-a-nonce"));
  } finally { rmSync(run, { recursive: true, force: true }); }
});
