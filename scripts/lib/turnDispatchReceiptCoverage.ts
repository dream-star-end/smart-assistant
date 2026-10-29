import ts from 'typescript'

function fail(reason: string): never {
  throw new Error(`[turn-dispatch-receipt-coverage] ${reason}`)
}
function parse(name: string, source: string): ts.SourceFile {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
    fail(`${name} must parse without syntax errors`)
  }
  return file
}
function text(node: ts.Node): string {
  return node.getText().replace(/\s/g, '')
}
function calls(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child) && text(child.expression) === name) found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}
function returns(node: ts.Statement, value?: string): boolean {
  if (ts.isReturnStatement(node)) return value === undefined || node.expression && text(node.expression) === value || false
  return ts.isBlock(node) && node.statements.some(statement => returns(statement, value))
}

/** Source guard only: require the extracted code to remain wired into the
 * actual receive path, with rejected convergence and the synchronous fence. */
export function assertTurnDispatchReceiptCoverage(bridgeSource: string, receiptSource: string): void {
  const bridge = parse('userChatBridge.ts', bridgeSource)
  const receipt = parse('turnDispatchReceipt.ts', receiptSource)
  const imported = bridge.statements.some(node => ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './turnDispatchReceipt.js' &&
    node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.some(element => element.name.text === 'handleTurnDispatchReceipt' && !element.propertyName))
  if (!imported) fail('bridge must import the real receipt handler')
  const handlers = calls(bridge, 'handleTurnDispatchReceipt')
  if (handlers.length !== 1) fail('bridge must call the receipt handler exactly once')
  const call = handlers[0]!
  if (call.arguments.length !== 2 || text(call.arguments[0]!) !== 'attestPeek' ||
    !ts.isObjectLiteralExpression(call.arguments[1]!)) fail('bridge must pass the received frame and receipt context')
  if (!ts.isIfStatement(call.parent) || call.parent.expression !== call || !returns(call.parent.thenStatement)) {
    fail('a consumed receipt must return from the bridge receive path')
  }
  const context = call.arguments[1] as ts.ObjectLiteralExpression
  const properties = new Map(context.properties.filter((property): property is ts.ShorthandPropertyAssignment | ts.PropertyAssignment =>
    ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)).map(property => [text(property.name), property]))
  for (const name of ['uid', 'admittedDispatches', 'enrichmentDispatches', 'claimEnrichmentTerminalization',
    'acceptEnrichmentReceipt', 'dropAdmittedDispatch', 'settleCronOriginClaim', 'noteDispatchStreamFrame']) {
    const property = properties.get(name)
    if (!property || !(ts.isShorthandPropertyAssignment(property) ||
      ts.isPropertyAssignment(property) && text(property.initializer) === name)) fail(`missing bridge context: ${name}`)
  }
  const pool = properties.get('pool')
  if (!pool || !ts.isPropertyAssignment(pool) || text(pool.initializer) !== 'deps.pgPool') fail('receipt must use the bridge PG pool')
  for (const [name, target] of [['hasCronOriginClaim', 'cronOriginClaimWaiters.has'], ['broadcast', 'broadcastToUser']] as const) {
    const property = properties.get(name)
    if (!property || !ts.isPropertyAssignment(property) || !ts.isArrowFunction(property.initializer) ||
      calls(property.initializer.body, target).length !== 1) fail(`missing bridge receipt callback: ${name}`)
  }

  const handler = receipt.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleTurnDispatchReceipt')
  if (!handler || !ts.isFunctionDeclaration(handler) || !handler.body ||
    !handler.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) fail('receipt handler must be exported')
  const classifications = calls(handler.body, 'classifyTurnDispatchReceipt')
  if (classifications.length !== 1 || classifications[0]!.arguments.map(text).join(',') !== 'receipt,rec') {
    fail('receipt identity must be classified against its admitted record')
  }
  const classification = classifications[0]!
  if (!ts.isVariableDeclaration(classification.parent) || text(classification.parent.name) !== 'disposition') {
    fail('classification must drive receipt disposition')
  }
  const rejected = handler.body.statements.find(statement => ts.isIfStatement(statement) &&
    ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    text(statement.expression.left) === 'disposition' && ts.isStringLiteral(statement.expression.right) &&
    statement.expression.right.text === 'rejected')
  if (!rejected || !ts.isIfStatement(rejected) || !returns(rejected.thenStatement, 'true') ||
    calls(rejected.thenStatement, 'releaseRecoveryPreReceipt').length !== 1 ||
    calls(rejected.thenStatement, 'casToTerminal').length !== 1) fail('rejected receipts must keep durable convergence and be consumed')
  const fence = handler.body.statements.find(statement => ts.isIfStatement(statement) &&
    ts.isPrefixUnaryExpression(statement.expression) && statement.expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isCallExpression(statement.expression.operand) && text(statement.expression.operand.expression) === 'context.acceptEnrichmentReceipt' &&
    statement.expression.operand.arguments.map(text).join(',') === 'rec')
  if (!fence || !ts.isIfStatement(fence) || !returns(fence.thenStatement, 'true')) fail('receipt must retain its synchronous enrichment fence')
  const progress = calls(handler.body, 'context.noteDispatchStreamFrame')[0]
  const accepted = calls(handler.body, 'casAdmittedToAccepted')[0]
  if (!progress || !accepted || rejected.end > fence.getStart() || fence.end > progress.getStart() ||
    fence.end > accepted.getStart()) fail('rejection and enrichment fence must run before acceptance')
}
