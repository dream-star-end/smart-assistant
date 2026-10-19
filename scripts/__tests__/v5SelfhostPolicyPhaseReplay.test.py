#!/usr/bin/env python3
"""Actual keep_failed -> exact archive resume -> reader and ride regression.
All state, real SQLite, process observations and injected faults use owned
fixture roots. No production dispatch, paid gates or service mutations run.
"""
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("actual_resume_fixture", SCRIPTS / "__tests__/v5SelfhostPolicyResume.test.py")
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)
shared = resume.fmod


def shell_with_tail(tail):
    # Reuse only existing sandbox harness setup/tripwires, never production body
    # replacements. Fail if its unique final invocation changes.
    anchor = 'rc=0\nrelease_policy_recover_forward || rc=$?\nexit "$rc"\n'
    shared.need(resume.BASH.count(anchor) == 1, "unique actual-resume harness tail")
    return resume.BASH.replace(anchor, tail)


PREKEEP = r'''
release_policy_resume_claim || exit "$?"
# Simulate the genuine pre-resolve point using the real guarded terminal write:
# the verified archive is seeded by the real foundation helper, not hand JSON.
lease_train_finish committed "fixture exact accepted archive; cleanup pending" || exit "$?"
[[ "$LEASE_TRAIN_ACTIVE" == 0 ]] || exit 90
rc=0
release_policy_keep_failed "$P521_LIVE" finalization 79 || rc=$?
[[ "$rc" == 79 && "$(survivor_state_phase)" == kept-failed ]] || exit 90
[[ -f "$RELEASE_POLICY_CONTEXT" ]] || exit 90
exit 0
'''


def actual_call(env, functions, text):
    return subprocess.run(["bash", "-c", text, "fixture", str(SCRIPTS),
                           str(resume.POLICY), str(functions)], env=env,
                          capture_output=True, text=True, timeout=25)


def seed_exact_dual_file(f):
    shared.policy.checkpoint(f.active, shared.TRAIN, {"phase": "repairing"})
    unlink = Path.unlink
    def fail_active(path, *args, **kwargs):
        if path == f.active:
            raise OSError(errno.EINTR, "fixture active unlink acknowledgement")
        return unlink(path, *args, **kwargs)
    with mock.patch.object(Path, "unlink", fail_active):
        try:
            shared.policy.resolve(f.active, shared.TRAIN, "forward")
        except OSError as exc:
            shared.need(exc.errno == errno.EINTR, "exact unlink seed fault")
        else:
            raise AssertionError("actual resolve missed active unlink")
    shared.need(f.active.is_file() and f.archive.is_file(), "real dual-file seed")


def phase(path):
    if not path.is_file():
        return "non-file"
    return next((line.split("=", 1)[1] for line in path.read_text().splitlines()
                 if line.startswith("phase=")), "missing")


def chain(root, repo, shas, broken_state=False):
    f = shared.Fixture(root, repo, shas, accepted=False)
    seed_exact_dual_file(f)
    state = Path(f.env["OC_V5_LEASE_SURVIVOR_STATE"])
    state.write_text("phase=committed\nexecutor_pid=0\nbackup_dir=" + str(root / "backup") +
                     "\narmed_at=" + shared.STAMP + "\n")
    Path(f.env["OC_V5_LEASE_SURVIVOR_COMMITTED"]).write_text("committed_at=" + shared.STAMP + "\n")
    archive_before = f.archive.read_bytes()
    env, functions, procs, forbidden, reads = resume.adapter_environment(f, f.target)
    survivor = root / "survivor.sh"
    survivor.write_bytes((SCRIPTS / "v5-selfhost-cutover-survivor.sh").read_bytes())
    survivor.chmod(0o755)
    env.update(CUTOVER_SURVIVOR_SCRIPT=str(survivor), P521_LIVE=str(f.target),
               V5_WATCH_DIR=str(root / "empty-watch"))
    try:
        held = actual_call(env, functions, shell_with_tail(PREKEEP))
        shared.need(held.returncode == 0, "actual keep_failed chain seed")
        shared.need(phase(state) == "kept-failed", "real keep_failed did not persist phase")
        shared.need(f.active.is_file() and f.archive.read_bytes() == archive_before,
                    "keep_failed changed exact archive or active barrier")
        if broken_state:
            state.rename(root / "saved-state")
            state.mkdir()  # Local metadata fault only, no phase success stub.
        result = actual_call(env, functions, resume.BASH)
        if broken_state:
            shared.need(result.returncode == 79, "phase persistence failure must stay79")
            shared.need(f.active.is_file() and f.archive.read_bytes() == archive_before,
                        "failed receipt repair lost active/archive")
            f.probe(False)
            f.settle(False)
        else:
            shared.need(result.returncode == 0, "exact archive replay failed")
            shared.need(phase(state) == "committed", "replay left kept-failed receipt")
            shared.need(not f.active.exists() and f.archive.read_bytes() == archive_before,
                        "replay did not preserve exact archive and clear active")
            f.probe(True)  # Actual phase guard + archive verifier, no stub.
            f.settle(True)  # Actual per-ride binding + Git ancestor + SQLite/outbox.
            settled = f.snapshot()
            f.settle(True)
            shared.need(f.snapshot() == settled, "second settlement was not idempotent")
        shared.need(forbidden.read_text() == "", "replay touched paid/history/install/pointer path")
        calls = [json.loads(line) for line in reads.read_text().splitlines()]
        shared.need(all(row and row[0] in ["is-active", "show"] for row in calls),
                    "fixture attempted a service mutation")
        shared.need({row[1] for row in calls if row[0] == "show"} ==
                    {"fixture-master.service", "fixture-egress.service"},
                    "actual owned process identity probe missing")
        witness = {"phase": phase(state), "active": f.active.exists(),
                   "archive_preserved": f.archive.read_bytes() == archive_before,
                   "train": f.sql("SELECT status FROM train WHERE id=?", (shared.TRAIN,))[0][0],
                   "ride": f.sql("SELECT status FROM lease WHERE id=?", (shared.RIDE,))[0][0],
                   "outbox": f.sql("SELECT count(*) FROM outbox")[0][0]}
        print("PASS " + ("phase-repair-failure-holds" if broken_state else "keep-resume-reader-settle") +
              " witness=" + json.dumps(witness, sort_keys=True, separators=(",", ":")))
    finally:
        for process in procs:
            process.terminate()  # Only the two owned temporary sleep processes.
        for process in procs:
            process.wait(timeout=5)


def main():
    with tempfile.TemporaryDirectory(prefix="ocv5-521-phase-replay-") as name:
        root = Path(name)
        repo, shas = shared.git_fixture(root)
        chain(root / "complete-chain", repo, shas)
        chain(root / "broken-receipt", repo, shas, broken_state=True)
    print("PASS total=2 failed=0")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        check = " check=" + json.dumps(str(exc)) if isinstance(exc, AssertionError) else ""
        print("FAIL actual-phase-replay error=" + type(exc).__name__ + check)
        raise SystemExit(1)
