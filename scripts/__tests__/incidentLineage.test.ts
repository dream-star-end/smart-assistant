import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exactCherryPicksInHead, inHeadLineage } from "../lib/lineage.ts";

const repo = mkdtempSync(join(tmpdir(), "incident-lineage-"));
after(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}
function commit(file: string, body: string, message: string): string {
  writeFileSync(join(repo, file), body);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

git("init", "-q", "-b", "selfhost");
commit("a.txt", "base\n", "base");
git("checkout", "-q", "-b", "commercial");
const fix = commit("fix.txt", "fixed\n", "fix: the bug");
const other = commit("other.txt", "x\n", "commercial only");
const conflicted = commit("c.txt", "one\n", "fix: another bug");
git("checkout", "-q", "selfhost");
git("cherry-pick", "-x", fix);
git("cherry-pick", "-x", "--no-commit", conflicted);
writeFileSync(join(repo, "c.txt"), "one, resolved differently\n");
git("add", "c.txt");
git("commit", "-q", "-m", `fix: another bug\n\n(cherry picked from commit ${git("rev-parse", conflicted)})`);
commit("d.txt", "y\n", `fake\n\n(cherry picked from commit ${other})`);

test("an ancestor is in the lineage", () => {
  git("checkout", "-q", "commercial");
  assert.equal(inHeadLineage(repo, fix.slice(0, 8)), true);
  git("checkout", "-q", "selfhost");
});

test("an exact cherry-pick -x on the other tree counts", () => {
  assert.equal(inHeadLineage(repo, fix.slice(0, 8)), true);
  assert.equal(exactCherryPicksInHead(repo, fix).length, 1);
});

test("a cherry-pick whose patch changed in conflict resolution does not count", () => {
  assert.equal(inHeadLineage(repo, conflicted.slice(0, 8)), false);
});

test("a commit that only claims to be a cherry-pick (different patch) does not count", () => {
  assert.equal(inHeadLineage(repo, other.slice(0, 8)), false);
});

test("an unknown commit is not in the lineage", () => {
  assert.equal(inHeadLineage(repo, "deadbeef"), false);
});
