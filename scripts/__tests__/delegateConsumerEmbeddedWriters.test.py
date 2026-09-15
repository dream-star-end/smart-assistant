#!/usr/bin/env python3
"""Baked writer labels/immutable ID/original Git/B0 through real preflight."""
import argparse
import base64
import importlib.util
from pathlib import Path
import subprocess
import textwrap


def payload(root, negative=False):
    spec = importlib.util.spec_from_file_location('writer_fixture', root / 'scripts/__tests__/delegateConsumerWriters.test.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    full = helper.payload(root)
    prefix, _ = full.split('\n    safe()\n    projected =', 1)
    cleanup = full[full.rindex('\nexcept BaseException as exc:\n    error ='):]
    cleanup = cleanup.replace("len(out['cases']) == 11", "len(out['cases']) == 13")
    if negative:
        name = ('scripts/delegate-consumer-preflight.py' if negative == 'layer'
                else 'scripts/lib/delegate-consumer-artifacts.py')
        source = (root / name).read_text()
        before = ('_writer_layer_unchanged(writer, deadline)' if negative == 'layer'
                  else "require(labels['oc.runtime.embed_source'] == '1')")
        # Do not mutate the function definition; both actual call sites must be
        # removed so the same production business assertion sees the fault.
        if negative == 'layer':
            before = '        ' + before
        assert source.count(before) == (2 if negative == 'layer' else 1)
        replacement = '        pass # virtual removal of actual layer checks' if negative == 'layer' else 'pass # virtual removal of baked source guard'
        changed = base64.b64encode(source.replace(before, replacement).encode()).decode()
        anchor = '\ntry:\n    for filename, encoded in OC206_ARTIFACT_FILES.items():'
        assert prefix.count(anchor) == 1
        prefix = prefix.replace(anchor, '\nOC206_ARTIFACT_FILES[' + repr(name) + ']=' + repr(changed) + '\n' + anchor)
    body = (root / 'scripts/__tests__/fixtures/delegateConsumerEmbeddedWriters.fixture.py').read_text()
    return prefix + '\n' + textwrap.indent(body, '    ') + cleanup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True)
    parser.add_argument('--negative-control', choices=('label', 'layer'), nargs='?', const='label')
    args = parser.parse_args()
    result = subprocess.run(['host', 'python3 -'], input=payload(Path(__file__).resolve().parents[2], args.negative_control),
                            text=True, timeout=200)
    raise SystemExit(result.returncode)
