#!/usr/bin/env python3
"""Real no-model keeper proof fixture; must itself run as a private PID1."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def echild() -> bool:
    try:
        os.waitpid(-1, os.WNOHANG)
        return False
    except ChildProcessError:
        return True


def cleanup_fixture() -> bool:
    """Separate post-observation hygiene; never counts as keeper evidence."""
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if echild():
            return True
        for token in Path("/proc/self/task/1/children").read_text().split():
            fd = None
            try:
                fd = os.pidfd_open(int(token), 0)
                os.waitid(os.P_PIDFD, fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        time.sleep(.01)
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keeper", required=True, type=Path)
    parser.add_argument("--outer-namespace", required=True)
    parser.add_argument("--scenario", choices=("escaped", "nested", "term-fork",
                        "late-stop", "missed-child", "worker-failed"), required=True)
    parser.add_argument("--expect", choices=("complete", "unproven", "failed"), required=True)
    args = parser.parse_args()
    assert os.getpid() == 1, "fixture must be private PID1"
    namespace = os.readlink("/proc/self/ns/pid")
    assert namespace != args.outer_namespace, "host PID namespace is not a fixture"
    keeper = args.keeper.resolve(strict=True)
    supervisor = Path(__file__).with_name("box_supervisor.py").read_bytes()
    nonce, epoch = secrets.token_hex(12), secrets.token_hex(16)
    supervisor += ("\n# private-pid1-" + nonce + "\n").encode()
    staged = Path("/tmp/ocv5-289-supervisor-" + hashlib.sha256(supervisor).hexdigest()[:16] + ".py")
    staged.write_bytes(supervisor)
    staged.chmod(0o600)
    proof = Path("/tmp/ocv5-289-proof-" + nonce)
    scratch = Path(tempfile.mkdtemp(prefix="ocv5-664-pid1-"))
    primary = '''import os,signal,time,subprocess
from pathlib import Path
mode=os.environ['FIXTURE_SCENARIO']
def term(sig,frame):
    if mode=='term-fork':
        pid=os.fork()
        if pid==0:
            os.setsid()
            signal.signal(signal.SIGTERM,signal.SIG_DFL)
            Path(os.environ['FIXTURE_GRANDCHILD']).write_text(str(os.getpid()))
            while True:time.sleep(.1)
    Path(os.environ['FIXTURE_CLEANING']).write_text('term')
    if mode=='late-stop':
        while True:time.sleep(.1)
    os._exit(0)
if mode in ('term-fork','late-stop'):signal.signal(signal.SIGTERM,term)
if mode=='nested':
    p=subprocess.Popen(['/usr/bin/sleep','30'],start_new_session=True,
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    Path(os.environ['FIXTURE_GRANDCHILD']).write_text(str(p.pid))
Path(os.environ['FIXTURE_READY']).write_text('ready')
while True:time.sleep(.1)
'''
    cli = '''import os,sys,time,subprocess
from pathlib import Path
p=subprocess.Popen([sys.executable,'-c',os.environ['FIXTURE_PRIMARY']],
    start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
until=time.monotonic()+3
while not Path(os.environ['FIXTURE_READY']).exists():
    if time.monotonic()>until:sys.exit(9)
    time.sleep(.002)
Path(os.environ['FIXTURE_PID']).write_text(str(p.pid))
print('keeper-fixture',flush=True)
sys.exit(7 if os.environ['FIXTURE_SCENARIO']=='worker-failed' else 0)
'''
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(scratch),
           "FIXTURE_PRIMARY": primary, "FIXTURE_SCENARIO": args.scenario,
           **{"FIXTURE_" + key: str(scratch / key.lower())
              for key in ("READY", "PID", "GRANDCHILD", "CLEANING")}}
    command = [sys.executable, "-I", str(keeper), str(staged), "--deadline", "8",
               "--kill-after", ".1", "--max-output", "262144",
               "--proof-dir", str(proof), "--lease-epoch", epoch,
               "--", sys.executable, "-c", cli]
    if args.scenario == "missed-child":
        wrapper = ("import runpy,sys;p=sys.argv.pop(1);m=runpy.run_path(p);"
                   "m['stop_owned_children'].__globals__['owned_children']=lambda:[];"
                   "sys.argv[0]=p;sys.exit(m['main']())")
        command = [sys.executable, "-I", "-c", wrapper, *command[2:]]
    proc = None
    began = time.monotonic()
    try:
        proc = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if args.scenario == "late-stop":
            until = time.monotonic() + 5
            while not (scratch / "cleaning").exists():
                assert time.monotonic() < until, "owned-child TERM never observed"
                time.sleep(.002)
            proc.terminate()  # Only after W0 and the keeper's cleanup signal.
        out, err = proc.communicate(timeout=12)
        marker = json.loads((proof / "terminal.json").read_text()) if (proof / "terminal.json").exists() else None
        all_reaped = echild()
        record = {"scenario": args.scenario, "namespace": namespace,
                  "keeperSha256": hashlib.sha256(keeper.read_bytes()).hexdigest(),
                  "keeperExit": proc.returncode, "marker": marker,
                  "allReapedBeforeFixtureCleanup": all_reaped,
                  "elapsed": time.monotonic() - began, "stdout": out.decode(),
                  "stderrBytes": len(err)}
        print(json.dumps(record), flush=True)
        assert out == b"keeper-fixture\n" and not err
        if args.expect == "unproven":
            assert proc.returncode == 125 and marker is None and not all_reaped
        else:
            assert proc.returncode == (7 if args.expect == "failed" else 0), record
            assert all_reaped, "keeper left a live child or zombie before fixture cleanup"
            assert marker and marker["runNonce"] == nonce and marker["leaseEpoch"] == epoch
            assert marker["keeperPid"] == proc.pid
            assert marker["reason"] == ("worker_failed" if args.expect == "failed" else "worker_complete")
            if args.expect == "failed":
                assert marker["workerExitCode"] == 7
            if args.scenario in ("nested", "term-fork"):
                assert (scratch / "grandchild").exists(), "fixture never created the nested escaped child"
    finally:
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=3)
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    stream.close()
        cleaned = cleanup_fixture()
        print(json.dumps({"fixtureCleanupECHILD": cleaned}), flush=True)
        staged.unlink(missing_ok=True)
        shutil.rmtree(proof, ignore_errors=True)
        shutil.rmtree(scratch)
        assert cleaned, "fixture leaked its own processes"


if __name__ == "__main__":
    main()
