import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ci-same-tree-evidence.sh')
const SHA = 'a'.repeat(40)
const P1 = 'b'.repeat(40)
const P2 = 'c'.repeat(40)
const TREE = '1'.repeat(40)
const OTHER = '2'.repeat(40)

// 假 gh:`gh api <url> [--jq expr]` 按 URL 返回 fixture JSON(--jq 交给真 jq);
// `gh run download <id> -R r -n ci-tested-tree -D dir` 按 artifacts[id] 写 dir/tree。FAKE_GH_FAIL=1 → 一律失败。
function fixture(responses: Record<string, unknown>, artifacts: Record<string, string> = {}, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'same-tree-'))
  const bin = path.join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses))
  writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify(artifacts))
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
[[ "\${FAKE_GH_FAIL:-0}" == 1 ]] && exit 1
if [[ "$1" == run && "$2" == download ]]; then
  rid="$3"; dest=""; name=""
  shift 3
  while [[ $# -gt 0 ]]; do case "$1" in -D) dest="$2"; shift 2;; -n) name="$2"; shift 2;; *) shift;; esac; done
  [[ "$name" == ci-tested-tree ]] || exit 1
  tree="$(jq -r --arg r "$rid" '.[$r] // empty' "${dir}/artifacts.json")"
  [[ -n "$tree" ]] || exit 1
  mkdir -p "$dest"; printf '%s\\n' "$tree" > "$dest/tree"; exit 0
fi
url="$2"; jqexpr=""
[[ "\${3:-}" == "--jq" ]] && jqexpr="$4"
body="$(jq -c --arg u "$url" '.[$u] // empty' "${dir}/responses.json")"
[[ -n "$body" ]] || exit 1
if [[ -n "$jqexpr" ]]; then jq -r "$jqexpr" <<<"$body"; else printf '%s\\n' "$body"; fi
`,
  )
  chmodSync(path.join(bin, 'gh'), 0o755)
  const out = path.join(dir, 'gh-output')
  writeFileSync(out, '')
  const run = (sha = SHA) =>
    spawnSync('bash', [script, sha], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_REPO: 'o/r', GITHUB_OUTPUT: out, ...extraEnv },
    })
  return { run, output: () => readFileSync(out, 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const runs = (head: string, list: Array<{ status: string; conclusion: string | null; created_at: string; id: number }>) => ({
  [`repos/o/r/actions/workflows/v5-ci.yml/runs?head_sha=${head}&event=pull_request&per_page=50`]: { workflow_runs: list },
})
const mergeOf = (parents: string[], trees: Record<string, string>) => ({
  [`repos/o/r/git/commits/${SHA}`]: { tree: { sha: TREE }, parents: parents.map((sha) => ({ sha })) },
  ...Object.fromEntries(Object.entries(trees).map(([sha, tree]) => [`repos/o/r/git/commits/${sha}`, { tree: { sha: tree } }])),
})

test('PR head has the merge tree, its latest PR run is green, and that run tested exactly this tree → skip=true', () => {
  const fx = fixture(
    {
      ...mergeOf([P1, P2], { [P1]: OTHER, [P2]: TREE }),
      ...runs(P2, [
        { status: 'completed', conclusion: 'failure', created_at: '2026-10-08T01:00:00Z', id: 1 },
        { status: 'completed', conclusion: 'success', created_at: '2026-10-08T02:00:00Z', id: 2 },
      ]),
    },
    { '2': TREE },
  )
  try {
    const r = fx.run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(fx.output(), 'skip=true\n', r.stdout)
  } finally {
    fx.cleanup()
  }
})

test('green PR run whose tested merge-preview tree differs (base moved after the run) → skip=false', () => {
  const fx = fixture(
    { ...mergeOf([P2], { [P2]: TREE }), ...runs(P2, [{ status: 'completed', conclusion: 'success', created_at: '2026-10-08T02:00:00Z', id: 7 }]) },
    { '7': OTHER },
  )
  try {
    fx.run()
    assert.equal(fx.output(), 'skip=false\n')
  } finally {
    fx.cleanup()
  }
})

test('green PR run without a ci-tested-tree artifact (runs from before this mechanism) → skip=false', () => {
  const fx = fixture({ ...mergeOf([P2], { [P2]: TREE }), ...runs(P2, [{ status: 'completed', conclusion: 'success', created_at: '2026-10-08T02:00:00Z', id: 9 }]) })
  try {
    fx.run()
    assert.equal(fx.output(), 'skip=false\n')
  } finally {
    fx.cleanup()
  }
})

test('different tree (base moved: the semantic-conflict case push CI exists for) → skip=false', () => {
  const fx = fixture({ ...mergeOf([P1, P2], { [P1]: OTHER, [P2]: OTHER }) })
  try {
    fx.run()
    assert.equal(fx.output(), 'skip=false\n')
  } finally {
    fx.cleanup()
  }
})

test('same tree but the LATEST PR run is red, cancelled or still running → skip=false', () => {
  for (const latest of [
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'cancelled' },
    { status: 'in_progress', conclusion: null },
  ]) {
    const fx = fixture(
      {
        ...mergeOf([P2], { [P2]: TREE }),
        ...runs(P2, [
          { status: 'completed', conclusion: 'success', created_at: '2026-10-08T01:00:00Z', id: 1 },
          { ...latest, created_at: '2026-10-08T02:00:00Z', id: 2 },
        ]),
      },
      { '1': TREE, '2': TREE },
    )
    try {
      fx.run()
      assert.equal(fx.output(), 'skip=false\n', JSON.stringify(latest))
    } finally {
      fx.cleanup()
    }
  }
})

test('same tree but no pull_request run at all (direct push) → skip=false', () => {
  const fx = fixture({ ...mergeOf([P2], { [P2]: TREE }), ...runs(P2, []) })
  try {
    fx.run()
    assert.equal(fx.output(), 'skip=false\n')
  } finally {
    fx.cleanup()
  }
})

test('any API failure or bad input fails open to a full run (skip=false), never errors the job', () => {
  const failing = fixture({}, {}, { FAKE_GH_FAIL: '1' })
  try {
    const r = failing.run()
    assert.equal(r.status, 0)
    assert.equal(failing.output(), 'skip=false\n')
  } finally {
    failing.cleanup()
  }
  const bad = fixture({})
  try {
    const r = bad.run('not-a-sha')
    assert.equal(r.status, 0)
    assert.equal(bad.output(), 'skip=false\n')
  } finally {
    bad.cleanup()
  }
})
