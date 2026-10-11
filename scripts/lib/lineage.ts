// Incident ledger lineage: is a recorded fix commit part of HEAD? (OCV5-376)
//
// The two V5 trees (selfhost feat/v5-selfhost, commercial feat/v5-aurora-rewrite) port fixes to
// each other with `git cherry-pick -x`. The ledger records the commit that landed first, so on the
// other tree it is not an ancestor even though the same change is in HEAD. A commit counts as in
// HEAD's lineage when it is an ancestor, or when HEAD contains a commit whose message says
// "(cherry picked from commit <full sha>)" AND whose `git patch-id --stable` equals the original's,
// i.e. the change is line-for-line identical. A cherry-pick whose conflict resolution changed the
// patch does not count.
import { execFileSync } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024;

function git(root: string, args: string[], input?: Buffer): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_BUFFER, input }).trim();
}

export function isAncestorOf(root: string, sha: string, head = "HEAD"): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, head], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function patchId(root: string, rev: string): string {
  const diff = execFileSync("git", ["show", "--format=", rev], { cwd: root, maxBuffer: MAX_BUFFER });
  if (diff.length === 0) return "";
  return git(root, ["patch-id", "--stable"], diff).split(" ")[0] ?? "";
}

/** HEAD commits that are an exact `cherry-pick -x` of `sha`. */
export function exactCherryPicksInHead(root: string, sha: string, head = "HEAD"): string[] {
  const full = git(root, ["rev-parse", `${sha}^{commit}`]);
  const candidates = git(root, ["log", "--format=%H", "-F", `--grep=(cherry picked from commit ${full})`, head])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) return [];
  const original = patchId(root, full);
  if (original === "") return [];
  return candidates.filter((candidate) => patchId(root, candidate) === original);
}

/** Recorded lineage commit is an ancestor of HEAD, or HEAD carries an exact cherry-pick of it. */
export function inHeadLineage(root: string, sha: string, head = "HEAD"): boolean {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    return false;
  }
  return isAncestorOf(root, sha, head) || exactCherryPicksInHead(root, sha, head).length > 0;
}
