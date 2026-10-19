#!/usr/bin/env python3
# Source-bound production resume adapter regression fixture.
# No deploy main, network or host DB is used.
import errno
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "policy_fixture", SCRIPTS / "__tests__/v5LeasePolicyAcceptance.test.py")
fmod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fmod)
POLICY = Path(os.environ.get("P521_RESUME_POLICY_SOURCE",
                             SCRIPTS / "lib/v5-selfhost-release-policy.sh"))
CALLER = Path(os.environ.get("P521_RESUME_CALLER_SOURCE",
                             SCRIPTS / "deploy-v5-selfhost.sh"))


def source_functions(destination):
    # Existing train-recovery test's extraction boundary; no copied function.
    lines = CALLER.read_text().splitlines(keepends=True)
    out = []
    for name in ["lease_train_load_lib", "proc_starttime_of",
                 "survivor_state_phase", "lease_train_finish",
                 "egress_live_release_has_slots"]:
        starts = [i for i, line in enumerate(lines)
                  if line.startswith(name + "() {")]
        fmod.need(len(starts) == 1, "exact source function " + name)
        start = starts[0]
        end = next(i for i in range(start + 1, len(lines))
                   if lines[i].rstrip() == "}")
        out.extend(lines[start:end + 1])
        out.append("\n")
    destination.write_text("".join(out))


BASH = r"""
set -Eeuo pipefail
SCRIPT_DIR="$1"; POLICY_SOURCE="$2"; CALLER_FUNCTIONS="$3"
source "$SCRIPT_DIR/v5-lease-lib.sh"
source "$POLICY_SOURCE"
source "$CALLER_FUNCTIONS"
LEASE_LIB="$SCRIPT_DIR/v5-lease-lib.sh"
LEASE_TRAIN_ID="$P521_TRAIN"
LEASE_TARGET_SHA="$P521_SHA"
LEASE_TRAIN_ACTIVE=0
SELFHOST_DEPLOY_LOCK="$OC_V5_SELFHOST_DEPLOY_LOCK"
MASTER_LIVE_LINK="$OC_V5_LEASE_LIVE_LINK"
SURVIVOR_STATE="$OC_V5_LEASE_SURVIVOR_STATE"
V5_ENV="$P521_ENV"
OC_HOTCFG_PLATFORM_ROOT="$P521_PLATFORM"
V5_PORT=18790
V5_UNIT=fixture-master.service
V5_EGRESS_UNIT=fixture-egress.service
V5_EGRESS_SLOT_SERVICE_TPL=openclaude-v5-selfhost-egress@.service
V5_EGRESS_SLOT_SOCKET_TPL=openclaude-v5-selfhost-egress@.socket
exec 8>"$SELFHOST_DEPLOY_LOCK"
flock -x 8
# Negative tripwires, not successful policy/gate stubs. A forbidden call exits
# before doing work and makes the case fail. No paid decision is fabricated.
set -T
trap 'case "$BASH_COMMAND" in
  cutover_gate_against_release\ *|cutover_smoke_against_release\ *)
    printf "paid-gate\n" >>"$P521_FORBIDDEN"; exit 97 ;;
  oc_hotcfg_history_append\ *|release_policy_history_status*)
    printf "history\n" >>"$P521_FORBIDDEN"; exit 97 ;;
  sync_boot_scripts_from\ *|sync_watch_from\ *|install_watch_file\ *|release_policy_original_finalizer\ *|release_policy_finalize_forward\ *|assert_master_release_static_gate\ *)
    printf "install-or-full-recovery\n" >>"$P521_FORBIDDEN"; exit 97 ;;
  atomic_flip_live_symlink\ *|egress_slot_flip_then_master_restart*)
    printf "serving-mutation\n" >>"$P521_FORBIDDEN"; exit 97 ;;
esac' DEBUG
rc=0
release_policy_recover_forward || rc=$?
exit "$rc"
"""

SYSTEMCTL = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
with open(os.environ["P521_SYSTEMCTL_READS"],"a") as f:f.write(json.dumps(args)+"\n")
pids=json.loads(Path(os.environ["P521_PROCESS_MAP"]).read_text())
if len(args)==2 and args[0]=="is-active" and args[1] in pids:
 print("active");sys.exit(0)
if len(args)==5 and args[0]=="show" and args[1] in pids and args[2:]==["-p","MainPID","--value"]:
 print(pids[args[1]]);sys.exit(0)
sys.exit(98)
'''


def persistent_bytes(f):
    # Persistent DB/WAL bytes; transient SQLite reader-lock SHM is excluded.
    return {str(p.name): p.read_bytes() if p.exists() else None
            for p in [f.db, Path(str(f.db) + "-wal")]}


def adapter_environment(f, serving):
    platform = f.root / "platform"
    platform.mkdir()
    (platform / "current").symlink_to("bundles/target")
    envfile = f.root / "tuple.env"
    # Match shared fixture's exact None versus empty tuple semantics.
    envfile.write_text("OC_RUNTIME_IMAGE_ID=\nOC_RUNTIME_RELEASE=/fixture/runtime\nOC_PLATFORM_BUNDLE=\n")
    bindir = f.root / "bin"
    bindir.mkdir()
    (bindir / "systemctl").write_text(SYSTEMCTL)
    (bindir / "systemctl").chmod(0o755)
    forbidden = f.root / "forbidden.calls"; forbidden.touch()
    reads = f.root / "systemctl.reads"; reads.touch()
    fnfile = f.root / "caller.functions.sh"
    source_functions(fnfile)
    procs = [subprocess.Popen(["sleep", "60"], cwd=serving,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
             for _ in range(2)]
    process_map = f.root / "process-map.json"
    process_map.write_text(json.dumps(dict(zip(
        ["fixture-master.service", "fixture-egress.service"],
        [p.pid for p in procs]))))
    env = dict(f.env, PATH=str(bindir) + os.pathsep + os.environ["PATH"],
               P521_TRAIN=fmod.TRAIN, P521_SHA=f.sha,
               P521_ENV=str(envfile), P521_PLATFORM=str(platform),
               P521_FORBIDDEN=str(forbidden), P521_SYSTEMCTL_READS=str(reads),
               P521_PROCESS_MAP=str(process_map))
    return env, fnfile, procs, forbidden, reads


def run_adapter(f, serving):
    env, fnfile, procs, forbidden, reads = adapter_environment(f, serving)
    try:
        result = subprocess.run(["bash", "-c", BASH, "fixture", str(SCRIPTS),
                                 str(POLICY), str(fnfile)], env=env,
                                capture_output=True, text=True, timeout=20)
        return result, forbidden.read_text(), [
            json.loads(x) for x in reads.read_text().splitlines()]
    finally:
        for p in procs:
            p.terminate()  # Only these owned sandbox sleep processes.
        for p in procs:
            p.wait(timeout=5)


def stale_archive_before_claim(root, repo, shas):
    f = fmod.Fixture(root, repo, shas)
    f.sql("UPDATE train SET finished_at=?,reason=? WHERE id=?",
          (fmod.STAMP, "original accepted", fmod.TRAIN))
    serving = f.advance()
    with sqlite3.connect(f.db) as con:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    before_rows, before_bytes = f.snapshot(), persistent_bytes(f)
    archive_before = f.archive.read_bytes()
    result, forbidden, _ = run_adapter(f, serving)
    fmod.need(result.returncode == 79, "stale archive must refuse as79")
    fmod.need(f.snapshot() == before_rows,
              "stale refusal changed any DB/event/outbox/lease row")
    fmod.need(persistent_bytes(f) == before_bytes,
              "stale refusal changed persistent DB/WAL bytes")
    fmod.need(f.archive.read_bytes() == archive_before,
              "stale refusal changed archive bytes")
    fmod.need(not f.active.exists() and forbidden == "",
              "stale refusal wrote context or called forbidden path")


def archived_plus_active_is_metadata_only(root, repo, shas):
    f = fmod.Fixture(root, repo, shas, accepted=False)
    fmod.policy.checkpoint(f.active, fmod.TRAIN, {"phase": "repairing"})
    unlink = Path.unlink
    def interrupt_before_unlink(path, *args, **kwargs):
        if path == f.active:
            raise OSError(errno.EINTR, "fixture crash boundary before active unlink")
        return unlink(path, *args, **kwargs)
    # Exact real helper boundary: durable archive exists, active unlink fails.
    # No fabricated archive/decision: shared fixture + actual helper are used.
    with mock.patch.object(Path, "unlink", interrupt_before_unlink):
        try:
            fmod.policy.resolve(f.active, fmod.TRAIN, "forward")
        except OSError as e:
            fmod.need(e.errno == errno.EINTR, "wrong seed fault")
        else:
            raise AssertionError("real resolve missed active-unlink boundary")
    fmod.need(f.active.exists() and f.archive.exists(),
              "real resolve did not leave both files")
    archive_before = f.archive.read_bytes()
    lease_before = f.sql("SELECT * FROM lease ORDER BY seq")
    result, forbidden, reads = run_adapter(f, f.target)
    fmod.need(result.returncode == 0, "exact dual-file replay did not finish")
    fmod.need(forbidden == "",
              "replay called paid/append/install/full-recovery or pointer path")
    fmod.need(not f.active.exists() and f.archive.read_bytes() == archive_before,
              "replay did not remove only active and preserve verified archive")
    fmod.need(f.sql("SELECT * FROM lease ORDER BY seq") == lease_before,
              "replay altered lease callbacks/result")
    fmod.need(f.sql("SELECT status,target_sha FROM train WHERE id=?",
                   (fmod.TRAIN,)) == [("committed", f.sha)],
              "replay did not finish original exact train committed")
    fmod.need(f.sql("SELECT count(*) FROM train")[0][0] == 1,
              "replay created another operation")
    fmod.need({a[1] for a in reads if a[0] == "show"} ==
              {"fixture-master.service", "fixture-egress.service"},
              "real stack/process probe was bypassed")


def main():
    with tempfile.TemporaryDirectory(prefix="ocv5-521-resume-adapter-") as name:
        root = Path(name)
        repo, shas = fmod.git_fixture(root)
        stale_archive_before_claim(root / "stale", repo, shas)
        archived_plus_active_is_metadata_only(root / "both", repo, shas)
    print("PASS actual resume adapter stale/dual-file regression cases")


if __name__ == "__main__":
    main()
