#!/usr/bin/env bash
# INC-20261113-CODEX-LATE-STOP-CLOSURE: actual relay, node children and ToolHost.
# Called only on the official deploy's pinned, unsealed build candidate.
set -euo pipefail
NODE="$(command -v node)"
BUN="$(command -v bun || true)"
[[ -n "$BUN" ]] || BUN="$HOME/.bun/bin/bun"
[[ -x "$BUN" ]] || { echo 'Codex late-stop proof: Bun unavailable' >&2; exit 1; }
exec /usr/bin/python3 -I - "$PWD" "$NODE" "$BUN" "${BUN_INSTALL_CACHE_DIR:-$HOME/.bun/install/cache}" <<'PYPROOF'
import importlib.util
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

root, node, bun, bun_cache = sys.argv[1:]
spec = importlib.util.spec_from_file_location('proof_children', Path(root) / 'scripts/ocv5-289/box_keeper.py')
keeper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keeper)
if not keeper.prctl(keeper.PR_SET_CHILD_SUBREAPER, 1):
    raise RuntimeError('Codex proof subreaper unavailable')

def interrupted(signum, frame):
    raise RuntimeError('Codex proof interrupted')

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, interrupted)

# Build + both real tests share one fixed budget; cleanup has the keeper's own bound.
deadline = time.monotonic() + 180
base = 'a node that refuses the thread unload fences the lane and closes the undispatched admission'
cases = [base, base + ' after a late local stop proof']
with tempfile.TemporaryDirectory(prefix='oc-codex-stop-proof-') as home:
    env = {'PATH': str(Path(bun).parent) + ':' + str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'HOME': home, 'OPENCLAUDE_HOME': home,
           'CLAUDE_CONFIG_DIR': home + '/.claude', 'CI': 'true', 'OC_BUN_BIN': bun,
           'TMPDIR': home, 'BUN_INSTALL_CACHE_DIR': bun_cache}

    def run(command):
        print('[codex-late-stop-proof] stage=' + command[0], flush=True)
        with tempfile.TemporaryFile() as output:
            child = subprocess.Popen(command, cwd=root, env=env, stdout=output,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            code = None
            try:
                while True:
                    status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    if status is not None:
                        code = status.si_status if status.si_code == os.CLD_EXITED else 128 + status.si_status
                        break
                    if time.monotonic() >= deadline:
                        output.seek(0)
                        sys.stderr.write(output.read().decode('utf-8', errors='replace')[-4000:])
                        raise RuntimeError('Codex late-stop proof exceeded 180s')
                    time.sleep(.05)
            finally:
                # Keep the unreaped leader until the final group signal. Detached
                # ToolHost supervisors/children are adopted and reaped via pidfd.
                stopped = keeper.stop_adopted_group(child.pid)
                child.returncode = code if code is not None else 124
                reaped = keeper.reap_adopted_after_last_signal()
                if not stopped or not reaped:
                    raise RuntimeError('Codex proof child cleanup unproved')
            output.seek(0)
            text = output.read().decode('utf-8', errors='replace')
            if code != 0:
                # Only the synthetic test output exists in this allowlisted environment.
                sys.stderr.write(text[-12000:])
                raise RuntimeError('Codex proof command failed: ' + str(code))
            return text

    # Existing official builder copies source + shared inputs into its own isolated
    # build and returns only freshly built dist. Never consume a checkout/live bundle.
    run(['bash', '-c', 'source scripts/v5-runtime-release-lib.sh; oc_hotcfg_build_ccb_dist "$PWD" ""'])
    tap = run([node, '--import', 'tsx', '--test', '--test-reporter=tap',
               '--test-name-pattern=^' + re.escape(base) + '( after a late local stop proof)?$',
               'packages/gateway/src/__tests__/codexRemoteAdapterE2E.test.ts'])
    leaves = re.findall(r'^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$', tap, re.MULTILINE)
    for name in cases:
        hits = [(bad, skipped) for bad, title, skipped in leaves if title == name]
        if hits != [('', '')]:
            raise RuntimeError('Codex proof missing, failed, duplicate or skipped case: ' + name)
    if any(bad for bad, title, skipped in leaves):
        raise RuntimeError('Codex proof has a failed test')
    for name in cases:
        print('[codex-late-stop-proof] PASS — ' + name)
PYPROOF
