import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, constants, existsSync, mkdirSync, openSync, readFileSync,
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

test("terminal private cleanup can retain only the native project transcript", () => {
  const f = fixture();
  const root = `/tmp/ocv5-291-projects-${randomBytes(8).toString("hex")}`;
  const project = `${root}/${f.cwd.replaceAll("/", "-")}`;
  const transcript = `${project}/12345678-1234-4123-8123-123456789abc.jsonl`;
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(transcript, "synthetic native history\n", { mode: 0o600 });
  writeFileSync(`${f.cwd}/stdout.jsonl`, "private model output", { mode: 0o600 });
  writeFileSync(`${f.cwd}/stderr.log`, "private stderr", { mode: 0o600 });
  writeFileSync(`${f.cwd}/stdin.jsonl`, "private current user", { mode: 0o600 });
  const run = (preserve: boolean) => {
    const request = makeBoxRunCleanup(f.nonce, preserve);
    const script = request.args[2]!.replace("/home/box/.claude/projects/", `${root}/`);
    return spawnSync(request.command, ["-I", "-c", script, ...request.args.slice(3)],
      { cwd: request.cwd, env: { ...process.env, ...request.environment },
        encoding: "utf8", timeout: 5000 });
  };
  try {
    const kept = run(true);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(existsSync(`${f.cwd}/stdin.jsonl`), false);
    assert.equal(readFileSync(`${f.cwd}/stdout.jsonl`).length, 0);
    assert.equal(readFileSync(transcript, "utf8"), "synthetic native history\n");
    const removed = run(false);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(transcript), false);
  } finally { f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("OCV5-509 the CLI auto-memory folder in a run project is cleaned, anything else still refused", () => {
  const f = fixture();
  const root = `/tmp/ocv5-509-projects-${randomBytes(8).toString("hex")}`;
  const project = `${root}/${f.cwd.replaceAll("/", "-")}`;
  const run = () => {
    const request = makeBoxRunCleanup(f.nonce, false);
    const script = request.args[2]!.replace("/home/box/.claude/projects/", `${root}/`);
    return spawnSync(request.command, ["-I", "-c", script, ...request.args.slice(3)],
      { cwd: request.cwd, env: { ...process.env, ...request.environment },
        encoding: "utf8", timeout: 5000 });
  };
  try {
    mkdirSync(`${project}/memory`, { recursive: true, mode: 0o700 });
    chmodSync(`${project}/memory`, 0o755);
    writeFileSync(`${project}/12345678-1234-4123-8123-123456789abc.jsonl`, "history\n", { mode: 0o600 });
    writeFileSync(`${project}/memory/MEMORY.md`, "private memory\n", { mode: 0o644 });
    writeFileSync(`${f.cwd}/stdout.jsonl`, "private model output", { mode: 0o600 });
    writeFileSync(`${f.cwd}/stderr.log`, "private stderr", { mode: 0o600 });
    const cleaned = run();
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(`${project}/memory`), false);
    assert.equal(existsSync(`${project}/12345678-1234-4123-8123-123456789abc.jsonl`), false);
    assert.equal(run().status, 0, "idempotent");
    // only Markdown files: a nested folder or a link is not the CLI's and stays refused
    mkdirSync(`${project}/memory/nested`, { recursive: true });
    assert.equal(run().status, 126);
    assert.equal(existsSync(`${project}/memory/nested`), true);
  } finally { f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("OCV5-645 a session tool-results tree in a run project is cleaned, anything else under it still refused", () => {
  const f = fixture();
  const root = `/tmp/ocv5-645-projects-${randomBytes(8).toString("hex")}`;
  const project = `${root}/${f.cwd.replaceAll("/", "-")}`;
  const sid = "12345678-1234-4123-8123-123456789abc";
  const run = () => {
    const request = makeBoxRunCleanup(f.nonce, false);
    const script = request.args[2]!.replace("/home/box/.claude/projects/", `${root}/`);
    return spawnSync(request.command, ["-I", "-c", script, ...request.args.slice(3)],
      { cwd: request.cwd, env: { ...process.env, ...request.environment },
        encoding: "utf8", timeout: 5000 });
  };
  const build = (extra: (tree: string) => void) => {
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(`${project}/${sid}.jsonl`, "history\n", { mode: 0o600 });
    // the exact tree Claude Code 2.1.288 writes for a large or image tool result
    mkdirSync(`${project}/${sid}/tool-results`, { recursive: true, mode: 0o755 });
    writeFileSync(`${project}/${sid}/tool-results/mcp-image-1.png`, "png", { mode: 0o644 });
    writeFileSync(`${project}/${sid}/tool-results/toolu_A.txt`, "private 50k result", { mode: 0o644 });
    extra(`${project}/${sid}/tool-results`);
  };
  try {
    writeFileSync(`${f.cwd}/stdout.jsonl`, "private model output", { mode: 0o600 });
    writeFileSync(`${f.cwd}/stderr.log`, "private stderr", { mode: 0o600 });
    build(() => {});
    const cleaned = run();
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(cleaned.stdout.trim(), "clean");
    assert.equal(existsSync(`${project}/${sid}`), false);
    assert.equal(existsSync(`${project}/${sid}.jsonl`), false);
    assert.equal(run().status, 0, "idempotent");
    // a nested folder, a link, or a sibling of tool-results is not the CLI's: refused, nothing removed
    for (const bad of [
      (tree: string) => mkdirSync(`${tree}/nested`),
      (tree: string) => symlinkSync(`${root}/decoy`, `${tree}/link.png`),
      (tree: string) => mkdirSync(`${tree}/../other`),
    ]) {
      build(bad);
      assert.equal(run().status, 126);
      assert.equal(existsSync(`${project}/${sid}/tool-results/mcp-image-1.png`), true);
      assert.equal(existsSync(`${project}/${sid}.jsonl`), true);
    }
  } finally { f.close(); rmSync(root, { recursive: true, force: true }); }
});
