/** Release-gate proof: the failure record keeps the first safe interactive reason. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function proveBoxInteractiveReason(candidate: string): string {
  const directory = join(candidate, "scripts/ocv5-289");
  const result = spawnSync("/usr/bin/python3", ["-I", "-m", "unittest",
    "test_box_keeper.KeeperTest.test_failure_record_keeps_the_first_safe_interactive_reason",
    "test_box_keeper.KeeperTest.test_failure_record_omits_an_unsafe_reason_line"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      OCV5_KEEPER_UNDER_TEST: join(directory, "box_keeper.py"),
    },
  });
  if (result.error || result.status !== 0 || !/\nOK\s*$/.test(result.stderr ?? "")) {
    throw new Error(`INTERACTIVE_REASON_PROOF: ${result.error?.message ?? (result.stderr ?? "").slice(-2000)}`);
  }
  return "[ocv5-box-interactive-reason] PASS — the failure record keeps the first safe BOX_INTERACTIVE reason and drops paths and emails";
}
