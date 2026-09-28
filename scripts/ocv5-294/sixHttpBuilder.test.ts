import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFinalFromFifthResult, chainCountOk, decideRun, verifyFinal,
  type RunFacts } from "./sixHttpBuilder.ts";

const root = dirname(fileURLToPath(import.meta.url));

test("builder output follows the fifth result, and a constant mutant fails", () => {
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  assert.equal(buildFinalFromFifthResult(a), a);
  assert.equal(buildFinalFromFifthResult(b), b);
  const constant = () => a;
  assert.equal(verifyFinal(constant(), b), false);
  assert.equal(verifyFinal(buildFinalFromFifthResult(b), b), true);
});

test("counts fail closed for five or seven HTTP rounds", () => {
  assert.equal(chainCountOk(6, 5, 5), true);
  assert.equal(chainCountOk(5, 5, 5), false);
  assert.equal(chainCountOk(7, 5, 5), false);
  const ok: RunFacts = { http: 6, toolUses: 5, mcpOk: 5, mcpRejected: false,
    cliExit: 0, cliFinal: "b".repeat(32), expectedNonce: "b".repeat(32),
    verifyStatus: 0, toolsExact: true };
  assert.equal(decideRun(ok), null);
  assert.equal(decideRun({ ...ok, http: 5 }), "COUNT");
  assert.equal(decideRun({ ...ok, http: 7 }), "COUNT");
  assert.equal(decideRun({ ...ok, cliFinal: "a".repeat(32) }), "CLI_NONCE_MISMATCH");
  const constant = () => "a".repeat(32);
  assert.equal(decideRun({ ...ok, cliFinal: constant(), expectedNonce: "b".repeat(32) }),
    "CLI_NONCE_MISMATCH");
});

function drive(paths: string[], calls: string[]): Promise<{ code: number; out: string; log: string }> {
  const dir = dirname(paths[0]!);
  const allow = join(dir, "allow.json");
  const log = join(dir, "log.jsonl");
  writeFileSync(allow, JSON.stringify({ paths }));
  writeFileSync(log, "");
  const child = spawn(process.execPath, [join(root, "readLinkMcp.mjs"), allow, log],
    { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", () => undefined);
  calls.forEach((path, index) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0",
    id: index + 1, method: "tools/call",
    params: { name: "read_link", arguments: { path } } }) + "\n"));
  child.stdin.end();
  return new Promise((resolve) => {
    child.once("close", (code) => resolve({ code: code ?? 1, out,
      log: readFileSync(log, "utf8") }));
  });
}

test("the MCP server rejects an out-of-order path and does not clear the failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-six-"));
  const paths = [1, 2, 3, 4, 5].map((n) => join(dir, `f${n}.txt`));
  for (const path of paths) writeFileSync(path, "x");
  const result = await drive(paths, [paths[1]!]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /isError":true/);
  assert.match(result.log, /out-of-order/);
});

test("an illegal path latches, so a later allowlisted read still fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-six-"));
  const paths = [1, 2, 3, 4, 5].map((n) => join(dir, `f${n}.txt`));
  for (const path of paths) writeFileSync(path, "x");
  const result = await drive(paths, [join(dir, "missing.txt"), paths[0]!]);
  assert.notEqual(result.code, 0);
  assert.match(result.log, /illegal-path/);
  assert.match(result.log, /latched/);
  assert.equal(result.out.split("isError\":true").length - 1, 2);
});

test("reading the fifth file on the third call is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-six-"));
  const paths = [1, 2, 3, 4, 5].map((n) => join(dir, `f${n}.txt`));
  for (const path of paths) writeFileSync(path, `body-${path}`);
  const result = await drive(paths, [paths[0]!, paths[1]!, paths[4]!]);
  assert.notEqual(result.code, 0);
  assert.match(result.log, /out-of-order/);
  assert.doesNotMatch(result.log, /"seq":5/);
});

test("five in-order reads exit zero and log each file hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-six-"));
  const paths = [1, 2, 3, 4, 5].map((n) => join(dir, `f${n}.txt`));
  for (const path of paths) writeFileSync(path, `body-${path}`);
  const result = await drive(paths, paths);
  assert.equal(result.code, 0);
  assert.equal(result.log.split("\n").filter((line) => line.includes("\"ok\":true")).length, 5);
});
