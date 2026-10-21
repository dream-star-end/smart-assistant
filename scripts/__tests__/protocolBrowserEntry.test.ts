// OCV5-558 (phase 3 plan v3.6 §3.6): the protocol browser entries are node:*-free in their whole
// import graph (transitively, not just the entry file), the browser entry exports every node-free
// module of the root entry, and web-react imports protocol only through browser entries.
// Run: npx tsx --test scripts/__tests__/protocolBrowserEntry.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PROTOCOL = path.join(ROOT, 'packages/protocol')

/** Protocol subpaths a browser may import. Every one of them must be node:*-free transitively. */
const BROWSER_ENTRIES = [
  './browser',
  './containerPreview',
  './frames',
  './mediaGeneration',
  './research',
  './teamCards',
]

/** Runtime (non-type) module specifiers of a file: imports, re-exports, side-effect and dynamic imports. */
function runtimeImports(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause
      const typeOnly =
        !!c &&
        (c.isTypeOnly ||
          (!c.name &&
            !!c.namedBindings &&
            ts.isNamedImports(c.namedBindings) &&
            c.namedBindings.elements.length > 0 &&
            c.namedBindings.elements.every((e) => e.isTypeOnly)))
      if (!typeOnly) out.push(n.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const typeOnly =
        n.isTypeOnly ||
        (!!n.exportClause &&
          ts.isNamedExports(n.exportClause) &&
          n.exportClause.elements.length > 0 &&
          n.exportClause.elements.every((e) => e.isTypeOnly))
      if (!typeOnly) out.push(n.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push(n.arguments[0].text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/**
 * node:* (and other non-relative) specifiers reachable from `entry`, with the chain that reaches
 * them. Relative imports are followed; bare package imports are reported as `pkg:<name>` so the
 * caller decides (protocol's only allowed bare dependency is @sinclair/typebox).
 */
function reachable(entry: string): { spec: string; chain: string[] }[] {
  const found: { spec: string; chain: string[] }[] = []
  const seen = new Set<string>()
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of runtimeImports(file, readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec)
        const cand = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts'), base]
        const next = cand.find((c) => existsSync(c) && c.endsWith('.ts'))
        if (!next) throw new Error(`${path.relative(ROOT, file)}: cannot resolve ${spec}`)
        walk(next, [...chain, path.relative(ROOT, next)])
      } else found.push({ spec, chain })
    }
  }
  walk(entry, [path.relative(ROOT, entry)])
  return found
}

const exportFile = (sub: string) => {
  const e = JSON.parse(readFileSync(path.join(PROTOCOL, 'package.json'), 'utf8')).exports[sub]
  assert.ok(e, `protocol package.json exports ${sub}`)
  return path.join(PROTOCOL, e.default)
}
/** protocol's only allowed runtime dependency outside its own files */
const nodeOrForeign = (r: { spec: string }) => !r.spec.startsWith('@sinclair/typebox')

describe('protocol browser entries', () => {
  test('every browser entry is free of node:* (and of other packages) in its whole import graph', () => {
    for (const sub of BROWSER_ENTRIES) {
      const bad = reachable(exportFile(sub)).filter(nodeOrForeign)
      assert.deepEqual(
        bad.map((b) => `${b.spec} via ${b.chain.join(' → ')}`),
        [],
        `${sub} reaches a node-only module`,
      )
    }
  })

  test('the browser entry exports every node-free module of the root entry', () => {
    const idx = readFileSync(path.join(PROTOCOL, 'src/index.ts'), 'utf8')
    const browser = new Set(
      runtimeImports('browser.ts', readFileSync(exportFile('./browser'), 'utf8')),
    )
    const missing: string[] = []
    for (const spec of runtimeImports('index.ts', idx)) {
      const file = path.join(PROTOCOL, 'src', spec.replace(/\.js$/, '.ts'))
      if (reachable(file).some(nodeOrForeign)) continue
      if (!browser.has(spec)) missing.push(spec)
    }
    assert.deepEqual(missing, [], 'node-free root modules missing from src/browser.ts')
  })

  test('web-react imports protocol only through browser entries (never the Node root)', () => {
    const files = ts.sys.readDirectory(path.join(ROOT, 'packages/web-react/src'), ['.ts', '.tsx'])
    const bad: string[] = []
    for (const f of files) {
      for (const spec of runtimeImports(f, readFileSync(f, 'utf8'))) {
        if (spec !== '@openclaude/protocol' && !spec.startsWith('@openclaude/protocol/')) continue
        const sub =
          spec === '@openclaude/protocol' ? '.' : `./${spec.slice('@openclaude/protocol/'.length)}`
        if (!BROWSER_ENTRIES.includes(sub)) bad.push(`${path.relative(ROOT, f)} imports ${spec}`)
      }
    }
    assert.deepEqual(bad, [])
  })
})

describe('browser test bundles', () => {
  test('a browser test that aliases the protocol root also aliases /browser', () => {
    // esbuild appends a subpath to a package alias: aliasing only `@openclaude/protocol` turns
    // `@openclaude/protocol/browser` into `.../index.ts/browser` and the bundle fails to resolve
    const dir = path.join(ROOT, 'packages/web-react/browser-tests')
    const bad: string[] = []
    for (const f of ts.sys.readDirectory(dir, ['.mjs', '.js', '.ts'])) {
      const s = readFileSync(f, 'utf8')
      if (
        /['"]@openclaude\/protocol['"]\s*:/.test(s) &&
        !/['"]@openclaude\/protocol\/browser['"]\s*:/.test(s)
      )
        bad.push(path.relative(ROOT, f))
    }
    assert.deepEqual(bad, [])
  })
})

describe('the walker itself (counter-examples)', () => {
  const tree = (t: { after(fn: () => void): void }, files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'proto-browser-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    for (const [k, v] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, k)), { recursive: true })
      writeFileSync(path.join(dir, k), v)
    }
    return dir
  }
  test('node:* two hops away is found, with its chain', (t) => {
    const d = tree(t, {
      'entry.ts': "export * from './a.js'\n",
      'a.ts': "import { b } from './b.js'\nexport const a = b\n",
      'b.ts': "import { createHash } from 'node:crypto'\nexport const b = createHash\n",
    })
    const r = reachable(path.join(d, 'entry.ts'))
    assert.equal(r.length, 1)
    assert.equal(r[0]!.spec, 'node:crypto')
    assert.equal(r[0]!.chain.length, 3)
  })
  test('type-only imports and re-exports are not runtime edges; side-effect and dynamic imports are', (t) => {
    const d = tree(t, {
      'entry.ts':
        "import type { X } from './n.js'\nimport { type Y } from './n.js'\nexport type { Z } from './n.js'\nexport const e = 1\n",
      'n.ts': "import 'node:fs'\nexport type X = 1\nexport type Y = 2\nexport type Z = 3\n",
      'side.ts': "import './n.js'\n",
      'dyn.ts': "export const f = () => import('node:path')\n",
    })
    assert.deepEqual(reachable(path.join(d, 'entry.ts')), [])
    assert.deepEqual(
      reachable(path.join(d, 'side.ts')).map((r) => r.spec),
      ['node:fs'],
    )
    assert.deepEqual(
      reachable(path.join(d, 'dyn.ts')).map((r) => r.spec),
      ['node:path'],
    )
  })
  test('an unresolvable relative import fails closed', (t) => {
    const d = tree(t, { 'entry.ts': "export * from './gone.js'\n" })
    assert.throws(() => reachable(path.join(d, 'entry.ts')), /cannot resolve/)
  })
})
