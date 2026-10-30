import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Real kernel children, pidfds and ECHILD; no model or production account. */
export function proveKeeperOwnedChildren(candidate: string): string {
  const directory = join(candidate, "scripts/ocv5-289");
  for (const test of ["test_box_keeper.py", "test_box_keeper_children.py"]) {
    const result = spawnSync("/usr/bin/python3", ["-I", join(directory, test)], {
      cwd: candidate,
      env: { ...process.env, OCV5_KEEPER_UNDER_TEST: join(directory, "box_keeper.py") },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !/Ran [1-9]\d* tests?/.test(result.stderr)
      || !/\nOK\s*$/.test(result.stderr) || /skipped=/i.test(result.stderr)) {
      throw new Error(`KEEPER_OWNED_CHILD_PROOF_${test}: ${
        result.error?.message ?? result.stderr.slice(-4000)}`);
    }
  }
  return "[ocv5-664-keeper-owned-children] PASS — kernel-owned escaped descendants are pidfd-fenced and actually reaped; foreign identities, missing ownership or capability, and incomplete reaping never prove completion";
}
