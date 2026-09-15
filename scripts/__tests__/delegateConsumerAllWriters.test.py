#!/usr/bin/env python3
"""Original FD8/enroll/master stop + real private Docker writer subtree stops."""
import argparse
import base64
import importlib.util
from pathlib import Path
import subprocess
import textwrap


def payload(root, negative=False):
    spec = importlib.util.spec_from_file_location('base_quiesce', root/'scripts/__tests__/delegateConsumerQuiesce.test.py')
    base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
    full = base.payload(root)
    prefix = full.split('    for mode in OC206_QUIESCE_CASES:',1)[0]
    cleanup = full[full.rindex('\nexcept BaseException as exc:\n    error ='):]
    cleanup = cleanup.replace("except BaseException as exc:\n    error =", "except BaseException as exc:\n    import traceback; traceback.print_exc()\n    error =")
    cleanup = cleanup.replace("    cleanup_errors = []", "    cleanup_errors = []\n" + textwrap.indent((root/'scripts/__tests__/fixtures/delegateConsumerAllWritersCleanup.fixture.py').read_text(),'    '))
    init = "WRITER_CASES = ('running', 'already-exited', 'new-root')\nprivate_containers = []\nprivate_groups = []\n"
    # Only actual all-writer call is removed; same real business assertions.
    if negative:
        source = (root/'scripts/delegate-consumer-preflight.py').read_text()
        before = '            quiesce_all_writers(snapshot, state_path, owner, time.monotonic() + 30)'
        assert source.count(before)==1
        changed = source.replace(before, '            pass  # virtual missing all-writer call')
        old = base64.b64encode(source.encode()).decode(); new = base64.b64encode(changed.encode()).decode()
        assert prefix.count(old)==1; prefix=prefix.replace(old,new)
        init = init.replace("('running', 'already-exited', 'new-root')", "('running',)")
    # Init must run before any setup can fail, so cleanup always knows its exact objects.
    prefix = init + prefix
    return prefix + textwrap.indent((root/'scripts/__tests__/fixtures/delegateConsumerAllWriters.fixture.py').read_text(),'    ') + cleanup


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', action='store_true', required=True)
    p.add_argument('--negative-control', action='store_true')
    a=p.parse_args()
    result=subprocess.run(['host','python3 -'],input=payload(Path(__file__).resolve().parents[2],a.negative_control),text=True,timeout=240)
    raise SystemExit(result.returncode)
