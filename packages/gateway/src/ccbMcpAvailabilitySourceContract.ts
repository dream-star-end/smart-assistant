/**
 * AST inspector for CCB prompt-context availableMcpTools wiring.
 * 仅供测试/deploy-gate 使用，不要从运行时代码导入。
 */
import ts from 'typescript'

export type CcbPromptContextAvailabilityBinding = {
  /** buildPromptContext(...) 调用中 availableMcpTools 属性值的源码文本，没找到则 null */
  availableMcpToolsInitializer: string | null
  /** `const projectedMcpTools = projectCcbMcpAvailability(...)` 声明是否存在 */
  projectionDeclared: boolean
  /** projectionDeclared 且 initializer 是标识符 projectedMcpTools */
  consumesProjection: boolean
}

function isBuildPromptContextCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'buildPromptContext'
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === 'buildPromptContext'
  return false
}

function isProjectedMcpToolsDeclaration(node: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(node.name) || node.name.text !== 'projectedMcpTools') return false
  if (!node.initializer || !ts.isCallExpression(node.initializer)) return false
  return (
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === 'projectCcbMcpAvailability'
  )
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  return null
}

function inspectAvailableMcpToolsArg(
  node: ts.CallExpression,
): { text: string; consumes: boolean } | null {
  if (!isBuildPromptContextCallee(node.expression)) return null
  const arg0 = node.arguments[0]
  if (!arg0 || !ts.isObjectLiteralExpression(arg0)) return null
  for (const prop of arg0.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    if (staticPropertyName(prop.name) !== 'availableMcpTools') continue
    const initializer = prop.initializer
    return {
      text: initializer.getText(),
      consumes: ts.isIdentifier(initializer) && initializer.text === 'projectedMcpTools',
    }
  }
  return null
}

export function inspectCcbPromptContextAvailability(
  source: string,
): CcbPromptContextAvailabilityBinding {
  const sf = ts.createSourceFile(
    'subprocessRunner.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let projectionDeclared = false
  let firstUnqualified: string | null = null
  let firstQualified: string | null = null

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && isProjectedMcpToolsDeclaration(node)) {
      projectionDeclared = true
    }
    if (ts.isCallExpression(node)) {
      const hit = inspectAvailableMcpToolsArg(node)
      if (hit) {
        if (hit.consumes) firstQualified ??= hit.text
        else firstUnqualified ??= hit.text
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const availableMcpToolsInitializer = firstUnqualified ?? firstQualified
  const consumesProjection =
    projectionDeclared && firstQualified !== null && firstUnqualified === null
  return {
    availableMcpToolsInitializer,
    projectionDeclared,
    consumesProjection,
  }
}
