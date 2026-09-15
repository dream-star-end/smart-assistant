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
    if negative:
        name = 'scripts/lib/delegate-consumer-artifacts.py'
        source = (root / name).read_text()
        before = "require(labels['oc.runtime.embed_source'] == '1')"
        assert source.count(before) == 1
        changed = base64.b64encode(source.replace(before, 'pass # virtual removal of baked source guard').encode()).decode()
        anchor = '\ntry:\n    for filename, encoded in OC206_ARTIFACT_FILES.items():'
        assert prefix.count(anchor) == 1
        prefix = prefix.replace(anchor, '\nOC206_ARTIFACT_FILES[' + repr(name) + ']=' + repr(changed) + '\n' + anchor)
    body = (root / 'scripts/__tests__/fixtures/delegateConsumerEmbeddedWriters.fixture.py').read_text()
    return prefix + '\n' + textwrap.indent(body, '    ') + cleanup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True)
    parser.add_argument('--negative-control', action='store_true')
    args = parser.parse_args()
    result = subprocess.run(['host', 'python3 -'], input=payload(Path(__file__).resolve().parents[2], args.negative_control),
                            text=True, timeout=200)
    raise SystemExit(result.returncode)
