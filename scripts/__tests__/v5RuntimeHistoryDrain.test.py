#!/usr/bin/env python3
"""Exercise actual history readers under pipefail; no Docker, DB or production I/O."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
LIB = REPO / 'scripts/v5-runtime-release-lib.sh'


def row(seq, version=3):
    fields = [str(version), str(seq), '2026-10-19T00:00:00Z',
              'image-' + 'x' * 1024, 'sha256:fixture', '/release/' + 'y' * 1024, '/bundle']
    if version >= 2:
        fields.append('/master/' + str(seq))
    if version == 3:
        fields.extend(['joint', '/master/' + str(seq - 1)])
    result = dict(schemaVer=version, seq=seq, ts=fields[2], image=fields[3],
                  image_id=fields[4], release=fields[5], bundle=fields[6],
                  checksum=hashlib.sha256(bytes([0]).join(x.encode() for x in fields)).hexdigest())
    if version >= 2:
        result['masterRelease'] = fields[7]
    if version == 3:
        result.update(transitionKind=fields[8], previousMasterRelease=fields[9])
    return result


class RuntimeHistoryDrainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ocv5-history-drain-')
        self.root = Path(self.tmp.name)
        self.hist = self.root / 'history'
        self.calls = self.root / 'verify-calls'

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rows):
        self.hist.write_text(''.join(json.dumps(x, separators=(',', ':')) + '\n' for x in rows))

    def run_shell(self, body, *args):
        return subprocess.run(['bash', '-s', '--', str(LIB), str(self.hist), str(self.calls), *args],
                              input='set -euo pipefail\nsource "$1"\n' + body,
                              text=True, capture_output=True, timeout=30)

    def large_history(self):
        self.write([row(i) for i in range(1, 593)])
        self.assertGreater(self.hist.stat().st_size, 1024 * 1024)

    def test_large_last_and_nth_drain_without_revalidating_older_rows(self):
        self.large_history()
        body = r'''eval "$(declare -f oc_hotcfg__history_verify_line | sed '1s/oc_hotcfg__history_verify_line/fixture_verify_line/')"
VERIFY_CALLS="$3"
oc_hotcfg__history_verify_line(){ printf 'verify\n' >> "$VERIFY_CALLS"; fixture_verify_line "$1"; }
"$4" "$2" "$5"
'''
        for getter, nth, expected, count in [('oc_hotcfg_history_last_committed', '1', 592, 1),
                                             ('oc_hotcfg_history_nth_committed', '1', 592, 1),
                                             ('oc_hotcfg_history_nth_committed', '2', 591, 2)]:
            with self.subTest(getter=getter, nth=nth):
                if self.calls.exists():
                    self.calls.unlink()
                result = self.run_shell(body, getter, nth)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertEqual(json.loads(result.stdout)['seq'], expected)
                self.assertEqual(self.calls.read_text().splitlines(), ['verify'] * count)

    def test_invalid_tail_is_skipped_and_legacy_checksums_still_normalize(self):
        invalid = row(3); invalid['checksum'] = '0' * 64
        self.write([row(1, 1), row(2, 2), invalid, dict(schemaVer=99)])
        for getter, nth, seq, master in [('oc_hotcfg_history_last_committed', '1', 2, '/master/2'),
                                         ('oc_hotcfg_history_nth_committed', '2', 1, '')]:
            with self.subTest(getter=getter):
                result = self.run_shell('"$4" "$2" "$5"\n', getter, nth)
                self.assertEqual(result.returncode, 0, result.stderr)
                actual = json.loads(result.stdout)
                self.assertEqual((actual['seq'], actual['masterRelease']), (seq, master))
                self.assertEqual((actual['transitionKind'], actual['previousMasterRelease']), ('joint', ''))

    def test_missing_empty_and_invalid_only_history_return_no_record(self):
        for content in [None, '', '{not-json}\n']:
            with self.subTest(content=content):
                if self.hist.exists():
                    self.hist.unlink()
                if content is not None:
                    self.hist.write_text(content)
                for getter in ['oc_hotcfg_history_last_committed', 'oc_hotcfg_history_nth_committed']:
                    result = self.run_shell('"$4" "$2" 2\n', getter)
                    self.assertEqual((result.returncode, result.stdout), (0, ''), result.stderr)

    def test_tac_failure_after_valid_output_remains_nonzero(self):
        self.large_history()
        for getter in ['oc_hotcfg_history_last_committed', 'oc_hotcfg_history_nth_committed']:
            with self.subTest(getter=getter):
                result = self.run_shell('tac(){ command tac "$@" || return $?; return 23; }\n"$4" "$2" 1\n', getter)
                self.assertEqual(result.returncode, 23, result.stdout + result.stderr)
                self.assertEqual(json.loads(result.stdout)['seq'], 592)
                result = self.run_shell('tac(){ command tac "$1.missing"; }\n"$4" "$2" 1\n', getter)
                self.assertEqual((result.returncode, result.stdout), (1, ''), result.stderr)

    def test_append_preserves_read_failure_and_then_appends_next_sequence(self):
        self.large_history()
        before = self.hist.read_bytes()
        result = self.run_shell(r'''tac(){ command tac "$@" || return $?; return 23; }
oc_hotcfg_history_append "$2" new new-id /new /bundle /master/593 '' joint /master/592
''')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(self.hist.read_bytes(), before)
        self.assertEqual(list(self.root.glob('history.append.*')), [])
        result = self.run_shell(r'''oc_hotcfg_history_append "$2" new new-id /new /bundle /master/593 '' joint /master/592
oc_hotcfg_history_last_committed "$2"
''')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual((actual['seq'], actual['masterRelease']), (593, '/master/593'))
        after = self.hist.read_bytes()
        self.assertTrue(after.startswith(before))
        self.assertEqual(len(after.splitlines()), 593)


if __name__ == '__main__':
    unittest.main(verbosity=2)
