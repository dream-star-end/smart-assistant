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
    calls(rejected.thenStatement, 'releaseRecoveryPreReceipt').length !== 0 ||
    calls(rejected.thenStatement, 'casToTerminal').length !== 1) fail('rejected receipts must keep durable convergence and be consumed')
  const terminal = calls(rejected.thenStatement, 'casToTerminal')[0]!
  const options = terminal.arguments[1]
  if (text(terminal.arguments[0]!) !== 'pool' || !options || !ts.isObjectLiteralExpression(options)) {
    fail('rejected receipts must terminalize through the bridge pool')
  }
  const fields = new Map(options.properties.filter(ts.isPropertyAssignment).map(property => [text(property.name), text(property.initializer)]))
  for (const [name, value] of [['dispatchId', 'rec.dispatchId'], ['outcome', "'not_accepted'"],
    ['fromStatuses', "['admitted']"], ['expectedEpoch', 'rec.leaseEpoch']]) {
    if (fields.get(name) !== value) fail(`rejected receipts must retain terminal ${name}`)
  }
  // Historical rows keep the literal. The attachment-total helper is the only
  // other accepted form, and only when it forwards this receipt's own code.
  const failureCode = fields.get('failureCode')
  const historicalFailureCode = "'DISPATCH_NOT_ACCEPTED'"
  const attachmentFailureCode = "rejectedDispatchFailureCode({kind:'ok',userFailureCode:receipt.userFailureCode})"
  if (failureCode !== historicalFailureCode && failureCode !== attachmentFailureCode) {
    fail('rejected receipts must retain terminal failureCode')
  }
  if (failureCode === attachmentFailureCode) {
    const imported = receipt.statements.some(node => ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '../dispatch/attachmentTotalFailure.js' &&
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(element => element.name.text === 'rejectedDispatchFailureCode' && !element.propertyName))
    if (!imported) fail('attachment-total failure codes must come from the canonical helper')
  }
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

function importsFromProtocol(file: ts.SourceFile, name: string): boolean {
  return file.statements.some(node => ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@openclaude/protocol' &&
    node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.some(element => element.name.text === name && !element.propertyName))
}

function isIdleRecoveryTemplate(expr: ts.Expression): boolean {
  if (!ts.isTemplateExpression(expr)) return false
  if (expr.head.text !== 'IDLE_RECOVERY_PENDING:') return false
  if (expr.templateSpans.length !== 1) return false
  const span = expr.templateSpans[0]!
  return ts.isIdentifier(span.expression) && span.expression.text === 'minutes' && span.literal.text === ''
}

function hasIdleMinutesBinding(statement: ts.ReturnStatement, fnBody: ts.Block): boolean {
  let cursor: ts.Node | undefined = statement.parent
  while (cursor) {
    if (ts.isBlock(cursor)) {
      for (let i = cursor.statements.length - 1; i >= 0; i--) {
        const stmt = cursor.statements[i]!
        if (stmt.end > statement.getStart()) continue
        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'minutes') return false
        if (ts.isVariableStatement(stmt)) {
          const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
          for (let j = stmt.declarationList.declarations.length - 1; j >= 0; j--) {
            const decl = stmt.declarationList.declarations[j]!
            if (ts.isIdentifier(decl.name) && decl.name.text === 'minutes') {
              return Boolean(
                isConst && decl.initializer && ts.isCallExpression(decl.initializer) &&
                text(decl.initializer.expression) === 'parseIdleRecoveryPending' &&
                decl.initializer.arguments.length === 1 &&
                text(decl.initializer.arguments[0]!) === 'res.userFailureCode',
              )
            }
          }
        }
      }
    }
    if (cursor === fnBody) break
    cursor = cursor.parent
  }
  return false
}

/** Reachable returns may only be DISPATCH_NOT_ACCEPTED, the parsed byte count,
 * or an idle-recovery pending interval parsed by the protocol helper.
 * Dead returns and local shadows of the protocol helpers do not count. */
export function assertRejectedDispatchFailureHelper(source: string): void {
  const file = parse('attachmentTotalFailure.ts', source)
  const imported = ['attachmentTotalExceededFailureCode', 'parseAttachmentTotalExceeded'].every(name =>
    importsFromProtocol(file, name))
  if (!imported) fail('attachment-total codes must be imported from protocol')
  const protectedHelpers = new Set([
    'attachmentTotalExceededFailureCode',
    'parseAttachmentTotalExceeded',
    'parseIdleRecoveryPending',
  ])
  let shadow = false
  function see(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && protectedHelpers.has(node.name.text)) {
      shadow = true
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) && protectedHelpers.has(node.name.text)) {
      shadow = true
    }
    if (ts.isImportSpecifier(node) && protectedHelpers.has(node.name.text)) {
      const decl = node.parent?.parent?.parent
      if (!decl || !ts.isImportDeclaration(decl) || !ts.isStringLiteral(decl.moduleSpecifier) ||
        decl.moduleSpecifier.text !== '@openclaude/protocol' || Boolean(node.propertyName)) {
        shadow = true
      }
    }
    ts.forEachChild(node, see)
  }
  see(file)
  if (shadow) fail('protocol attachment helpers must not be shadowed')
  const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'rejectedDispatchFailureCode')
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body ||
    !fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    fail('rejectedDispatchFailureCode must stay exported')
  }
  const reachable = reachableReturns(fn.body)
  let sawHistorical = false
  let sawAttachment = false
  let sawIdleRecovery = false
  for (const statement of reachable.returns) {
    const expr = statement.expression
    if (expr && ts.isStringLiteral(expr) && expr.text === 'DISPATCH_NOT_ACCEPTED') {
      sawHistorical = true
      continue
    }
    if (expr && ts.isCallExpression(expr) && text(expr.expression) === 'attachmentTotalExceededFailureCode' &&
      expr.arguments.length === 1 && text(expr.arguments[0]!) === 'parsed.totalBytes') {
      sawAttachment = true
      continue
    }
    if (expr && isIdleRecoveryTemplate(expr) && hasIdleMinutesBinding(statement, fn.body)) {
      sawIdleRecovery = true
      continue
    }
    fail('rejectedDispatchFailureCode must return only terminal codes')
  }
  if (!sawHistorical || !sawAttachment) fail('rejectedDispatchFailureCode must keep both terminal returns')
  if (sawIdleRecovery && !importsFromProtocol(file, 'parseIdleRecoveryPending')) {
    fail('idle-recovery codes must be imported from protocol')
  }
}

function reachableReturns(node: ts.Node): { returns: ts.ReturnStatement[]; always: boolean } {
  if (ts.isBlock(node)) {
    const returns: ts.ReturnStatement[] = []
    for (const statement of node.statements) {
      const part = reachableReturns(statement)
      returns.push(...part.returns)
      if (part.always) return { returns, always: true }
    }
    return { returns, always: false }
  }
  if (ts.isReturnStatement(node)) return { returns: [node], always: true }
  if (ts.isIfStatement(node)) {
    const thenPart = reachableReturns(node.thenStatement)
    const elsePart = node.elseStatement ? reachableReturns(node.elseStatement) : { returns: [], always: false }
    return { returns: [...thenPart.returns, ...elsePart.returns], always: thenPart.always && elsePart.always }
  }
  return { returns: [], always: false }
}
