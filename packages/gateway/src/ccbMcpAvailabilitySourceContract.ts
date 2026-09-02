/**
 * AST inspector for CCB prompt-context availableMcpTools wiring.
 * 仅供测试/deploy-gate 使用，不要从运行时代码导入。
 *
 * Structural rules only (no type checker). Fail closed on shadowing,
 * shorthand/computed keys, duplicate keys, and post-property spreads.
 */
import ts from 'typescript'

export type CcbPromptContextAvailabilityBinding = {
  /** buildPromptContext(...) 调用中 availableMcpTools 属性值的源码文本，没找到则 null */
  availableMcpToolsInitializer: string | null
  /** `const projectedMcpTools = projectCcbMcpAvailability(...)` 声明是否存在 */
  projectionDeclared: boolean
  /** 文件内声明位置上名为 projectedMcpTools 的标识符个数 */
  projectionDeclarationCount: number
  /** 合格 availableMcpTools 之后的 spread / 同名覆盖节点文本 */
  overrideAfterProjection: string | null
  /** projectionDeclared 且唯一声明且每个调用都消费 Identifier projectedMcpTools 且无后置覆盖 */
  consumesProjection: boolean
}

const PROJECTED = 'projectedMcpTools'
const AVAILABLE = 'availableMcpTools'

function isProjectedIdentifier(node: ts.Node | undefined): boolean {
  return !!node && ts.isIdentifier(node) && node.text === PROJECTED
}

function isBuildPromptContextCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'buildPromptContext'
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === 'buildPromptContext'
  return false
}

function isProjectedMcpToolsDeclaration(node: ts.VariableDeclaration): boolean {
  if (!isProjectedIdentifier(node.name)) return false
  if (!node.initializer || !ts.isCallExpression(node.initializer)) return false
  return (
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === 'projectCcbMcpAvailability'
  )
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  }
  return null
}

function isComputedPropertyName(name: ts.PropertyName): boolean {
  return ts.isComputedPropertyName(name)
}

function isAvailableMcpToolsProperty(prop: ts.ObjectLiteralElementLike): boolean {
  if (ts.isSpreadAssignment(prop)) return false
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text === AVAILABLE
  if (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
    return staticPropertyName(prop.name) === AVAILABLE
  }
  return false
}

function availableMcpToolsPropertyText(prop: ts.ObjectLiteralElementLike): string {
  if (
    ts.isPropertyAssignment(prop) &&
    !isComputedPropertyName(prop.name) &&
    (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
  ) {
    return prop.initializer.getText()
  }
  return prop.getText()
}

function isQualifiedAvailableMcpTools(prop: ts.ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(prop)) return false
  if (isComputedPropertyName(prop.name)) return false
  if (staticPropertyName(prop.name) !== AVAILABLE) return false
  return ts.isIdentifier(prop.initializer) && prop.initializer.text === PROJECTED
}

function declarationSiteCount(node: ts.Node): number {
  if (ts.isVariableDeclaration(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isParameter(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isBindingElement(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isFunctionDeclaration(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isClassDeclaration(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isEnumDeclaration(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isTypeAliasDeclaration(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isInterfaceDeclaration(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isImportSpecifier(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isImportClause(node) && isProjectedIdentifier(node.name)) return 1
  if (ts.isNamespaceImport(node) && isProjectedIdentifier(node.name)) return 1
  return 0
}

type CallInspection = {
  initializerText: string | null
  consumes: boolean
  overrideAfter: string | null
}

function inspectBuildPromptContextCall(node: ts.CallExpression): CallInspection | null {
  if (!isBuildPromptContextCallee(node.expression)) return null
  const arg0 = node.arguments[0]
  if (!arg0 || !ts.isObjectLiteralExpression(arg0)) {
    return { initializerText: arg0?.getText() ?? null, consumes: false, overrideAfter: null }
  }

  let seenQualified = false
  let sawAvailable = false
  let allAvailableQualified = true
  let firstUnqualified: string | null = null
  let firstQualified: string | null = null
  let overrideAfter: string | null = null

  for (const prop of arg0.properties) {
    const isAvail = isAvailableMcpToolsProperty(prop)
    if (seenQualified && overrideAfter === null) {
      if (ts.isSpreadAssignment(prop) || isAvail) overrideAfter = prop.getText()
    }
    if (!isAvail) continue
    sawAvailable = true
    const qualified = isQualifiedAvailableMcpTools(prop)
    const text = availableMcpToolsPropertyText(prop)
    if (qualified) {
      firstQualified ??= text
      seenQualified = true
    } else {
      allAvailableQualified = false
      firstUnqualified ??= text
    }
  }

  return {
    initializerText: firstUnqualified ?? firstQualified,
    consumes: sawAvailable && allAvailableQualified && overrideAfter === null,
    overrideAfter,
  }
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
  let projectionDeclarationCount = 0
  let firstUnqualified: string | null = null
  let firstQualified: string | null = null
  let overrideAfterProjection: string | null = null
  let sawCall = false
  let allCallsConsume = true

  const visit = (node: ts.Node): void => {
    projectionDeclarationCount += declarationSiteCount(node)
    if (ts.isVariableDeclaration(node) && isProjectedMcpToolsDeclaration(node)) {
      projectionDeclared = true
    }
    if (ts.isCallExpression(node)) {
      const hit = inspectBuildPromptContextCall(node)
      if (hit) {
        sawCall = true
        if (hit.consumes) firstQualified ??= hit.initializerText
        else {
          allCallsConsume = false
          firstUnqualified ??= hit.initializerText
        }
        overrideAfterProjection ??= hit.overrideAfter
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const availableMcpToolsInitializer = firstUnqualified ?? firstQualified
  const consumesProjection =
    projectionDeclared &&
    projectionDeclarationCount === 1 &&
    sawCall &&
    allCallsConsume &&
    firstQualified !== null &&
    firstUnqualified === null &&
    overrideAfterProjection === null
  return {
    availableMcpToolsInitializer,
    projectionDeclared,
    projectionDeclarationCount,
    overrideAfterProjection,
    consumesProjection,
  }
}
