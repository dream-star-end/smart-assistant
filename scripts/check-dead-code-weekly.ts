/**
 * Weekly Dead-Code Inventory Generator (OCV5-905).
 *
 * Builds the full-repository TypeScript AST import/export graph in memory (zero per-import
 * filesystem syscalls) and outputs structured JSON consumed by `gardening-loop`:
 *   - Unreferenced exported symbols (`unusedExports`)
 *   - Orphan production files with zero incoming edges (`orphanFiles`)
 *   - Per-package rollup (`byPackage`)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export interface UnusedExportItem {
  package: string
  file: string
  symbol: string
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'default' | 'reexport'
  line: number
}

export interface OrphanFileItem {
  package: string
  file: string
  exports: string[]
}

export interface PackageDeadCodeSummary {
  scannedFiles: number
  entrypointFiles: number
  totalExports: number
  unusedExportCount: number
  orphanFileCount: number
}

export interface DeadCodeReport {
  schemaVersion: 1
  generatedAt: string
  summary: {
    scannedFiles: number
    entrypointFiles: number
    totalExports: number
    unusedExportCount: number
    orphanFileCount: number
  }
  unusedExports: UnusedExportItem[]
  orphanFiles: OrphanFileItem[]
  byPackage: Record<string, PackageDeadCodeSummary>
}

interface WorkspacePkg {
  id: string
  name: string
  dir: string
  entryFiles: Set<string>
}

interface ExportDeclInfo {
  symbol: string
  kind: UnusedExportItem['kind']
  line: number
  viaModuleSpec?: string
  viaRemoteName?: string
}

interface ImportEdgeInfo {
  spec: string
  importedNames: string[] | '*'
}

interface FileAstGraph {
  file: string
  pkgId: string
  isEntrypoint: boolean
  exports: ExportDeclInfo[]
  exportAllSpecs: string[]
  imports: ImportEdgeInfo[]
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  'build',
  'coverage',
  '.git',
  '.vite',
  '.cache',
  'generated',
  '__tests__',
  '__smoke__',
  'test',
  'tests',
  'browser-tests',
  'fixtures',
  '__fixtures__',
  '__snapshots__',
  'vendor',
])

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.js', '.mjs']

export function isProductionTsFile(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!/\.(ts|tsx)$/.test(norm) || /\.d\.ts$/.test(norm)) return false
  if (/\.(test|spec|integ\.test|node-test)\.(ts|tsx)$/.test(norm)) return false
  if (
    /(^|\/)(node_modules|dist|dist-types|build|coverage|generated|__tests__|__smoke__|test|tests|browser-tests|fixtures|__fixtures__|__snapshots__|vendor)\//.test(
      norm,
    )
  ) {
    return false
  }
  if (/^claude-code-best\//.test(norm) || /^packages\/[^/]+\/agent-sandbox\//.test(norm)) {
    return false
  }
  return !/(^|\/)agent-sandbox\/(platform-runtime|ccb-baseline|runtime|templates|skills)\//.test(
    norm,
  )
}

export function isEntrypointFile(relPosix: string, declaredPkgEntries?: Set<string>): boolean {
  const norm = relPosix.replace(/\\/g, '/')
  if (declaredPkgEntries?.has(norm)) return true
  const base = path.posix.basename(norm)
  if (/^(index|main|server|App|appLazyViews|registerSW)\.(ts|tsx|mts)$/.test(base)) return true
  if (/^packages\/cli\//.test(norm) || /(^|\/)cli\//.test(norm) || /Cli\.(ts|tsx)$/.test(base)) {
    return true
  }
  if (/(^|\/)commands\//.test(norm)) return true
  if (/(^|\/)migrations?\//.test(norm) || /(^|\/)migrate\.(ts|tsx)$/.test(norm)) return true
  if (/(^|\/)(workers|bootstrap|egress)\//.test(norm) || /Worker\.(ts|tsx)$/.test(base)) return true
  return (
    /(^|\/)(testing|test-utils|testHelpers|__mocks__|mocks)\//.test(norm) ||
    /(TestHelper|TestUtils|Mock|\.mock|\.fixture)\.(ts|tsx)$/i.test(base)
  )
}

function resolveFromKnownSet(knownFiles: Set<string>, baseRel: string): string | null {
  if (knownFiles.has(baseRel)) return baseRel
  const stripped = baseRel.replace(/\.(m|c)?js$/, '')
  if (stripped !== baseRel) {
    for (const e of RESOLVE_EXTS) {
      if (knownFiles.has(stripped + e)) return stripped + e
    }
  }
  for (const e of RESOLVE_EXTS) {
    if (knownFiles.has(baseRel + e)) return baseRel + e
  }
  for (const e of RESOLVE_EXTS) {
    const idx = `${baseRel}/index${e}`
    if (knownFiles.has(idx)) return idx
  }
  return null
}

function collectExportTargets(exp: unknown): string[] {
  if (!exp) return []
  if (typeof exp === 'string') return [exp]
  if (Array.isArray(exp)) return exp.flatMap(collectExportTargets)
  if (typeof exp === 'object') {
    return Object.entries(exp as Record<string, unknown>)
      .filter(([k]) => k !== 'types')
      .flatMap(([, v]) => collectExportTargets(v))
  }
  return []
}

function walkDir(root: string, relDir: string, filter: (rel: string) => boolean): string[] {
  const out: string[] = []
  const abs = path.join(root, relDir)
  if (!existsSync(abs)) return out
  const stack = [relDir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const ent of readdirSync(path.join(root, cur), { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue
      const next = cur === '.' ? ent.name : `${cur}/${ent.name}`
      if (ent.isDirectory()) stack.push(next)
      else if (ent.isFile() && filter(next)) out.push(next)
    }
  }
  return out.sort()
}

function loadPackagesAndFiles(root: string): {
  pkgs: WorkspacePkg[]
  pkgByName: Map<string, WorkspacePkg>
  filesByPkg: Map<string, string[]>
  knownFiles: Set<string>
} {
  const pkgs: WorkspacePkg[] = []
  const filesByPkg = new Map<string, string[]>()
  const knownFiles = new Set<string>()
  const rawPkgManifests = new Map<string, Record<string, unknown>>()

  const registerPkg = (id: string, dir: string) => {
    const pjAbs = path.join(root, dir, 'package.json')
    let name = `@openclaude/${id}`
    if (existsSync(pjAbs)) {
      const pj = JSON.parse(readFileSync(pjAbs, 'utf8')) as Record<string, unknown>
      rawPkgManifests.set(id, pj)
      if (typeof pj.name === 'string') name = pj.name
    }
    const scanBase = dir === '.' ? 'src' : `${dir}/src`
    const files = walkDir(root, scanBase, isProductionTsFile)
    for (const f of files) knownFiles.add(f)
    filesByPkg.set(id, files)
    pkgs.push({ id, name, dir, entryFiles: new Set() })
  }

  const pkgRoot = path.join(root, 'packages')
  if (existsSync(pkgRoot)) {
    for (const ent of readdirSync(pkgRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (ent.name === 'channels') {
        const chRoot = path.join(pkgRoot, 'channels')
        if (existsSync(chRoot)) {
          for (const ch of readdirSync(chRoot, { withFileTypes: true })) {
            if (ch.isDirectory()) registerPkg(`channels/${ch.name}`, `packages/channels/${ch.name}`)
          }
        }
      } else {
        registerPkg(ent.name, `packages/${ent.name}`)
      }
    }
  } else if (existsSync(path.join(root, 'src'))) {
    registerPkg('root', '.')
  }

  for (const pkg of pkgs) {
    const pj = rawPkgManifests.get(pkg.id)
    if (!pj) continue
    const rawEntries = [
      ...(typeof pj.main === 'string' ? [pj.main] : []),
      ...(typeof pj.module === 'string' ? [pj.module] : []),
      ...collectExportTargets(pj.exports),
      ...collectExportTargets(pj.bin),
    ]
    for (const raw of rawEntries) {
      if (raw.includes('*')) continue
      const clean = raw.replace(/^\.\//, '')
      const direct = resolveFromKnownSet(knownFiles, path.posix.normalize(`${pkg.dir}/${clean}`))
      if (direct) {
        pkg.entryFiles.add(direct)
        continue
      }
      if (clean.startsWith('dist/')) {
        const srcGuess = clean.replace(/^dist\//, 'src/').replace(/\.(m|c)?js$/, '')
        const mapped = resolveFromKnownSet(knownFiles, path.posix.normalize(`${pkg.dir}/${srcGuess}`))
        if (mapped) pkg.entryFiles.add(mapped)
      }
    }
  }

  pkgs.sort((a, b) => a.id.localeCompare(b.id))
  const pkgByName = new Map(pkgs.map((p) => [p.name, p]))
  return { pkgs, pkgByName, filesByPkg, knownFiles }
}

function buildLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function lineAtOffset(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid]! <= pos) lo = mid + 1
    else hi = mid - 1
  }
  return lo
}

function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text)
  else if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) collectBindingNames(el.name, out)
  } else if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (ts.isBindingElement(el)) collectBindingNames(el.name, out)
  }
}

function hasMod(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind)
}

function parseFileGraph(
  file: string,
  pkgId: string,
  isEntrypoint: boolean,
  sourceText: string,
): FileAstGraph {
  const sf = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const lineStarts = buildLineStarts(sourceText)
  const lineOf = (n: ts.Node) => lineAtOffset(lineStarts, n.pos + 1)
  const exports: ExportDeclInfo[] = []
  const exportAllSpecs: string[] = []
  const imports: ImportEdgeInfo[] = []
  const namespaceLocals = new Map<string, string>()

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text
      const clause = stmt.importClause
      if (!clause) {
        imports.push({ spec, importedNames: [] })
      } else {
        const names: string[] = []
        if (clause.name) names.push('default')
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            namespaceLocals.set(clause.namedBindings.name.text, spec)
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              names.push((el.propertyName ?? el.name).text)
            }
          }
        }
        if (!clause.namedBindings || !ts.isNamespaceImport(clause.namedBindings) || names.length > 0) {
          imports.push({ spec, importedNames: names })
        }
      }
      continue
    }

    if (ts.isExportDeclaration(stmt)) {
      const modSpec =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined
      if (!stmt.exportClause) {
        if (modSpec) {
          exportAllSpecs.push(modSpec)
          imports.push({ spec: modSpec, importedNames: '*' })
        }
      } else if (ts.isNamespaceExport(stmt.exportClause)) {
        exports.push({ symbol: stmt.exportClause.name.text, kind: 'reexport', line: lineOf(stmt) })
        if (modSpec) imports.push({ spec: modSpec, importedNames: '*' })
      } else if (ts.isNamedExports(stmt.exportClause)) {
        const remoteNames: string[] = []
        for (const el of stmt.exportClause.elements) {
          const remote = (el.propertyName ?? el.name).text
          remoteNames.push(remote)
          exports.push({
            symbol: el.name.text,
            kind: 'reexport',
            line: lineOf(el),
            viaModuleSpec: modSpec,
            viaRemoteName: modSpec ? remote : undefined,
          })
        }
        if (modSpec) imports.push({ spec: modSpec, importedNames: remoteNames })
      }
      continue
    }

    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      exports.push({ symbol: 'default', kind: 'default', line: lineOf(stmt) })
      continue
    }
    if (!hasMod(stmt, ts.SyntaxKind.ExportKeyword)) continue
    const isDef = hasMod(stmt, ts.SyntaxKind.DefaultKeyword)

    if (ts.isFunctionDeclaration(stmt)) {
      if (!stmt.body && exports.some((e) => e.symbol === (stmt.name?.text ?? 'default'))) continue
      exports.push({
        symbol: isDef ? 'default' : (stmt.name?.text ?? 'default'),
        kind: isDef ? 'default' : 'function',
        line: lineOf(stmt),
      })
    } else if (ts.isClassDeclaration(stmt)) {
      exports.push({
        symbol: isDef ? 'default' : (stmt.name?.text ?? 'default'),
        kind: isDef ? 'default' : 'class',
        line: lineOf(stmt),
      })
    } else if (ts.isInterfaceDeclaration(stmt)) {
      exports.push({ symbol: stmt.name.text, kind: 'interface', line: lineOf(stmt) })
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      exports.push({ symbol: stmt.name.text, kind: 'type', line: lineOf(stmt) })
    } else if (ts.isEnumDeclaration(stmt)) {
      exports.push({ symbol: stmt.name.text, kind: 'enum', line: lineOf(stmt) })
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const bound: string[] = []
        collectBindingNames(decl.name, bound)
        for (const b of bound) exports.push({ symbol: b, kind: 'variable', line: lineOf(decl) })
      }
    }
  }

  const namespacePropUses = new Map<string, Set<string>>()
  const namespaceWholeUses = new Set<string>()
  const hasNs = namespaceLocals.size > 0
  const hasDynCandidate = hasNs || sourceText.includes('import(') || sourceText.includes('require(')

  if (hasDynCandidate) {
    const visitExprs = (node: ts.Node, parent: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const isDyn = callee.kind === ts.SyntaxKind.ImportKeyword
        const isReq = ts.isIdentifier(callee) && callee.text === 'require'
        if ((isDyn || isReq) && node.arguments.length > 0) {
          const a0 = node.arguments[0]!
          if (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) {
            imports.push({ spec: a0.text, importedNames: '*' })
          }
        }
      } else if (hasNs && ts.isIdentifier(node) && namespaceLocals.has(node.text)) {
        if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
          let s = namespacePropUses.get(node.text)
          if (!s) {
            s = new Set()
            namespacePropUses.set(node.text, s)
          }
          s.add(parent.name.text)
        } else if (ts.isQualifiedName(parent) && parent.left === node) {
          let s = namespacePropUses.get(node.text)
          if (!s) {
            s = new Set()
            namespacePropUses.set(node.text, s)
          }
          s.add(parent.right.text)
        } else {
          namespaceWholeUses.add(node.text)
        }
      }
      ts.forEachChild(node, (c) => visitExprs(c, node))
    }
    ts.forEachChild(sf, (c) => visitExprs(c, sf))
  }

  for (const [nsLocal, spec] of namespaceLocals) {
    imports.push({
      spec,
      importedNames: namespaceWholeUses.has(nsLocal) ? '*' : [...(namespacePropUses.get(nsLocal) ?? [])],
    })
  }

  const dedupedExports: ExportDeclInfo[] = []
  const seenSyms = new Set<string>()
  for (const e of exports) {
    if (!seenSyms.has(e.symbol)) {
      seenSyms.add(e.symbol)
      dedupedExports.push(e)
    }
  }
  return { file, pkgId, isEntrypoint, exports: dedupedExports, exportAllSpecs, imports }
}

export function analyzeDeadCode(root: string): DeadCodeReport {
  const { pkgs, pkgByName, filesByPkg, knownFiles } = loadPackagesAndFiles(root)
  const graphs = new Map<string, FileAstGraph>()
  const resolveMemo = new Map<string, string | null>()

  const resolveImport = (fromFile: string, spec: string): string | null => {
    const dir = spec.startsWith('.') ? path.posix.dirname(fromFile) : '@'
    const memoKey = `${dir}\0${spec}`
    if (resolveMemo.has(memoKey)) return resolveMemo.get(memoKey)!
    let res: string | null = null
    if (spec.startsWith('.')) {
      res = resolveFromKnownSet(knownFiles, path.posix.normalize(path.posix.join(dir, spec)))
    } else if (spec.startsWith('@') || pkgs.some((p) => spec === p.name || spec.startsWith(`${p.name}/`))) {
      let pkg = pkgByName.get(spec)
      let sub = ''
      if (!pkg) {
        for (const p of pkgs) {
          if (spec.startsWith(`${p.name}/`)) {
            pkg = p
            sub = spec.slice(p.name.length + 1)
            break
          }
        }
      }
      if (pkg) {
        res = sub
          ? (resolveFromKnownSet(knownFiles, `${pkg.dir}/src/${sub}`) ??
            resolveFromKnownSet(knownFiles, `${pkg.dir}/${sub}`))
          : resolveFromKnownSet(knownFiles, `${pkg.dir}/src/index`)
      }
    }
    resolveMemo.set(memoKey, res)
    return res
  }

  for (const pkg of pkgs) {
    for (const rel of filesByPkg.get(pkg.id) ?? []) {
      const text = readFileSync(path.join(root, rel), 'utf8')
      graphs.set(rel, parseFileGraph(rel, pkg.id, isEntrypointFile(rel, pkg.entryFiles), text))
    }
  }

  const incomingEdges = new Map<string, Set<string>>()
  const referencedSymbols = new Map<string, Set<string>>()
  for (const file of graphs.keys()) {
    incomingEdges.set(file, new Set())
    referencedSymbols.set(file, new Set())
  }

  const propagated = new Set<string>()
  const markSymbolUsed = (targetFile: string, sym: string): void => {
    const visitKey = `${targetFile}::${sym}`
    if (propagated.has(visitKey)) return
    propagated.add(visitKey)
    const g = graphs.get(targetFile)
    if (!g) return

    if (sym === '*') {
      for (const e of g.exports) {
        referencedSymbols.get(targetFile)!.add(e.symbol)
        if (e.viaModuleSpec && e.viaRemoteName) {
          const sub = resolveImport(targetFile, e.viaModuleSpec)
          if (sub && graphs.has(sub)) markSymbolUsed(sub, e.viaRemoteName)
        }
      }
      for (const starSpec of g.exportAllSpecs) {
        const sub = resolveImport(targetFile, starSpec)
        if (sub && graphs.has(sub)) markSymbolUsed(sub, '*')
      }
      return
    }

    referencedSymbols.get(targetFile)!.add(sym)
    const matchingExp = g.exports.find((e) => e.symbol === sym)
    if (matchingExp?.viaModuleSpec && matchingExp.viaRemoteName) {
      const sub = resolveImport(targetFile, matchingExp.viaModuleSpec)
      if (sub && graphs.has(sub)) markSymbolUsed(sub, matchingExp.viaRemoteName)
    } else if (!matchingExp) {
      for (const starSpec of g.exportAllSpecs) {
        const sub = resolveImport(targetFile, starSpec)
        if (sub && graphs.has(sub)) markSymbolUsed(sub, sym)
      }
    }
  }

  for (const g of graphs.values()) {
    if (g.isEntrypoint) markSymbolUsed(g.file, '*')
    for (const imp of g.imports) {
      const target = resolveImport(g.file, imp.spec)
      if (!target || target === g.file || !graphs.has(target)) continue
      incomingEdges.get(target)!.add(g.file)
      if (imp.importedNames === '*') markSymbolUsed(target, '*')
      else for (const name of imp.importedNames) markSymbolUsed(target, name)
    }
  }

  for (const dir of ['scripts', ...pkgs.map((p) => `${p.dir}/scripts`)]) {
    if (!existsSync(path.join(root, dir))) continue
    for (const sfRel of walkDir(root, dir, (r) => /\.(ts|tsx|mts)$/.test(r) && !/\.test\./.test(r))) {
      const parsed = parseFileGraph(sfRel, '_scripts', true, readFileSync(path.join(root, sfRel), 'utf8'))
      for (const imp of parsed.imports) {
        const target = resolveImport(sfRel, imp.spec)
        if (!target || !graphs.has(target)) continue
        incomingEdges.get(target)!.add(sfRel)
        if (imp.importedNames === '*') markSymbolUsed(target, '*')
        else for (const name of imp.importedNames) markSymbolUsed(target, name)
      }
    }
  }

  const unusedExports: UnusedExportItem[] = []
  const orphanFiles: OrphanFileItem[] = []
  const byPackage: Record<string, PackageDeadCodeSummary> = {}
  for (const pkg of pkgs) {
    byPackage[pkg.id] = {
      scannedFiles: 0,
      entrypointFiles: 0,
      totalExports: 0,
      unusedExportCount: 0,
      orphanFileCount: 0,
    }
  }

  let entrypointFiles = 0
  let totalExports = 0
  for (const g of graphs.values()) {
    const pkgStats = byPackage[g.pkgId]!
    pkgStats.scannedFiles++
    pkgStats.totalExports += g.exports.length
    totalExports += g.exports.length
    if (g.isEntrypoint) {
      entrypointFiles++
      pkgStats.entrypointFiles++
      continue
    }
    if ((incomingEdges.get(g.file)?.size ?? 0) === 0) {
      orphanFiles.push({ package: g.pkgId, file: g.file, exports: g.exports.map((e) => e.symbol) })
      pkgStats.orphanFileCount++
    }
    const used = referencedSymbols.get(g.file)!
    for (const exp of g.exports) {
      if (!used.has(exp.symbol)) {
        unusedExports.push({
          package: g.pkgId,
          file: g.file,
          symbol: exp.symbol,
          kind: exp.kind,
          line: exp.line,
        })
        pkgStats.unusedExportCount++
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      scannedFiles: graphs.size,
      entrypointFiles,
      totalExports,
      unusedExportCount: unusedExports.length,
      orphanFileCount: orphanFiles.length,
    },
    unusedExports,
    orphanFiles,
    byPackage,
  }
}

export function main(argv = process.argv.slice(2)): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let outPath = ''
  let printJson = false

  const argErr = (msg: string): number => {
    console.error(`[dead-code-weekly] ${msg}`)
    return 2
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') {
      const v = argv[++i]
      if (!v) return argErr('--root requires a path')
      root = path.resolve(v)
    } else if (arg === '--out') {
      const v = argv[++i]
      if (!v) return argErr('--out requires a file path')
      outPath = path.resolve(v)
    } else if (arg.startsWith('--out=')) outPath = path.resolve(arg.slice('--out='.length))
    else if (arg === '--json') printJson = true
    else return argErr(`unknown argument: ${arg}`)
  }

  try {
    const report = analyzeDeadCode(root)
    if (outPath) {
      mkdirSync(path.dirname(outPath), { recursive: true })
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    }
    if (printJson) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(
        `[dead-code-weekly] files=${report.summary.scannedFiles} entrypoints=${report.summary.entrypointFiles} exports=${report.summary.totalExports} unusedExports=${report.summary.unusedExportCount} orphanFiles=${report.summary.orphanFileCount}${outPath ? ` out=${outPath}` : ''}`,
      )
    }
    return 0
  } catch (err) {
    console.error(`[dead-code-weekly] FAIL: ${(err as Error).message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
