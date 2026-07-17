import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { CommandRunner } from '../selfheal/brokerActions.js'
import {
  type Classification,
  ManifestInvalidError,
  type TrustedManifest,
  classifyDiff,
  computeDeployPlanHash,
  globToRegExp,
  loadTrustedManifest,
  parseRawZ,
  parseTrustedManifest,
} from '../selfheal/deploySurfaces.js'

const BASE = 'a'.repeat(40)
const SHA = 'b'.repeat(40)

const MANIFEST_DOC = {
  schema: 'selfheal-deploy-surfaces',
  version: 1,
  // 与 v5 仓 deploy/v5/selfheal-deploy-surfaces.json 同形:_comment / label / deployAction /
  // requiresAxis / note 是文档与 playbook 生成器字段,解析器必须接受(类型校验)但不参与匹配。
  _comment: 'fixture mirroring the v5-side manifest shape',
  surfaces: {
    web: { verifyLayers: ['test:web'], label: 'dist 静态资源', deployAction: 'deploy-v5.sh --dist' },
    master: { note: 'playbook §4.1 · master 侧代码' },
    egress: { verifyLayers: ['test:commercial'], requiresAxis: null },
    'runtime-source': { requiresAxis: 'runtime-release' },
    'platform-runtime': { requiresAxis: 'platform-bundle' },
  },
  rules: [
    { glob: 'packages/web-react/**', surface: 'web' },
    { glob: 'packages/gateway/**', surface: 'master' },
    { glob: 'packages/commercial/src/egress/**', surface: 'egress' },
    { glob: 'packages/mcp-memory/**', surface: 'runtime-source' },
    { glob: 'packages/platform/**', surface: 'platform-runtime' },
  ],
  manual: [
    { glob: '**/package.json' },
    { glob: 'scripts/**', note: 'RFC §3 manual: scripts' },
    { glob: 'deploy/**' },
    { glob: '**/*.sh' },
    { glob: 'agent-sandbox/**' },
  ],
}
const MANIFEST_JSON = JSON.stringify(MANIFEST_DOC)

function manifest(): TrustedManifest {
  return parseTrustedManifest(MANIFEST_JSON)
}

/** Build one raw-diff record: `<meta>\0<path>\0[<path2>\0]`. */
function rec(meta: string, ...paths: string[]): string {
  return `${meta}\0${paths.map((p) => `${p}\0`).join('')}`
}

/** Run classifyDiff against a fixed raw-diff string. */
async function classify(rawDiff: string, m: TrustedManifest = manifest()): Promise<Classification> {
  const run: CommandRunner = async (cmd, args) => {
    if (cmd === 'git' && args.includes('diff')) return { code: 0, stdout: rawDiff, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return classifyDiff('/repo', BASE, SHA, m, { run })
}

// ── manifest loading / strict validation ─────────────────────────────────────

describe('deploySurfaces: manifest validation (fail-closed)', () => {
  it('parses a valid manifest and hashes the RAW bytes', () => {
    const m = manifest()
    assert.equal(m.version, 1)
    assert.equal(m.manifestVersion, 1)
    assert.equal(m.manifestHash, createHash('sha256').update(MANIFEST_JSON, 'utf8').digest('hex'))
    assert.deepEqual(m.surfaces.web.verifyLayers, ['test:web'])
  })

  it('rejects an unknown schema', () => {
    assert.throws(
      () => parseTrustedManifest(JSON.stringify({ ...MANIFEST_DOC, schema: 'nope' })),
      ManifestInvalidError,
    )
  })

  it('rejects an unknown manifest version (fail-closed, not silently degraded)', () => {
    assert.throws(
      () => parseTrustedManifest(JSON.stringify({ ...MANIFEST_DOC, version: 99 })),
      /unknown manifest version/,
    )
  })

  it('rejects invalid JSON', () => {
    assert.throws(() => parseTrustedManifest('{not json'), /not valid JSON/)
  })

  it('rejects an unknown surface name', () => {
    const bad = { ...MANIFEST_DOC, surfaces: { ...MANIFEST_DOC.surfaces, bogus: {} } }
    assert.throws(() => parseTrustedManifest(JSON.stringify(bad)), /unknown surface/)
  })

  it('rejects a rule pointing at an undeclared surface', () => {
    // platform-runtime is a KNOWN surface but here it is NOT declared in surfaces,
    // so a rule pointing at it must be rejected.
    const { 'platform-runtime': _omit, ...surfaces } = MANIFEST_DOC.surfaces
    const bad = {
      ...MANIFEST_DOC,
      surfaces,
      rules: [{ glob: 'x/**', surface: 'platform-runtime' }],
    }
    assert.throws(() => parseTrustedManifest(JSON.stringify(bad)), /not a declared surface/)
  })

  it('rejects an unexpected top-level key', () => {
    assert.throws(
      () => parseTrustedManifest(JSON.stringify({ ...MANIFEST_DOC, extra: 1 })),
      /unexpected key/,
    )
  })

  it('rejects a non-array manual', () => {
    assert.throws(
      () => parseTrustedManifest(JSON.stringify({ ...MANIFEST_DOC, manual: 'scripts/**' })),
      /manual must be an array/,
    )
  })

  it('rejects a manual entry that is a bare string (must be {glob,note?})', () => {
    assert.throws(
      () => parseTrustedManifest(JSON.stringify({ ...MANIFEST_DOC, manual: ['scripts/**'] })),
      /manual entry must be an object/,
    )
  })

  it('rejects wrong-typed doc fields (requiresAxis / _comment / rule.note)', () => {
    assert.throws(
      () =>
        parseTrustedManifest(
          JSON.stringify({
            ...MANIFEST_DOC,
            surfaces: { ...MANIFEST_DOC.surfaces, web: { requiresAxis: 42 } },
          }),
        ),
      /requiresAxis/,
    )
    assert.throws(
      () => parseTrustedManifest(JSON.stringify({ ...MANIFEST_DOC, _comment: 42 })),
      /_comment/,
    )
    assert.throws(
      () =>
        parseTrustedManifest(
          JSON.stringify({
            ...MANIFEST_DOC,
            rules: [{ glob: 'docs/**', surface: 'master', note: 42 }],
          }),
        ),
      /rule\.note/,
    )
  })

  it('loadTrustedManifest reads git show <branch>:<path> and fails closed on git error', async () => {
    const calls: string[][] = []
    const okRun: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args])
      return { code: 0, stdout: MANIFEST_JSON, stderr: '' }
    }
    const m = await loadTrustedManifest('/canon', 'feat/v5-aurora-rewrite', { run: okRun })
    assert.equal(m.manifestHash, manifest().manifestHash)
    assert.ok(
      calls.some(
        (c) =>
          c[0] === 'git' &&
          c.includes('show') &&
          c.includes('feat/v5-aurora-rewrite:deploy/v5/selfheal-deploy-surfaces.json'),
      ),
    )
    const failRun: CommandRunner = async () => ({ code: 128, stdout: '', stderr: 'no such path' })
    await assert.rejects(
      () => loadTrustedManifest('/canon', 'feat/v5-aurora-rewrite', { run: failRun }),
      ManifestInvalidError,
    )
  })
})

// ── raw -z parsing / classification, all record shapes ───────────────────────

describe('deploySurfaces: raw -z classification, all record shapes', () => {
  it('A/M map matched paths to their surfaces', async () => {
    const diff =
      rec(':000000 100644 000000 abc123 A', 'packages/web-react/App.tsx') +
      rec(':100644 100644 abc123 def456 M', 'packages/gateway/src/x.ts')
    const c = await classify(diff)
    assert.deepEqual(c.surfaces, ['master', 'web'])
    assert.deepEqual(c.manual, [])
    assert.deepEqual(c.changedFiles.paths.sort(), [
      'packages/gateway/src/x.ts',
      'packages/web-react/App.tsx',
    ])
    assert.equal(c.changedFiles.total, 2)
  })

  it('D classifies the OLD (deleted) path', async () => {
    const diff = rec(':100644 000000 abc123 000000 D', 'packages/gateway/src/gone.ts')
    const c = await classify(diff)
    assert.deepEqual(c.surfaces, ['master'])
    assert.deepEqual(c.manual, [])
  })

  it('rename (R100) and copy (C75) → both paths manual (rename_copy)', async () => {
    const diff =
      rec(':100644 100644 abc def R100', 'packages/web-react/a.tsx', 'packages/web-react/b.tsx') +
      rec(':100644 100644 abc def C75', 'packages/gateway/src/s.ts', 'packages/gateway/src/d.ts')
    const c = await classify(diff)
    assert.equal(c.manual.length, 4)
    assert.ok(c.manual.every((m) => m.reason === 'rename_copy'))
    assert.deepEqual(c.deployArgs, [], 'any manual short-circuits argv')
    // Both sides of each rename are recorded as changed.
    assert.equal(c.changedFiles.total, 4)
  })

  it('typechange (T) → manual', async () => {
    const diff = rec(':100644 100755 abc def T', 'packages/gateway/src/x.ts')
    const c = await classify(diff)
    assert.deepEqual(c.manual, [{ path: 'packages/gateway/src/x.ts', reason: 'typechange' }])
  })

  it('symlink (120000) and gitlink (160000) modes → manual regardless of surface', async () => {
    const diff =
      rec(':000000 120000 000000 abc A', 'packages/web-react/link') +
      rec(':000000 160000 000000 def A', 'packages/gateway/submod')
    const c = await classify(diff)
    assert.deepEqual(c.manual, [
      { path: 'packages/web-react/link', reason: 'symlink' },
      { path: 'packages/gateway/submod', reason: 'gitlink' },
    ])
  })

  it('paths containing spaces are handled verbatim (NUL-delimited)', async () => {
    const diff = rec(':100644 100644 abc def M', 'packages/web-react/My File.tsx')
    const c = await classify(diff)
    assert.deepEqual(c.surfaces, ['web'])
  })

  it('a truncated record (missing rename dst) is manual (malformed)', async () => {
    // R needs two paths; supply only one, unterminated → malformed.
    const diff = ':100644 100644 abc def R100\0packages/web-react/only.tsx\0'
    const c = await classify(diff)
    assert.ok(c.manual.some((m) => m.reason === 'malformed_diff_record'))
  })

  it('absolute path and .. traversal are manual', async () => {
    const diff =
      rec(':100644 100644 abc def M', '/etc/passwd') +
      rec(':100644 100644 abc def M', 'packages/../secret.ts')
    const c = await classify(diff)
    assert.deepEqual(c.manual, [
      { path: '/etc/passwd', reason: 'absolute_path' },
      { path: 'packages/../secret.ts', reason: 'path_traversal' },
    ])
  })

  it('a manual-glob path (a .sh) short-circuits to manual', async () => {
    const diff = rec(':100644 100644 abc def M', 'scripts/deploy-v5.sh')
    const c = await classify(diff)
    assert.equal(c.manual.length, 1)
    assert.match(c.manual[0].reason, /^manual_glob:/)
  })

  it('a path matching NO rule and NO manual glob → manual (unmatched_path)', async () => {
    const diff = rec(':100644 100644 abc def M', 'packages/unknown-thing/x.ts')
    const c = await classify(diff)
    assert.deepEqual(c.manual, [{ path: 'packages/unknown-thing/x.ts', reason: 'unmatched_path' }])
  })

  it('an EMPTY diff (zero records) is fail-closed manual at the classifier layer (§F10)', async () => {
    const c = await classify('')
    assert.deepEqual(c.manual, [{ path: '', reason: 'empty_diff' }])
    assert.deepEqual(c.surfaces, [])
    assert.deepEqual(c.deployArgs, [], 'a manual short-circuits argv')
    assert.equal(c.changedFiles.total, 0)
  })
})

// ── required axes (§F4) ──────────────────────────────────────────────────────

describe('deploySurfaces: requiredAxes (§F4)', () => {
  it('collects the hit surfaces requiresAxis (deduped, sorted); surfaces without an axis add none', async () => {
    // runtime-source (→runtime-release) + platform-runtime (→platform-bundle) +
    // master/web (no axis).
    const c = await classify(
      rec(':100644 100644 a b M', 'packages/mcp-memory/x.ts') +
        rec(':100644 100644 a b M', 'packages/platform/y.ts') +
        rec(':100644 100644 a b M', 'packages/gateway/src/z.ts'),
    )
    assert.deepEqual(c.surfaces, ['master', 'platform-runtime', 'runtime-source'])
    assert.deepEqual(c.requiredAxes, ['platform-bundle', 'runtime-release'])
  })

  it('a plan touching only axis-less surfaces has an empty requiredAxes', async () => {
    const c = await classify(rec(':100644 100644 a b M', 'packages/web-react/App.tsx'))
    assert.deepEqual(c.surfaces, ['web'])
    assert.deepEqual(c.requiredAxes, [])
  })

  it('requiredAxes is retained through manifest parse (requiresAxis not dropped)', () => {
    const m = manifest()
    assert.equal(m.surfaces['runtime-source'].requiresAxis, 'runtime-release')
    assert.equal(m.surfaces['platform-runtime'].requiresAxis, 'platform-bundle')
    // a null requiresAxis is omitted (no axis).
    assert.equal(m.surfaces.egress.requiresAxis, undefined)
  })
})

// ── argv synthesis matrix + verify layers ────────────────────────────────────

describe('deploySurfaces: deploy argv synthesis', () => {
  it('web only → --dist', async () => {
    const c = await classify(rec(':100644 100644 a b M', 'packages/web-react/App.tsx'))
    assert.deepEqual(c.surfaces, ['web'])
    assert.deepEqual(c.deployArgs, ['--dist'])
  })

  it('web + master → --with-dist', async () => {
    const c = await classify(
      rec(':100644 100644 a b M', 'packages/web-react/App.tsx') +
        rec(':100644 100644 a b M', 'packages/gateway/src/x.ts'),
    )
    assert.deepEqual(c.surfaces, ['master', 'web'])
    assert.deepEqual(c.deployArgs, ['--with-dist'])
  })

  it('master only → plain deploy ([])', async () => {
    const c = await classify(rec(':100644 100644 a b M', 'packages/gateway/src/x.ts'))
    assert.deepEqual(c.deployArgs, [])
  })

  it('egress only → --egress (plain deploy base)', async () => {
    const c = await classify(
      rec(':100644 100644 a b M', 'packages/commercial/src/egress/driver.ts'),
    )
    assert.deepEqual(c.surfaces, ['egress'])
    assert.deepEqual(c.deployArgs, ['--egress'])
    // egress surface pulls in its verify layer.
    assert.ok(c.verifyLayers.includes('test:commercial'))
  })

  it('web + egress → --with-dist then --egress', async () => {
    const c = await classify(
      rec(':100644 100644 a b M', 'packages/web-react/App.tsx') +
        rec(':100644 100644 a b M', 'packages/commercial/src/egress/driver.ts'),
    )
    assert.deepEqual(c.surfaces, ['egress', 'web'])
    assert.deepEqual(c.deployArgs, ['--with-dist', '--egress'])
  })

  it('default verify layers are always present, sorted', async () => {
    const c = await classify(rec(':100644 100644 a b M', 'packages/gateway/src/x.ts'))
    assert.deepEqual(c.verifyLayers, ['lint', 'test:gateway', 'test:web', 'typecheck'])
  })
})

// ── deploy plan hash stability ───────────────────────────────────────────────

describe('deploySurfaces: deploy plan hash', () => {
  it('is independent of surface / manual / layer ordering', () => {
    const a = computeDeployPlanHash({
      baseSha: BASE,
      sha: SHA,
      manifestVersion: 1,
      manifestHash: 'f'.repeat(64),
      surfaces: ['web', 'master'],
      deployArgs: ['--with-dist'],
      manual: [
        { path: 'b.sh', reason: 'manual_glob:**/*.sh' },
        { path: 'a.sh', reason: 'manual_glob:**/*.sh' },
      ],
      verifyLayers: ['typecheck', 'lint'],
      requiredAxes: ['platform-bundle', 'runtime-release'],
    })
    const b = computeDeployPlanHash({
      baseSha: BASE,
      sha: SHA,
      manifestVersion: 1,
      manifestHash: 'f'.repeat(64),
      surfaces: ['master', 'web'],
      deployArgs: ['--with-dist'],
      manual: [
        { path: 'a.sh', reason: 'manual_glob:**/*.sh' },
        { path: 'b.sh', reason: 'manual_glob:**/*.sh' },
      ],
      verifyLayers: ['lint', 'typecheck'],
      // Same set, different order → same hash (requiredAxes is sorted into the hash).
      requiredAxes: ['runtime-release', 'platform-bundle'],
    })
    assert.equal(a, b)
  })

  it('changes when the required-axis set changes', () => {
    const base = {
      baseSha: BASE,
      sha: SHA,
      manifestVersion: 1,
      manifestHash: 'f'.repeat(64),
      surfaces: ['runtime-source'],
      deployArgs: [],
      manual: [],
      verifyLayers: ['lint'],
    }
    const withAxis = computeDeployPlanHash({ ...base, requiredAxes: ['runtime-release'] })
    const noAxis = computeDeployPlanHash({ ...base, requiredAxes: [] })
    assert.notEqual(withAxis, noAxis)
  })

  it('changes when the surface set changes', () => {
    const base = {
      baseSha: BASE,
      sha: SHA,
      manifestVersion: 1,
      manifestHash: 'f'.repeat(64),
      deployArgs: [],
      manual: [],
      verifyLayers: ['lint'],
      requiredAxes: [],
    }
    const web = computeDeployPlanHash({ ...base, surfaces: ['web'] })
    const master = computeDeployPlanHash({ ...base, surfaces: ['master'] })
    assert.notEqual(web, master)
  })

  it('classifyDiff produces the same plan hash regardless of diff record order', async () => {
    const r1 = rec(':100644 100644 a b M', 'packages/web-react/App.tsx')
    const r2 = rec(':100644 100644 a b M', 'packages/gateway/src/x.ts')
    const forward = await classify(r1 + r2)
    const reversed = await classify(r2 + r1)
    assert.equal(forward.deployPlanHash, reversed.deployPlanHash)
  })
})

// ── glob engine semantics ────────────────────────────────────────────────────

describe('deploySurfaces: glob semantics', () => {
  it('** crosses path segments; a trailing slash requires the dir prefix', () => {
    const re = globToRegExp('packages/web-react/**')
    assert.equal(re.test('packages/web-react/a/b/c.tsx'), true)
    assert.equal(re.test('packages/web-react/App.tsx'), true)
    assert.equal(re.test('packages/web-react'), false)
    assert.equal(re.test('packages/gateway/App.tsx'), false)
  })

  it('**/ matches zero or more leading segments (incl. top level)', () => {
    const re = globToRegExp('**/package.json')
    assert.equal(re.test('package.json'), true)
    assert.equal(re.test('packages/gateway/package.json'), true)
    assert.equal(re.test('packagesXpackage.json'), false)
  })

  it('* matches within a single segment only', () => {
    const re = globToRegExp('packages/*/index.ts')
    assert.equal(re.test('packages/web/index.ts'), true)
    assert.equal(re.test('packages/web/sub/index.ts'), false)
  })

  it('*.sh is single-segment; **/*.sh is any depth', () => {
    assert.equal(globToRegExp('*.sh').test('foo.sh'), true)
    assert.equal(globToRegExp('*.sh').test('scripts/foo.sh'), false)
    assert.equal(globToRegExp('**/*.sh').test('foo.sh'), true)
    assert.equal(globToRegExp('**/*.sh').test('a/b/foo.sh'), true)
  })

  it('is prefix-anchored (a leading segment cannot be skipped without **)', () => {
    assert.equal(globToRegExp('scripts/**').test('scripts/x.sh'), true)
    assert.equal(globToRegExp('scripts/**').test('packages/scripts/x.sh'), false)
  })
})

// ── raw parser unit (independent of a manifest) ──────────────────────────────

describe('deploySurfaces: parseRawZ', () => {
  it('parses single-path and dual-path (R/C) records; drops the trailing NUL', () => {
    const out =
      rec(':100644 100644 a b M', 'x.ts') + rec(':100644 100644 a b R100', 'old.ts', 'new.ts')
    const records = parseRawZ(out)
    assert.equal(records.length, 2)
    assert.deepEqual(records[0], {
      oldMode: '100644',
      newMode: '100644',
      status: 'M',
      paths: ['x.ts'],
      malformed: false,
      meta: ':100644 100644 a b M',
    })
    assert.deepEqual(records[1].paths, ['old.ts', 'new.ts'])
    assert.equal(records[1].status, 'R')
  })

  it('empty diff → no records', () => {
    assert.deepEqual(parseRawZ(''), [])
  })
})
