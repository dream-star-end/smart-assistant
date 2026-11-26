/**
 * Sandboxed L0 REST contract loader for `scripts/check-rest-contract-compat.ts` (OCV5-903 B4).
 *
 * Reads `<root>/packages/protocol/src/httpContracts.ts`, verifies TypeScript AST purity
 * (only `@sinclair/typebox` import, zero ambient Node/FS/process/dynamic code), transpiles,
 * and evaluates inside an isolated `node:vm` context with a 5s timeout so external referee
 * invocations strictly inspect `--root <candidateDir>`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

export interface SerializedRouteContract {
  domain: string
  method: string
  path: string
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  request?: Record<string, unknown>
  response: Record<string, unknown>
}

export interface RestContractSnapshot {
  schema: 1
  domains: readonly string[]
  routes: Record<string, SerializedRouteContract>
}

export const DEFAULT_CONTRACTS_SOURCE_PATH = 'packages/protocol/src/httpContracts.ts'

const ALLOWED_CONTRACT_IMPORTS = new Set(['@sinclair/typebox'])
const FORBIDDEN_CONTRACT_IDENTIFIERS = new Set([
  'process',
  'globalThis',
  'global',
  'require',
  'eval',
  'Function',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
])

const localRequire = createRequire(import.meta.url)

/**
 * AST pre-check ensuring `<root>/packages/protocol/src/httpContracts.ts` remains a pure L0
 * TypeBox declaration file (only `@sinclair/typebox` import, zero Node/FS/process/dynamic code)
 * before evaluating it inside an isolated `node:vm` context.
 */
export function assertPureHttpContractsAst(filePath: string, sourceText: string): void {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text
      if (!ALLOWED_CONTRACT_IMPORTS.has(mod)) {
        throw new Error(
          `${filePath}: disallowed runtime import ${JSON.stringify(mod)} (only @sinclair/typebox is permitted in L0 httpContracts.ts)`,
        )
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`${filePath}: dynamic import() is forbidden in L0 httpContracts.ts`)
    }
    if (ts.isIdentifier(node) && FORBIDDEN_CONTRACT_IDENTIFIERS.has(node.text)) {
      const parent = node.parent
      const isPropertyKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isTypeReferenceNode(parent) && parent.typeName === node)
      if (!isPropertyKey) {
        throw new Error(
          `${filePath}: forbidden ambient identifier ${JSON.stringify(node.text)} in L0 httpContracts.ts`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

/**
 * Load & serialize live REST contracts strictly from `<root>/packages/protocol/src/httpContracts.ts`
 * inside a sandboxed `node:vm` context (zero imports escaping external referee scripts!).
 */
export function loadLiveRestContractSnapshot(
  root: string,
  contractsRel = DEFAULT_CONTRACTS_SOURCE_PATH,
): RestContractSnapshot {
  const contractsAbs = path.resolve(root, contractsRel)
  if (!existsSync(contractsAbs)) {
    throw new Error(`REST contract source not found under --root: ${contractsAbs}`)
  }
  const sourceText = readFileSync(contractsAbs, 'utf8')
  assertPureHttpContractsAst(contractsRel, sourceText)

  const transpiled = ts.transpileModule(sourceText, {
    fileName: contractsAbs,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  })
  const fatalDiag = (transpiled.diagnostics ?? []).find(
    (d) => d.category === ts.DiagnosticCategory.Error,
  )
  if (fatalDiag) {
    throw new Error(
      `failed to transpile ${contractsRel}: ${ts.flattenDiagnosticMessageText(fatalDiag.messageText, '\n')}`,
    )
  }

  const typebox = localRequire('@sinclair/typebox') as Record<string, unknown>
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  const sandbox = vm.createContext({
    exports: moduleObj.exports,
    module: moduleObj,
    require: (specifier: string) => {
      if (specifier === '@sinclair/typebox') return typebox
      throw new Error(`sandboxed httpContracts.ts cannot require(${JSON.stringify(specifier)})`)
    },
  })
  vm.runInContext(transpiled.outputText, sandbox, {
    filename: contractsAbs,
    timeout: 5000,
  })

  const serializeFn = moduleObj.exports.serializeRestContractSnapshot
  if (typeof serializeFn !== 'function') {
    throw new Error(`${contractsRel} does not export serializeRestContractSnapshot()`)
  }
  const snap = (serializeFn as () => unknown)() as RestContractSnapshot
  if (!snap || snap.schema !== 1 || typeof snap.routes !== 'object' || snap.routes === null) {
    throw new Error(`${contractsRel} serializeRestContractSnapshot() returned invalid snapshot`)
  }
  return snap
}
