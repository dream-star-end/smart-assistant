import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const legacy = join(repo, 'scripts/v5-runtime-release-lib.sh');
const script = join(repo, 'scripts/lib/v5-selfhost-digest.py');

function fixture(t, temporaryRoot = tmpdir()) {
  const dir = mkdtempSync(join(temporaryRoot, 'oc-selfhost-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  writeFileSync(join(tree, 'payload.txt'), 'sealed payload\n');
  return { dir, tree };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function fast(action, tree, options) {
  return run('python3', [script, action, tree], options);
}

function oldDigest(tree) {
  const result = run('/bin/bash', ['-Eeuo', 'pipefail', '-c', `
source "$1"
oc_hotcfg__file_rows "$2" | oc_hotcfg__digest_from_rows all
`, '_', legacy, tree]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[0-9a-f]{12}\n$/);
  return result.stdout;
}

function assertEqualDigest(tree) {
  const expected = oldDigest(tree);
  const actual = fast('digest', tree);
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stdout, expected);
  return expected;
}

function seal(tree) {
  const digest = oldDigest(tree).trim();
  writeFileSync(join(tree, 'MANIFEST.json'), JSON.stringify({ digest, files: [] }));
  return `${digest}\n`;
}

function assertRejected(result) {
  assert.notEqual(result.status, 0, 'invalid tree must fail closed');
  assert.equal(result.stdout, '', 'failure must not emit a digest');
  assert.notEqual(result.stderr, '', 'failure must explain why verification failed');
}

test('digest matches the existing shell for files, modes, byte ordering, and every symlink kind', (t) => {
  const { tree } = fixture(t);
  mkdirSync(join(tree, 'nested/deeper/层级'), { recursive: true });
  mkdirSync(join(tree, 'outside-target'));
  writeFileSync(join(tree, 'nested/deeper/层级/é-中文.txt'), 'non-ASCII filename\n');
  writeFileSync(join(tree, 'nested/space name.txt'), Buffer.from([0, 1, 255, 10]));
  writeFileSync(join(tree, '-leading-dash'), 'dash\n');
  writeFileSync(join(tree, 'back\\slash.txt'), 'GNU sha256sum escapes this filename\n');
  writeFileSync(join(tree, 'z-last'), 'byte sorting\n');
  for (const [name, mode] of [['executable', 0o755], ['setuid', 0o4755], ['setgid', 0o2750], ['sticky', 0o1777]]) {
    writeFileSync(join(tree, name), name);
    chmodSync(join(tree, name), mode);
  }
  symlinkSync('payload.txt', join(tree, 'link-file'));
  symlinkSync('nested', join(tree, 'link-directory'));
  symlinkSync('missing/target', join(tree, 'link-dangling'));
  symlinkSync('.', join(tree, 'link-cycle'));
  symlinkSync('/a/target/outside/the/release', join(tree, 'link-absolute'));
  assertEqualDigest(tree);
});

test('digest preserves GNU sha256sum escaping and legacy TSV parsing for unusual filename bytes', (t) => {
  const { tree } = fixture(t);
  for (const name of ['carriage\rreturn', 'line\nbreak', 'tab\tname', '\tleading-tab', 'trailing-tab\t']) {
    writeFileSync(join(tree, name), 'filename separator fixture\n');
    assertEqualDigest(tree);
  }
  const rawPath = Buffer.concat([Buffer.from(`${tree}/`), Buffer.from([0xff, 0xfe, 0x61])]);
  writeFileSync(rawPath, 'non-UTF8 filename\n');
  assertEqualDigest(tree);
});

test('digest preserves command substitution and TSV semantics for symlink targets', (t) => {
  const { tree } = fixture(t);
  for (const [name, target] of [
    ['trailing-newlines', 'payload.txt\n\n'],
    ['target-tab', 'payload.txt\t0'],
    ['target-newline', 'first\nsecond'],
    ['target-tsv-row', 'first\nsynthetic\thash\t0\t777'],
    ['target-backslash', 'back\\slash'],
    ['target-carriage-return', 'first\rsecond'],
  ]) {
    symlinkSync(target, join(tree, name));
    assertEqualDigest(tree);
  }
});

test('only regular manifest files are excluded, at every depth', (t) => {
  const { tree } = fixture(t);
  mkdirSync(join(tree, 'nested/deep'), { recursive: true });
  const before = assertEqualDigest(tree);
  for (const dir of [tree, join(tree, 'nested'), join(tree, 'nested/deep')]) {
    writeFileSync(join(dir, 'MANIFEST.json'), 'excluded manifest');
    writeFileSync(join(dir, 'MANIFEST.json.tmp'), 'excluded temporary manifest');
  }
  assert.equal(assertEqualDigest(tree), before);
  mkdirSync(join(tree, 'directory-names/MANIFEST.json'), { recursive: true });
  writeFileSync(join(tree, 'directory-names/MANIFEST.json/included'), 'included child\n');
  const withDirectory = assertEqualDigest(tree);
  assert.notEqual(withDirectory, before, 'a directory named MANIFEST.json must still be traversed');
  mkdirSync(join(tree, 'symlink-names'));
  symlinkSync('../payload.txt', join(tree, 'symlink-names/MANIFEST.json'));
  symlinkSync('../missing', join(tree, 'symlink-names/MANIFEST.json.tmp'));
  assert.notEqual(assertEqualDigest(tree), withDirectory, 'manifest-named symlinks must be included');
});

for (const [name, mutate] of [
  ['one changed byte', (tree) => writeFileSync(join(tree, 'payload.txt'), 'Sealed payload\n')],
  ['file permissions', (tree) => chmodSync(join(tree, 'payload.txt'), 0o755)],
  ['symlink target', (tree) => {
    unlinkSync(join(tree, 'link'));
    symlinkSync('different-target', join(tree, 'link'));
  }],
]) {
  test(`verify accepts an existing shell seal and rejects ${name}`, (t) => {
    const { tree } = fixture(t);
    symlinkSync('payload.txt', join(tree, 'link'));
    const expected = seal(tree);
    const valid = fast('verify', tree);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, expected);
    mutate(tree);
    assertRejected(fast('verify', tree));
  });
}

test('verify rejects missing, malformed, empty, or mismatched manifests without printing a digest', (t) => {
  const { tree } = fixture(t);
  assertRejected(fast('verify', tree));
  for (const contents of ['{', '{}', 'null', '{"digest":null}', '{"digest":""}', '{"digest":[]}', '{"digest":"000000000000"}']) {
    writeFileSync(join(tree, 'MANIFEST.json'), contents);
    assertRejected(fast('verify', tree));
  }
});

test('digest rejects missing roots and ordinary files used as roots without printing a digest', (t) => {
  const { dir, tree } = fixture(t);
  assertRejected(fast('digest', join(dir, 'missing')));
  assertRejected(fast('digest', join(tree, 'payload.txt')));
});

test('a traversal error after entering the tree fails closed', (t) => {
  const { tree } = fixture(t);
  mkdirSync(join(tree, 'denied'));
  writeFileSync(join(tree, 'denied/child'), 'unreadable subtree');
  const result = run('python3', ['-c', `
import os, runpy, sys
from unittest.mock import patch
script, tree = sys.argv[1:]
original = os.scandir
def scandir(path):
    if os.fsencode(path) == os.fsencode(os.path.join(tree, "denied")):
        raise PermissionError("fixture traversal denied")
    return original(path)
sys.argv = [script, "digest", tree]
with patch("os.scandir", side_effect=scandir):
    runpy.run_path(script, run_name="__main__")
`, script, tree]);
  assertRejected(result);
});

test('an unreadable file fails closed even when the test runner is root', (t) => {
  const { dir, tree } = fixture(t, '/tmp');
  // Execute a temporary copy so nobody needs access through the repository's ancestors.
  const copy = join(dir, 'digest.py');
  copyFileSync(script, copy);
  chmodSync(copy, 0o644);
  chmodSync(dir, 0o755);
  chmodSync(tree, 0o755);
  chmodSync(join(tree, 'payload.txt'), 0);
  const identity = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  const result = run('python3', [copy, 'digest', tree], identity);
  assertRejected(result);
  assert.match(result.stderr, /payload\.txt/, 'must fail when reading the payload, not opening the script');
});
