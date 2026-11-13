import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Execute the actual checker functions, not a second implementation of its rules.
// An optional source file is only for the old-checker negative-control invocation.
const source = readFileSync(
  process.env.OC_INCIDENT_COMPAT_CHECKER_SOURCE ??
    fileURLToPath(new URL('../check-v5-incident-regressions.ts', import.meta.url)),
  'utf8',
)
const ast = ts.createSourceFile(
  'checker.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
const names = ['normalizeImmutableIncidentTrailer', 'checkTrailerClosure']
const functions = ast.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && !!node.name && names.includes(node.name.text),
)
assert.equal(functions.filter((node) => node.name?.text === 'checkTrailerClosure').length, 1)
const executable = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const TARGET = 'f496228de43718852cebda8fb9f35eb0e9c3a9c0'
const ID = 'INC-20260908-CC-SWITCH-ASCII-NAME'
const OLD = 'OCV5-171 follow-up'
const CAPACITY_TARGET = '793c4f0b15928a59eaaedab3f8ba6194d1fb496a'
const CAPACITY_ID = 'INC-20261013-CODEX-CAPACITY-NOT-AVAILABLE'
const CAPACITY_OLD = 'none (user-facing copy only; no behavior change)'
const START = '1'.repeat(40)
const TIP = '2'.repeat(40)
type Row = { id: string; rootFixCommit: string; coverageCommits?: string[] }
type Waiver = { expiresAt: string; commit?: string; emergencyMissingTrailer?: boolean }
function execute(
  options: {
    sha?: string
    trailer?: string | null
    incidents?: Row[]
    waivers?: Map<string, Waiver>
    /** Commits `git rev-list TIP ^START` reports as frozen imported history (default: the tip only). */
    frozen?: string[]
  } = {},
) {
  const sha = options.sha ?? TARGET
  const trailer = options.trailer === undefined ? OLD : options.trailer
  const calls: string[] = []
  const unexpected: string[] = []
  const audit: string[] = []
  const bad = (s: string): never => {
    unexpected.push(s)
    throw new Error(`unexpected fixture call: ${s}`)
  }
  const sandbox = {
    ROOT: '/isolated-checker-fixture',
    TRAILER_GATE_MARKER: 'marker',
    IMPORTED_TRAILER_HISTORY_TIPS: [TIP],
    TRAILER_GATE_SURFACES: ['packages/web-react/'],
    manifest: { incidents: options.incidents ?? [{ id: ID, rootFixCommit: TARGET.slice(0, 8) }] },
    resolveTrailerGateStart: () => START,
    parseWaivers: () => options.waivers ?? new Map(),
    fail: (message: string): never => {
      throw new Error(`[incident-regressions] ${message}`)
    },
    process: {
      stdout: {
        write: (s: string) => {
          audit.push(s)
        },
      },
    },
    commitFiles: (commit: string) => {
      calls.push(`files:${commit}`)
      assert.equal(commit, sha)
      return ['packages/web-react/src/components/settings/ApiKeysSection.tsx']
    },
    git: (...args: string[]) => {
      const key = args.join(' ')
      calls.push(key)
      if (
        args[0] === 'cat-file' &&
        args[1] === '-e' &&
        args.length === 3 &&
        [`${START}^{commit}`, `${TIP}^{commit}`].includes(args[2]!)
      )
        return ''
      if (key === `log -1 --format=%ct ${START}`) return '100'
      // OCV5-376: the frozen-history set is one rev-list, not a merge-base per commit × tip.
      if (key === `rev-list ${TIP} ^${START}`) return (options.frozen ?? [TIP]).join('\n')
      if (key === `log --no-merges --format=%H%x1f%s%x1f%b%x1f%ct%x1e ${START}..HEAD`) {
        return `${sha}\x1ffix(v5): exact fixture\x1f${trailer === null ? 'no trailer' : `Incident: ${trailer}`}\x1f101\x1e`
      }
      return bad(`git ${key}`)
    },
    execFileSync: (cmd: string, args: string[], opts: { cwd: string }) => {
      assert.equal(cmd, 'git')
      assert.equal(opts.cwd, '/isolated-checker-fixture')
      const key = args.join(' ')
      calls.push(key)
      if (
        key === `merge-base --is-ancestor ${START} HEAD` ||
        key === `merge-base --is-ancestor ${TIP} HEAD`
      )
        return ''
      return bad(`exec ${key}`)
    },
  }
  try {
    const checked = runInNewContext(`${executable}\ncheckTrailerClosure();`, sandbox, {
      timeout: 2_000,
    }) as number
    return { checked, audit: audit.join('') }
  } finally {
    assert.deepEqual(unexpected, [], 'fixture cannot silently accept unknown git calls')
    assert.ok(
      calls.includes(`rev-list ${TIP} ^${START}`),
      'frozen imported history must be queried',
    )
    if (!(options.frozen ?? []).includes(sha)) {
      assert.ok(calls.includes(`files:${sha}`), 'target must not be skipped as imported history')
    }
  }
}

function executeCapacity(options: Parameters<typeof execute>[0] = {}) {
  return execute({
    sha: CAPACITY_TARGET,
    trailer: CAPACITY_OLD,
    incidents: [{ id: CAPACITY_ID, rootFixCommit: 'f1adc83d', coverageCommits: ['793c4f0b'] }],
    // Preserve the historical expired record: successful closure must not use it.
    waivers: new Map([['793c4f0b', { expiresAt: '2026-11-01' }]]),
    ...options,
  })
}

// Execute the real Bash conditions between their stable structural boundaries.
// Source overrides let the same behavior cases prove the old gate is red.
const bashSource = readFileSync(
  process.env.OC_INCIDENT_COMPAT_BASH_SOURCE ??
    fileURLToPath(new URL('../check-v5-fix-trailers.sh', import.meta.url)),
  'utf8',
)
const bashMarker = '  # exact immutable trailer mapping'
const bashStart = bashSource.indexOf(bashMarker)
assert.ok(
  bashStart >= 0 && bashStart === bashSource.lastIndexOf(bashMarker),
  'one actual Bash mapping block',
)
const bashEnd = bashSource.indexOf('  if [[ "$trailer" =~ ^none', bashStart)
assert.ok(bashEnd > bashStart, 'mapping block precedes the ordinary none path')
const bashMapping = bashSource.slice(bashStart, bashEnd)
function executeBashMapping(sha: string, trailer: string): string {
  return execFileSync(
    'bash',
    [
      '-c',
      `set -euo pipefail\nsha="$1"\ntrailer="$2"\n${bashMapping}\nprintf '%s' "$trailer"`,
      'exact-trailer-fixture',
      sha,
      trailer,
    ],
    { encoding: 'utf8', timeout: 2_000 },
  )
}

test('exact immutable SHA and original trailer normalize then complete incident closure', () => {
  const result = execute()
  assert.equal(result.checked, 1)
  assert.ok(result.audit.includes(TARGET))
  assert.ok(result.audit.includes(OLD))
  assert.ok(result.audit.includes(ID))
})

for (const sha of [
  TARGET.slice(0, 8),
  TARGET.slice(0, 39),
  `${TARGET.slice(0, 39)}1`,
  'a'.repeat(40),
]) {
  test(`identical old trailer on non-exact SHA remains rejected: ${sha}`, () => {
    assert.throws(() => execute({ sha }), /Incident trailer 格式非法:OCV5-171 follow-up/)
  })
}
for (const trailer of [
  'OCV5-171',
  'OCV5-171 follow-up-extra',
  'ocv5-171 follow-up',
  'OCV5-172 follow-up',
]) {
  test(`target SHA does not normalize other malformed trailer: ${trailer}`, () => {
    assert.throws(() => execute({ trailer }), /Incident trailer 格式非法/)
  })
}

test('exact mapping still rejects a missing semantic incident', () => {
  assert.throws(
    () => execute({ incidents: [] }),
    /指向的 INC-20260908-CC-SWITCH-ASCII-NAME 不在 incidents.json/,
  )
})
test('exact mapping still rejects missing rootFix and coverage lineage', () => {
  assert.throws(
    () => execute({ incidents: [{ id: ID, rootFixCommit: 'abcdef12' }] }),
    /rootFixCommit\/coverageCommits 未包含本 commit/,
  )
})
test('exact mapping honors real coverage lineage without exempting the commit', () => {
  assert.equal(
    execute({
      incidents: [{ id: ID, rootFixCommit: 'abcdef12', coverageCommits: [TARGET.slice(0, 8)] }],
    }).checked,
    1,
  )
})
test('missing trailer on the mapped SHA is not pardoned', () => {
  assert.throws(() => execute({ trailer: null }), /触碰用户可见面但缺 trailer/)
})
test('none without a waiver remains rejected', () => {
  assert.throws(() => execute({ trailer: 'none (fixture)' }), /没有对应 waiver/)
})
test('none with expired waiver remains rejected', () => {
  assert.throws(
    () =>
      execute({
        trailer: 'none (fixture)',
        waivers: new Map([[TARGET.slice(0, 8), { expiresAt: '2020-01-01' }]]),
      }),
    /已于 2020-01-01 过期/,
  )
})
test('none with a valid existing waiver preserves the ordinary path', () => {
  const r = execute({
    trailer: 'none (fixture)',
    waivers: new Map([[TARGET.slice(0, 8), { expiresAt: '2099-01-01' }]]),
  })
  assert.equal(r.checked, 1)
  assert.equal(r.audit, '')
})
test('a future ordinary legal incident still follows original closure', () => {
  const sha = 'a'.repeat(40)
  const r = execute({
    sha,
    trailer: 'INC-20260908-ORDINARY-FUTURE',
    incidents: [{ id: 'INC-20260908-ORDINARY-FUTURE', rootFixCommit: sha.slice(0, 8) }],
  })
  assert.equal(r.checked, 1)
  assert.equal(r.audit, '')
})
test('a future ordinary malformed incident remains rejected', () => {
  assert.throws(
    () => execute({ sha: 'b'.repeat(40), trailer: 'OCV5-999' }),
    /Incident trailer 格式非法:OCV5-999/,
  )
})
test("a commit inside a frozen tip's history is skipped, not judged", () => {
  const r = execute({ trailer: 'OCV5-999', frozen: [TIP, TARGET] })
  assert.equal(r.checked, 0)
})

test('793c exact immutable copy trailer closes the existing incident despite its expired historical waiver', () => {
  const result = executeCapacity()
  assert.equal(result.checked, 1)
  for (const value of [CAPACITY_TARGET, CAPACITY_OLD, CAPACITY_ID])
    assert.ok(result.audit.includes(value))
})

const capacityWrongShas = [
  CAPACITY_TARGET.slice(0, 8),
  CAPACITY_TARGET.slice(0, 39),
  `${CAPACITY_TARGET.slice(0, 39)}0`,
  'a'.repeat(40),
]
for (const sha of capacityWrongShas) {
  test(`793c old none trailer on a non-exact SHA still requires a live waiver: ${sha}`, () => {
    assert.throws(() => executeCapacity({ sha }), /没有对应 waiver|已于 2026-11-01 过期/)
  })
}
const capacityWrongTrailers = [
  'None (user-facing copy only; no behavior change)',
  'none (User-facing copy only; no behavior change)',
  'none (user-facing copy only; no behavior change.)',
  `${CAPACITY_OLD} extra`,
]
for (const trailer of capacityWrongTrailers) {
  test(`793c other trailer is not mapped: ${trailer}`, () => {
    assert.throws(
      () => executeCapacity({ trailer }),
      /Incident trailer 格式非法|已于 2026-11-01 过期/,
    )
  })
}
test('793c mapping still requires the existing semantic incident', () => {
  assert.throws(
    () => executeCapacity({ incidents: [] }),
    /指向的 INC-20261013-CODEX-CAPACITY-NOT-AVAILABLE 不在 incidents.json/,
  )
})
test('793c mapping still requires its own coverage beside the real root fix', () => {
  assert.throws(
    () => executeCapacity({ incidents: [{ id: CAPACITY_ID, rootFixCommit: 'f1adc83d' }] }),
    /rootFixCommit\/coverageCommits 未包含本 commit/,
  )
})
test('793c missing trailer is not repaired by its mapping or old waiver', () => {
  assert.throws(() => executeCapacity({ trailer: null }), /触碰用户可见面但缺 trailer/)
})
test('a future commit cannot reuse the 793c closure with its own expired waiver', () => {
  const sha = 'b'.repeat(40)
  assert.throws(
    () =>
      executeCapacity({ sha, waivers: new Map([[sha.slice(0, 8), { expiresAt: '2020-01-01' }]]) }),
    /已于 2020-01-01 过期/,
  )
})
test('793c other none reason keeps the ordinary valid and expired waiver paths', () => {
  const trailer = 'none (a different approved reason)'
  const result = executeCapacity({
    trailer,
    waivers: new Map([['793c4f0b', { expiresAt: '2099-01-01' }]]),
  })
  assert.equal(result.checked, 1)
  assert.equal(result.audit, '')
  assert.throws(() => executeCapacity({ trailer }), /已于 2026-11-01 过期/)
})

test('actual Bash mapping resolves the exact 793c SHA and original trailer', () => {
  assert.equal(executeBashMapping(CAPACITY_TARGET, CAPACITY_OLD), CAPACITY_ID)
  assert.equal(executeBashMapping(TARGET, OLD), ID, 'existing exact compatibility is preserved')
})
for (const sha of capacityWrongShas) {
  test(`actual Bash mapping leaves a non-exact 793c SHA unchanged: ${sha}`, () => {
    assert.equal(executeBashMapping(sha, CAPACITY_OLD), CAPACITY_OLD)
  })
}
for (const trailer of [...capacityWrongTrailers, 'none (a different approved reason)']) {
  test(`actual Bash mapping leaves another 793c trailer unchanged: ${trailer}`, () => {
    assert.equal(executeBashMapping(CAPACITY_TARGET, trailer), trailer)
  })
}

const GA_TARGET = '8f8d44fc2697ec7a80555f7f003b6ca64dc022b0'
const GA_ID = 'INC-20261011-GENERAL-ASSISTANT-STALE-MODEL'
const GA_OLD = 'none (preset kept a stale model; found in the OCV5-376 startup-log review)'
const LB_TARGET = '785b3e0425e9ccc1720043c501946c31abfea22b'
const LB_ID = 'INC-20261011-LAZY-TOOL-BODY-REJECT-CACHE'
const LB_OLD = 'none (latent; no user report — found during the OCV5-376 test-suite change)'

function executeOcv5376(sha: string, trailer: string, id: string, rootFix: string) {
  return execute({
    sha,
    trailer,
    incidents: [{ id, rootFixCommit: rootFix }],
    waivers: new Map([[sha.slice(0, 8), { expiresAt: '2026-11-08' }]]),
  })
}

test('OCV5-376 general-assistant exact none trailer maps despite expired waiver', () => {
  const result = executeOcv5376(GA_TARGET, GA_OLD, GA_ID, '8f8d44fc')
  assert.equal(result.checked, 1)
  for (const value of [GA_TARGET, GA_OLD, GA_ID]) assert.ok(result.audit.includes(value))
})

test('OCV5-376 lazy-tool-body exact none trailer maps despite expired waiver', () => {
  const result = executeOcv5376(LB_TARGET, LB_OLD, LB_ID, '785b3e04')
  assert.equal(result.checked, 1)
  for (const value of [LB_TARGET, LB_OLD, LB_ID]) assert.ok(result.audit.includes(value))
})

for (const sha of [GA_TARGET.slice(0, 8), `${GA_TARGET.slice(0, 39)}1`, 'a'.repeat(40)]) {
  test(`OCV5-376 GA non-exact SHA still requires a live waiver: ${sha}`, () => {
    assert.throws(
      () =>
        execute({
          sha,
          trailer: GA_OLD,
          incidents: [{ id: GA_ID, rootFixCommit: '8f8d44fc' }],
          waivers: new Map([[sha.slice(0, 8), { expiresAt: '2026-11-08' }]]),
        }),
      /已于 2026-11-08 过期/,
    )
  })
}

test('actual Bash mapping resolves OCV5-376 general-assistant SHA and trailer', () => {
  assert.equal(executeBashMapping(GA_TARGET, GA_OLD), GA_ID)
})
test('actual Bash mapping resolves OCV5-376 lazy-tool-body SHA and trailer', () => {
  assert.equal(executeBashMapping(LB_TARGET, LB_OLD), LB_ID)
})

const SHIPPED_EXPIRED_WAIVER = "da9cd5484db3b0e5c882f4032ee09685c4e5b5a7";

test("steward immutable exception pardons only shipped da9cd548 with its original expiry", () => {
  const waiver = { commit: SHIPPED_EXPIRED_WAIVER, expiresAt: "2026-10-31" };
  const result = execute({
    sha: SHIPPED_EXPIRED_WAIVER,
    trailer: "none (route lookup key; unit regression, no session display change)",
    waivers: new Map([[SHIPPED_EXPIRED_WAIVER.slice(0, 8), waiver]]),
  });
  assert.equal(result.checked, 1);
});

test("a different full SHA is not covered by the da9cd548 exception", () => {
  const sha = `${SHIPPED_EXPIRED_WAIVER.slice(0, 39)}0`;
  assert.throws(() => execute({
    sha,
    trailer: "none (fixture)",
    waivers: new Map([[sha.slice(0, 8), { commit: sha, expiresAt: "2026-10-31" }]]),
  }), /已于 2026-10-31 过期/);
});

test("da9cd548 with any other expiry date stays on the ordinary expired-waiver path", () => {
  assert.throws(() => execute({
    sha: SHIPPED_EXPIRED_WAIVER,
    trailer: "none (fixture)",
    waivers: new Map([[SHIPPED_EXPIRED_WAIVER.slice(0, 8), { commit: SHIPPED_EXPIRED_WAIVER, expiresAt: "2026-10-30" }]]),
  }), /已于 2026-10-30 过期/);
});

test("the da9cd548 exception does not extend the waiver or freeze a history tip", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const checker = readFileSync(`${repo}/scripts/check-v5-incident-regressions.ts`, "utf8");
  const shell = readFileSync(`${repo}/scripts/check-v5-fix-trailers.sh`, "utf8");
  const waivers = JSON.parse(readFileSync(`${repo}/e2e/session-display/incident-waivers.json`, "utf8")) as {
    waivers: Array<{ commit: string; expiresAt: string }>;
  };
  assert.equal(checker.split(SHIPPED_EXPIRED_WAIVER).length - 1, 1);
  assert.equal(shell.split(SHIPPED_EXPIRED_WAIVER).length - 1, 1);
  const entry = waivers.waivers.find((waiver) => waiver.commit === SHIPPED_EXPIRED_WAIVER);
  assert.equal(entry?.expiresAt, "2026-10-31");
  const tips = /const IMPORTED_TRAILER_HISTORY_TIPS = \[([\s\S]*?)\] as const/.exec(checker)?.[1] ?? "";
  assert.equal(tips.includes(SHIPPED_EXPIRED_WAIVER), false);
  assert.equal(tips.includes("197735db77dfbf05280c526963ae04846544cabe"), true);
});
