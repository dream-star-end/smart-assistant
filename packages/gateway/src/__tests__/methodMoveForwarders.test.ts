/**
 * FINDINGS §7.6: methods moved out of Gateway / SessionManager keep one-line forwarders
 * `name(...) { return nameImpl.call(this as unknown as Host, ...) }`.
 *
 * A forwarder must NOT be `async`: an async wrapper returning the impl's promise settles a few
 * microtask ticks later than the original async method did. Without `async` it returns the impl's own
 * promise (the impl is the original body as an async function), so settlement timing is unchanged.
 * A `: void` forwarder must not `return` the call.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/methodMoveForwarders.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))

function isLiteralDefault(e: ts.Expression): boolean {
  return (
    ts.isLiteralExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined') ||
    (ts.isArrayLiteralExpression(e) && e.elements.length === 0) ||
    (ts.isObjectLiteralExpression(e) && e.properties.length === 0) ||
    (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))
  )
}

function forwarders(file: string) {
  const text = readFileSync(join(here, '..', file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: { name: string; isAsync: boolean; voidReturn: boolean }[] = []
  const visit = (n: ts.Node) => {
    if (ts.isMethodDeclaration(n) && n.body && n.body.statements.length === 1) {
      const st = n.body.statements[0]
      const expr = ts.isReturnStatement(st)
        ? st.expression
        : ts.isExpressionStatement(st)
          ? st.expression
          : undefined
      if (
        expr &&
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        expr.expression.name.text === 'call' &&
        /Impl$/.test(expr.expression.expression.getText(sf)) &&
        expr.arguments[0]?.getText(sf).startsWith('this as unknown as ')
      ) {
        out.push({
          name: n.name.getText(sf),
          // async is kept only when a parameter default could throw (it must reject, not throw)
          isAsync:
            !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
            n.parameters.every((p) => !p.initializer || isLiteralDefault(p.initializer)),
          voidReturn: n.type?.kind === ts.SyntaxKind.VoidKeyword && ts.isReturnStatement(st),
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('method-move forwarders keep the original promise timing', () => {
  for (const file of ['server.ts', 'sessionManager.ts']) {
    it(`${file}: no async forwarder, no value returned from a void forwarder`, () => {
      const fwd = forwarders(file)
      assert.ok(fwd.length > 0, `${file} has no forwarders — the move pattern changed?`)
      assert.deepEqual(
        fwd.filter((f) => f.isAsync).map((f) => f.name),
        [],
      )
      assert.deepEqual(
        fwd.filter((f) => f.voidReturn).map((f) => f.name),
        [],
      )
    })
  }
})
