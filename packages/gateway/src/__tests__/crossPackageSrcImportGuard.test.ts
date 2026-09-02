/**
 * Fail-closed guard: workspace production sources must not cross-import a
 * sibling package via relative `../../<pkg>/src/` paths.
 *
 * tsx resolves those specifiers to the sibling `.ts` in tests/typecheck, so
 * the existing gates stay green. Container gateway precompile (esbuild
 * per-package emit, no bundle) keeps the relative specifier in dist/, and
 * Node then looks for `packages/<pkg>/src/*.js` which is never emitted
 * (`openclaude-precompiled` maps `@openclaude/<pkg>` to `./dist/*.js`).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/crossPackageSrcImportGuard.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TEST_FILE_DIR, '../../../..')

/** Empty by default. Entries are repo-relative `path:line:specifier`. */
const ALLOWLIST: readonly string[] = []

const IMPORT_SPEC_RE =
  /(?:from\s+|import\s*\(\s*|import\s+)(['"])((?:\.\.\/)+[A-Za-z0-9_-]+\/src\/[^'"]+)\1/g

const CROSS_PKG_SRC_RE = /^(?:\.\.\/)+([A-Za-z0-9_-]+)\/src\//

type Hit = {
  file: string
  line: number
  specifier: string
  suggested: string
  allowKey: string
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

function readPkgName(pkgRoot: string): string | null {
  try {
    const raw = readFileSync(join(pkgRoot, 'package.json'), 'utf8')
    const name = (JSON.parse(raw) as { name?: string }).name
    return typeof name === 'string' && name.length > 0 ? name : null
  } catch {
    return null
  }
}

function packageRootFor(file: string, repoRoot: string): string | null {
  const rel = posixRel(repoRoot, file)
  const parts = rel.split('/')
  if (parts[0] !== 'packages' || parts.length < 2) return null
  if (parts[1] === 'channels' && parts.length >= 3) {
    return join(repoRoot, 'packages', 'channels', parts[2]!)
  }
  return join(repoRoot, 'packages', parts[1]!)
}

function isTestPath(relFile: string): boolean {
  const parts = relFile.split('/')
  if (parts.includes('__tests__')) return true
  const base = parts[parts.length - 1] ?? ''
  return /\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/.test(base)
}

function walkSrcFiles(dir: string, acc: string[]): void {
  let ents
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of ents) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '__tests__' || ent.name === 'node_modules' || ent.name === 'dist') continue
      walkSrcFiles(p, acc)
      continue
    }
    if (!ent.isFile()) continue
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(ent.name)) continue
    if (ent.name.endsWith('.d.ts')) continue
    acc.push(p)
  }
}

function listPackageSrcDirs(repoRoot: string): string[] {
  const packagesDir = join(repoRoot, 'packages')
  const out: string[] = []
  for (const ent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'channels') {
      const channelsDir = join(packagesDir, 'channels')
      for (const ch of readdirSync(channelsDir, { withFileTypes: true })) {
        if (!ch.isDirectory()) continue
        const src = join(channelsDir, ch.name, 'src')
        try {
          if (readdirSync(src).length >= 0) out.push(src)
        } catch {
          /* no src */
        }
      }
      continue
    }
    const src = join(packagesDir, ent.name, 'src')
    try {
      readdirSync(src)
      out.push(src)
    } catch {
      /* no src */
    }
  }
  return out
}

function suggestedName(repoRoot: string, fromFile: string, specifier: string): string {
  const m = specifier.match(CROSS_PKG_SRC_RE)
  const pkgDirName = m?.[1]
  const resolved = resolve(dirname(fromFile), specifier)
  const targetRoot = packageRootFor(resolved, repoRoot)
  const fromName = targetRoot ? readPkgName(targetRoot) : null
  if (fromName) return fromName
  if (pkgDirName) return `@openclaude/${pkgDirName}`
  return '@openclaude/<package>'
}

export function findCrossPackageSrcImports(
  repoRoot: string,
  allowlist: readonly string[] = ALLOWLIST,
): Hit[] {
  const allow = new Set(allowlist)
  const hits: Hit[] = []
  for (const srcDir of listPackageSrcDirs(repoRoot)) {
    const files: string[] = []
    walkSrcFiles(srcDir, files)
    for (const file of files) {
      const relFile = posixRel(repoRoot, file)
      if (isTestPath(relFile)) continue
      const fromRoot = packageRootFor(file, repoRoot)
      const text = readFileSync(file, 'utf8')
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        IMPORT_SPEC_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = IMPORT_SPEC_RE.exec(line)) !== null) {
          const specifier = match[2]!
          if (!CROSS_PKG_SRC_RE.test(specifier)) continue
          const resolved = resolve(dirname(file), specifier)
          const targetRoot = packageRootFor(resolved, repoRoot)
          if (fromRoot && targetRoot && resolve(fromRoot) === resolve(targetRoot)) continue
          const suggested = suggestedName(repoRoot, file, specifier)
          const allowKey = `${relFile}:${i + 1}:${specifier}`
          if (allow.has(allowKey)) continue
          hits.push({
            file: relFile,
            line: i + 1,
            specifier,
            suggested,
            allowKey,
          })
        }
      }
    }
  }
  return hits
}

function formatHits(hits: Hit[]): string {
  return hits
    .map(
      (h) =>
        `${h.file}:${h.line}: cross-package relative import '${h.specifier}' — use '${h.suggested}' instead`,
    )
    .join('\n')
}

describe('cross-package src import guard', () => {
  it('reports file, line, and package name for a planted violation', () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-cross-pkg-src-'))
    try {
      mkdirSync(join(root, 'packages/gateway/src'), { recursive: true })
      mkdirSync(join(root, 'packages/protocol/src'), { recursive: true })
      writeFileSync(
        join(root, 'packages/gateway/package.json'),
        JSON.stringify({ name: '@openclaude/gateway', type: 'module' }),
      )
      writeFileSync(
        join(root, 'packages/protocol/package.json'),
        JSON.stringify({ name: '@openclaude/protocol', type: 'module' }),
      )
      writeFileSync(join(root, 'packages/protocol/src/delegation.ts'), 'export const x = 1\n')
      writeFileSync(
        join(root, 'packages/gateway/src/bad.ts'),
        "import { x } from '../../protocol/src/delegation.js'\n",
      )
      const hits = findCrossPackageSrcImports(root, [])
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.file, 'packages/gateway/src/bad.ts')
      assert.equal(hits[0]?.line, 1)
      assert.equal(hits[0]?.specifier, '../../protocol/src/delegation.js')
      assert.equal(hits[0]?.suggested, '@openclaude/protocol')
      assert.match(formatHits(hits), /packages\/gateway\/src\/bad\.ts:1:/)
      assert.match(formatHits(hits), /@openclaude\/protocol/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allowlist may be empty and does not special-case delegation.js', () => {
    assert.deepEqual(ALLOWLIST, [])
    assert.equal(CROSS_PKG_SRC_RE.test('../../storage/src/sessionsDb.js'), true)
    assert.equal(CROSS_PKG_SRC_RE.test('../../protocol/src/delegation.js'), true)
    assert.equal(CROSS_PKG_SRC_RE.test('../../protocol/src/frames.js'), true)
  })

  it('packages/*/src has no cross-package relative src imports', () => {
    const hits = findCrossPackageSrcImports(REPO_ROOT, ALLOWLIST)
    assert.equal(
      hits.length,
      0,
      `cross-package relative src imports must use the package name:\n${formatHits(hits)}`,
    )
  })
})
