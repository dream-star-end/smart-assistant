import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_PROFILE_GUARD_REFUSED, BoxProfileDiscoveryError, boxProfileUsable, makeBoxProfileDiscover, makeBoxProfileGuard, makeBoxProfilePrepare,
  parseBoxProfileDiscovery } from "./boxProfileDiscovery.js";

/** Runs the real Box script against a temp tree standing in for /home/box. */
function onFakeHome<T>(setup: (home: string) => void, run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "box-profiles-"));
  try { setup(home); return run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function exec(request: { command: string; args: string[] }, home: string): string {
  const args = request.args.map((arg) => arg.replaceAll("/home/box", home));
  return execFileSync("python3", args, { encoding: "utf8" });
}
const account = (mail: string, uuid: string) => JSON.stringify({ oauthAccount: { emailAddress: mail,
  accountUuid: uuid, organizationType: "claude_pro" }, secretLookingCache: "must-not-leave" });

test("discovery lists logins with masked identity, the projects mode and no secrets", () => {
  const out = onFakeHome((home) => {
    mkdirSync(`${home}/.claude/projects`, { recursive: true });
    writeFileSync(`${home}/.claude/.credentials.json`, "{\"token\":\"SECRET-DEFAULT\"}");
    writeFileSync(`${home}/.claude.json`, account("alice.example@mail.example.com", "uuid-a"));
    mkdirSync(`${home}/.claude-b`);
    writeFileSync(`${home}/.claude-b/.credentials.json`, "{\"token\":\"SECRET-B\"}");
    writeFileSync(`${home}/.claude-b/.claude.json`, account("bob@x.io", "uuid-b"));
    symlinkSync(`${home}/.claude/projects`, `${home}/.claude-b/projects`);
    mkdirSync(`${home}/.claude-own/projects`, { recursive: true });         // someone's own sessions
    writeFileSync(`${home}/.claude-own/.credentials.json`, "{}");
    writeFileSync(`${home}/.claude-own/.claude.json`, account("carol@x.io", "uuid-c"));
    mkdirSync(`${home}/.claude-new`);                                     // dir created, not logged in yet
    mkdirSync(`${home}/.claude-default`);                                 // refused alias
    mkdirSync(`${home}/.claudex`);                                        // not a profile
    writeFileSync(`${home}/.claude-file`, "x");
  }, (home) => exec(makeBoxProfileDiscover(), home));
  assert.ok(!out.includes("SECRET"), "credential contents never printed");
  assert.ok(!out.includes("must-not-leave"));
  assert.ok(!out.includes("alice.example") && !out.includes("bob@"), "email is masked in the Box");
  const found = parseBoxProfileDiscovery(out);
  const by = Object.fromEntries(found.map((item) => [item.profile, item]));
  assert.deepEqual(Object.keys(by).sort(), ["b", "default", "new", "own"]);
  assert.deepEqual([by.default!.loginState, by.default!.projectsMode, by.default!.emailHint], ["logged_in", "root", "a***@m***.com"]);
  assert.deepEqual([by.b!.loginState, by.b!.projectsMode, by.b!.orgType], ["logged_in", "shared", "claude_pro"]);
  assert.deepEqual([by.own!.loginState, by.own!.projectsMode], ["logged_in", "own"]);
  assert.deepEqual([by.new!.loginState, by.new!.projectsMode, by.new!.emailHint], ["logged_out", "absent", null]);
  assert.notEqual(by.default!.accountFingerprint, by.b!.accountFingerprint);
  assert.deepEqual(found.filter(boxProfileUsable).map((item) => item.profile).sort(), ["b", "default"],
    "a dir with its own projects, or not logged in, can never be enabled");
});

test("prepare links only an absent projects dir to the shared root and never touches a real one", () => {
  onFakeHome((home) => {
    mkdirSync(`${home}/.claude/projects`, { recursive: true });
    mkdirSync(`${home}/.claude-new`);
    mkdirSync(`${home}/.claude-own/projects`, { recursive: true });
    writeFileSync(`${home}/.claude-own/projects/keep.txt`, "mine");
  }, (home) => {
    assert.equal(exec(makeBoxProfilePrepare("new"), home).trim(), "ready");
    assert.equal(readlinkSync(`${home}/.claude-new/projects`), `${home}/.claude/projects`);
    assert.equal(exec(makeBoxProfilePrepare("new"), home).trim(), "ready", "idempotent");
    assert.throws(() => exec(makeBoxProfilePrepare("own"), home));
    assert.ok(lstatSync(`${home}/.claude-own/projects`).isDirectory(), "real projects dir untouched");
  });
  assert.throws(() => makeBoxProfilePrepare("default"), BoxProfileDiscoveryError);
  assert.throws(() => makeBoxProfilePrepare("../x"), BoxProfileDiscoveryError);
});

test("the guard accepts only a logged-in login that still shares the projects dir", () => {
  const run = (home: string) => { try { return exec(makeBoxProfileGuard("b"), home).trim(); } catch (e) { return `exit ${(e as { status?: number }).status}`; } };
  const base = (home: string) => {
    mkdirSync(`${home}/.claude/projects`, { recursive: true });
    mkdirSync(`${home}/.claude-b`);
    writeFileSync(`${home}/.claude-b/.credentials.json`, "{}");
    symlinkSync(`${home}/.claude/projects`, `${home}/.claude-b/projects`);
  };
  assert.equal(onFakeHome(base, run), "ok");
  assert.equal(onFakeHome((h) => { base(h); rmSync(`${h}/.claude-b/projects`); mkdirSync(`${h}/.claude-b/projects`); }, run), `exit ${BOX_PROFILE_GUARD_REFUSED}`,
    "projects replaced by a real directory");
  assert.equal(onFakeHome((h) => { base(h); rmSync(`${h}/.claude-b/.credentials.json`); }, run), `exit ${BOX_PROFILE_GUARD_REFUSED}`, "logged out");
  assert.equal(onFakeHome((h) => { base(h); rmSync(`${h}/.claude-b/projects`); symlinkSync("/tmp", `${h}/.claude-b/projects`); }, run), `exit ${BOX_PROFILE_GUARD_REFUSED}`,
    "projects pointed elsewhere");
  assert.equal(onFakeHome((h) => { base(h); rmSync(`${h}/.claude-b`, { recursive: true }); symlinkSync("/tmp", `${h}/.claude-b`); }, run), `exit ${BOX_PROFILE_GUARD_REFUSED}`,
    "profile directory swapped for a symlink");
  assert.equal(onFakeHome((h) => { base(h); rmSync(`${h}/.claude`, { recursive: true }); }, run), `exit ${BOX_PROFILE_GUARD_REFUSED}`, "shared root gone");
  assert.throws(() => makeBoxProfileGuard("default"), BoxProfileDiscoveryError);
});

test("prepare never follows a profile directory that is a symlink", () => {
  onFakeHome((home) => {
    mkdirSync(`${home}/.claude/projects`, { recursive: true });
    mkdirSync(`${home}/elsewhere`);
    symlinkSync(`${home}/elsewhere`, `${home}/.claude-swap`);
  }, (home) => {
    assert.throws(() => exec(makeBoxProfilePrepare("swap"), home));
    assert.equal(lstatSync(`${home}/elsewhere`).isDirectory(), true);
    assert.throws(() => lstatSync(`${home}/elsewhere/projects`), "nothing was created through the swapped link");
  });
});

test("parse rejects anything outside the allowlist", () => {
  const ok = { dir: ".claude-b", login: true, projects: "shared", email: "a***@b***.com", fp: "0123456789ab", org: null };
  assert.equal(parseBoxProfileDiscovery(JSON.stringify([ok])).length, 1);
  for (const bad of [{ ...ok, dir: ".claude-default" }, { ...ok, projects: "weird" }, { ...ok, fp: "xyz" },
    { ...ok, email: "x".repeat(200) }, { ...ok, email: "alice@example.com" }, { ...ok, email: "al***@b***.com" }, { ...ok, login: "yes" }, { ...ok, dir: "../.claude" }]) {
    assert.throws(() => parseBoxProfileDiscovery(JSON.stringify([bad])), BoxProfileDiscoveryError);
  }
  assert.throws(() => parseBoxProfileDiscovery("not json"), BoxProfileDiscoveryError);
  assert.throws(() => parseBoxProfileDiscovery(JSON.stringify([ok, ok])), BoxProfileDiscoveryError);
});
