#!/usr/bin/env python3
"""Exercise the real dispatch_train body with isolated command/SQL fixtures."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[2]
WORKER = PROJECT / "scripts/v5-lease-worker.sh"
SHA = "1234567890abcdef1234567890abcdef12345678"
TRAIN = "tr-20261102T000000Z-fixture"


def dispatch_body():
    lines = WORKER.read_text().splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if line.rstrip() == "dispatch_train() {")
    end = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip() == "}")
    return "".join(lines[start:end + 1])


STUBS = r'''
set -euo pipefail
RESOURCE=deploy:selfhost
ACTOR=fixture-worker
LEASE_REPO_ROOT="$FIXTURE_ROOT/repo"
LEASE_BRANCH=feat/v5-selfhost
LEASE_DEPLOY_LOCK="$FIXTURE_ROOT/locks/deploy.lock"
WORKER_LOG_DIR="$FIXTURE_ROOT/train-logs"
LEASE_DB="$FIXTURE_ROOT/never-opened.db"
DEPLOY_BIN="$FIXTURE_ROOT/never-executed-deploy"
DRY=0
INVOCATION_ID=fixture-invocation

wlog() { printf '%s\n' "$*" >>"$FIXTURE_ROOT/worker.log"; }
lease_release_policy_held() { [[ "$SCENARIO" == release-policy-held ]]; }
lease_deploy_process_running() { return 1; }
lease_in_cutover_grace() { return 1; }
lease_remote_tip() { printf '%s\n' "$FIXTURE_SHA"; }
lease_sha_contained() { [[ "$1" == "$FIXTURE_SHA" && "$2" == "$FIXTURE_SHA" ]]; }
lease_new_id() { [[ "$1" == tr ]]; printf '%s\n' "$FIXTURE_TRAIN"; }
lease_now() { printf '2026-11-02 00:00:00\n'; }
lease_q() { printf '%s' "$1"; }
lease_policy_views_sql() { printf '%s\n' '-- fixture policy views'; }
lease_policy_bind_sql() { printf '%s\n' '-- fixture policy bind'; }
lease_inflight_bind_sql() { printf '%s\n' '-- fixture inflight bind'; }
lease_event_sql() { printf '%s\n' '-- fixture event'; }
lease_inflight_train_allowed() { [[ "$SCENARIO" == authorized-inflight ]]; }
prewarm_quiesce() { [[ "$1" == "$LEASE_DEPLOY_LOCK" ]]; }
flock() { [[ "$SCENARIO" != held-flock ]]; }

lease_sql() {
  local query="${!#}"
  printf '%s\n' "$query" >>"$FIXTURE_ROOT/queries.sql"
  case "$query" in
    *"SELECT COUNT(*) FROM lease"*) printf '1\n' ;;
    *"SELECT id FROM train"*)
      if [[ "$SCENARIO" == open-train ]]; then printf 'tr-already-open\n'; fi ;;
    *"SELECT id FROM lease"*"status='granted'"*)
      if [[ "$SCENARIO" == held-lease ]]; then printf 'lease-already-granted\n'; fi ;;
    *"SELECT want_sha FROM lease"*) printf '%s\n' "$FIXTURE_SHA" ;;
    *"SELECT t.id,t.finished_at"*) : ;;
    *) printf 'unimplemented SQL fixture\n' >&2; return 91 ;;
  esac
}

lease_tx() {
  local line
  printf '%s\n' '-- fixture transaction' >>"$FIXTURE_ROOT/transactions.sql"
  while IFS= read -r line; do printf '%s\n' "$line" >>"$FIXTURE_ROOT/transactions.sql"; done
}

finish_train() { printf '%s\0' "$@" >>"$FIXTURE_ROOT/finish.args"; }

git() {
  printf '%s\0' "$@" >>"$FIXTURE_ROOT/git.args"
  case "$*" in
    *" fetch -q origin feat/v5-selfhost") return 0 ;;
    *" rev-parse HEAD") printf '%s\n' "$FIXTURE_SHA" ;;
    *) printf 'unimplemented git fixture\n' >&2; return 92 ;;
  esac
}

systemctl() {
  printf '%s\0' "$@" >>"$FIXTURE_ROOT/systemctl.args"
  [[ "$*" == "show -p MainPID --value oc-v5-lease-train-${FIXTURE_TRAIN#tr-}.service" ]] || return 93
  printf '424242\n'
}

dirname() { printf '%s\n' "${1%/*}"; }
mkdir() {
  [[ "$1" == -p ]] || return 94
  shift
  local path
  for path in "$@"; do
    [[ "$path" == "$FIXTURE_ROOT/"* ]] || return 94
    /bin/mkdir -p "$path"
  done
}

# Any unexpected fallback, signal, network, database or waiting command fails.
kill() { printf 'forbidden fixture signal\n' >&2; return 95; }
pkill() { return 95; }
setsid() { return 95; }
nohup() { return 95; }
sleep() { return 95; }
docker() { return 95; }
sqlite3() { return 95; }
ssh() { return 95; }
curl() { return 95; }
sudo() { return 95; }
'''


class DispatchTrainTests(unittest.TestCase):
    def dispatch(self, scenario="success"):
        temporary = tempfile.TemporaryDirectory(prefix=".train-cgroup-test-", dir=PROJECT)
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        binary = root / "bin"
        binary.mkdir()
        command = binary / "systemd-run"
        command.write_text("#!/bin/bash\nprintf '%s\\0' \"$@\" >>\"$FIXTURE_ROOT/systemd-run.args\"\nexit \"$START_RC\"\n")
        command.chmod(0o700)
        env = {"PATH": str(binary), "HOME": str(root), "FIXTURE_ROOT": str(root),
               "FIXTURE_SHA": SHA, "FIXTURE_TRAIN": TRAIN, "SCENARIO": scenario,
               "START_RC": "17" if scenario == "start-failed" else "0"}
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c",
                                 STUBS + "\n" + dispatch_body() + "\ndispatch_train\n"],
                                cwd=root, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

        def arguments(name):
            path = root / name
            return [item.decode() for item in path.read_bytes().split(b"\0") if item] if path.exists() else []

        sql = root / "transactions.sql"
        return {"root": root, "argv": arguments("systemd-run.args"),
                "finish": arguments("finish.args"), "systemctl": arguments("systemctl.args"),
                "transactions": sql.read_text() if sql.exists() else ""}

    def test_real_dispatch_starts_independent_unit_with_frozen_cleanup_contract(self):
        result = self.dispatch()
        args = result["argv"]
        self.assertIn("--unit=oc-v5-lease-train-20261102T000000Z-fixture", args)
        self.assertIn("--collect", args)
        self.assertNotIn("--scope", args)
        properties = dict(item[len("--property="):].split("=", 1)
                          for item in args if item.startswith("--property="))
        expected = {"KillMode": "mixed", "ExitType": "main", "RemainAfterExit": "no",
                    "SendSIGKILL": "yes", "FinalKillSignal": "SIGKILL", "TimeoutStopSec": "35min"}
        for key, value in expected.items():
            self.assertEqual(properties[key], value)
        self.assertEqual(set(properties), set(expected) | {"StandardOutput", "StandardError"})
        self.assertNotIn("--allow-inflight", args)
        self.assertIn("--deploy", args)
        self.assertIn("--lease-train=" + TRAIN, args)
        self.assertIn("--target-sha=" + SHA, args)
        self.assertIn(str(result["root"] / "never-executed-deploy"), args)
        self.assertFalse((result["root"] / "never-executed-deploy").exists())
        self.assertFalse((result["root"] / "never-opened.db").exists())
        self.assertIn("executor_pid=424242, status='building'", result["transactions"])
        self.assertEqual(result["finish"], [])

    def test_start_failure_finishes_failed_without_claiming_building(self):
        result = self.dispatch("start-failed")
        self.assertTrue(result["argv"])
        self.assertEqual(result["finish"][0:2], [TRAIN, "failed"])
        self.assertEqual(result["finish"][-1], "{}")
        self.assertIn("'planned'", result["transactions"])
        self.assertNotIn("status='building'", result["transactions"])
        self.assertNotIn("UPDATE train SET executor_pid", result["transactions"])
        self.assertEqual(result["systemctl"], [])

    def test_existing_open_train_or_granted_lease_never_spawns(self):
        for scenario in ("open-train", "held-lease", "release-policy-held", "held-flock"):
            with self.subTest(scenario=scenario):
                result = self.dispatch(scenario)
                self.assertEqual(result["argv"], [])
                self.assertEqual(result["transactions"], "")
                self.assertEqual(result["finish"], [])
                self.assertEqual(result["systemctl"], [])

    def test_existing_explicit_inflight_authorization_is_still_required(self):
        result = self.dispatch("authorized-inflight")
        self.assertEqual(result["argv"].count("--allow-inflight"), 1)


if __name__ == "__main__":
    unittest.main()
