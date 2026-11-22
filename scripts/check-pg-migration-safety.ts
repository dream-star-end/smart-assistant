/**
 * PostgreSQL Zero-Downtime Expand-Contract Static Migration Safety Gate.
 *
 * Mechanically blocks 8 classes of table-locking, transaction-crashing, or
 * rolling-upgrade-breaking DDL in PostgreSQL migrations
 * (`packages/commercial/src/db/migrations/*.sql`):
 *   1. PG-BAN-DROP-TABLE                      — `DROP TABLE` (ignores temp tables created in same file / comments)
 *   2. PG-BAN-DROP-COLUMN                     — `ALTER TABLE ... DROP [COLUMN]`
 *   3. PG-BAN-RENAME                          — `ALTER TABLE ... RENAME TO` / `RENAME [COLUMN] ... TO`
 *   4. PG-BAN-TRUNCATE                        — `TRUNCATE` (ignores temp tables created in same file)
 *   5. PG-ADDING-REQUIRED-FIELD               — `ALTER TABLE ... ADD [COLUMN] ... NOT NULL` without `DEFAULT`
 *   6. PG-CHANGING-COLUMN-TYPE                — `ALTER TABLE ... ALTER [COLUMN] ... [SET DATA] TYPE`
 *   7. PG-LOCKING-INDEX-OR-CONSTRAINT         — `CREATE [UNIQUE] INDEX` without `CONCURRENTLY` (unless on a
 *                                               table created in the same migration) and
 *                                               `ALTER TABLE ... ADD [CONSTRAINT ...] CHECK/FOREIGN KEY` without `NOT VALID`
 *   8. PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION — `CREATE/DROP/REINDEX ... CONCURRENTLY` without a
 *                                               `-- no-transaction` header matching `packages/commercial/src/db/migrate.ts`
 *                                               (or inside a `DO $$ ... $$` block)
 *
 * Anti-bypass & trusted Boss approval:
 *   - `-- compat:` comments CANNOT bypass any rule in this gate.
 *   - Trusted CI escape hatch: `--approved-commit <40hex>` (requires `--base <ref>`, clean
 *     working/staging tree for migrations, and exact SHA match against HEAD or the last
 *     migration-touching commit in `<base>..HEAD`).
 *   - Local manual escape hatch: `OC_PG_MIGRATION_BOSS_APPROVED=1`.
 *
 * Optional `squawk` overlay:
 *   - If `squawk` is installed on PATH (and `--no-squawk` is not passed), its findings are layered on top.
 *   - Without `squawk`, built-in zero-dependency rules provide full <2s coverage.
 *
 * Usage:
 *   npx tsx scripts/check-pg-migration-safety.ts --base <git-ref> [--approved-commit <40hex>] [--root <repo>] [--no-squawk]
 *   npx tsx scripts/check-pg-migration-safety.ts --file <path> [--file <path> ...] [--no-squawk]
 *
 * Exit: 0 ok (or boss-approved), 1 violation(s) found, 2 usage/git/parse error (fail-closed).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BOSS_APPROVAL_ENV = 'OC_PG_MIGRATION_BOSS_APPROVED'
export const DEFAULT_MIGRATIONS_GLOB = 'packages/commercial/src/db/migrations/*.sql'

/**
 * Exact `-- no-transaction` marker recognized by `packages/commercial/src/db/migrate.ts:419`.
 * Any migration using `CONCURRENTLY` without this marker will be wrapped in `BEGIN...COMMIT`
 * by the migration runner and crash PostgreSQL at deploy time.
 */
export const NO_TRANSACTION_MARKER_RE = /^--\s*no-transaction\b/im

const SHA40_RE = /^[0-9a-f]{40}$/i

export type PgSafetyRuleId =
  | 'PG-BAN-DROP-TABLE'
  | 'PG-BAN-DROP-COLUMN'
  | 'PG-BAN-RENAME'
  | 'PG-BAN-TRUNCATE'
  | 'PG-ADDING-REQUIRED-FIELD'
  | 'PG-CHANGING-COLUMN-TYPE'
  | 'PG-LOCKING-INDEX-OR-CONSTRAINT'
  | 'PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION'
  | 'PG-SQUAWK-FINDING'

export interface PgSafetyViolation {
  rule: PgSafetyRuleId
  file: string
  line: number
  snippet: string
  why: string
  guidance: string
}

export interface PgMigrationSafetyResult {
  filesChecked: string[]
  violations: PgSafetyViolation[]
  unwaivedViolations: PgSafetyViolation[]
  bossApproved: boolean
  approvedVia?: 'env' | 'approved-commit' | 'approved-file'
  headSha?: string
  lastMigrationCommit?: string
  approvedCommit?: string
  approvedFiles?: string[]
  hasDirtyMigrationEdit?: boolean
}

interface SqlToken {
  kind: 'comment' | 'string' | 'ident' | 'semi' | 'code'
  value: string
  line: number
}

interface SqlStatement {
  line: number
  code: string
  dollarBodies: Array<{ body: string; line: number }>
}

const RULE_GUIDANCE: Readonly<Record<PgSafetyRuleId, { why: string; guidance: string }>> = {
  'PG-BAN-DROP-TABLE': {
    why: 'DROP TABLE takes an ACCESS EXCLUSIVE lock and immediately breaks running old instances still reading or writing the table.',
    guidance:
      'Step 1 (Expand/Deploy): Remove all code reads/writes to the table and deploy across all instances.\n' +
      '    Step 2 (Contract): After old instances are drained, drop the table in a separate follow-up migration with Boss approval (--approved-commit / OC_PG_MIGRATION_BOSS_APPROVED=1).',
  },
  'PG-BAN-DROP-COLUMN': {
    why: 'ALTER TABLE ... DROP COLUMN breaks old running instances whose queries still SELECT/INSERT/UPDATE the dropped column.',
    guidance:
      'Step 1 (Expand/Deploy): Stop reading/writing the column in application code (and make it nullable if needed) and deploy.\n' +
      '    Step 2 (Contract): Drop the unused column in a later release after old instances have exited (with Boss approval).',
  },
  'PG-BAN-RENAME': {
    why: 'RENAME TABLE / RENAME COLUMN takes ACCESS EXCLUSIVE lock and immediately breaks all running old instances referencing the original name.',
    guidance:
      'Step 1 (Expand): Add the new table/column alongside the old one, dual-write in code, and backfill in batches.\n' +
      '    Step 2 (Contract): Switch reads to the new name, deploy, and retire the old name in a subsequent release.',
  },
  'PG-BAN-TRUNCATE': {
    why: 'TRUNCATE acquires an ACCESS EXCLUSIVE lock and wipes live rows needed by active traffic or rolling instances.',
    guidance:
      'Step 1 (Expand): Delete obsolete rows in small batched DELETE statements (e.g. LIMIT 1000) or write into a replacement table.\n' +
      '    Step 2 (Contract): Swap traffic and clean up in a follow-up migration only after draining readers.',
  },
  'PG-ADDING-REQUIRED-FIELD': {
    why: 'ADD COLUMN ... NOT NULL without DEFAULT fails on existing rows and breaks old instances inserting rows without that column.',
    guidance:
      'Step 1 (Expand): Use `ALTER TABLE ... ADD COLUMN <col> <type> NOT NULL DEFAULT <const>` (metadata-only in PG 11+) or add a nullable column first.\n' +
      '    Step 2 (Contract): Backfill existing rows in batches, then add `CHECK (<col> IS NOT NULL) NOT VALID` and `VALIDATE CONSTRAINT`.',
  },
  'PG-CHANGING-COLUMN-TYPE': {
    why: 'ALTER TABLE ... ALTER COLUMN ... TYPE rewrites the table under ACCESS EXCLUSIVE lock and can break old instance codecs.',
    guidance:
      'Step 1 (Expand): Add a new column with the target type, dual-write from application code, and backfill existing rows in batches.\n' +
      '    Step 2 (Contract): Switch readers to the new column, deploy, and retire the old column in a later release.',
  },
  'PG-LOCKING-INDEX-OR-CONSTRAINT': {
    why: 'Non-concurrent CREATE INDEX blocks writes (SHARE lock) and ADD CONSTRAINT CHECK/FOREIGN KEY without NOT VALID scans the whole table under ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE lock.',
    guidance:
      'Step 1 (Expand): Use `CREATE [UNIQUE] INDEX CONCURRENTLY ...` in a `-- no-transaction` migration; for constraints use `ALTER TABLE ... ADD CONSTRAINT ... CHECK/FOREIGN KEY (...) NOT VALID`.\n' +
      '    Step 2 (Validate): Run `ALTER TABLE ... VALIDATE CONSTRAINT <name>` (takes non-blocking SHARE UPDATE EXCLUSIVE lock).',
  },
  'PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION': {
    why: 'PostgreSQL forbids CONCURRENTLY inside a transaction block or DO $$ block; `packages/commercial/src/db/migrate.ts` wraps every migration lacking `-- no-transaction` in BEGIN...COMMIT.',
    guidance:
      'Step 1: Add `-- no-transaction` as a comment line at the top of the migration file (matching `/^--\\s*no-transaction\\b/im`), and keep CONCURRENTLY as a top-level statement outside any DO $$ block.\n' +
      '    Step 2: Ensure each statement in the `-- no-transaction` migration is safe/idempotent on retry.',
  },
  'PG-SQUAWK-FINDING': {
    why: 'External squawk linter reported an unsafe PostgreSQL migration operation.',
    guidance:
      'Follow the Expand-Contract two-step migration pattern or resolve the reported squawk rule before merging.',
  },
}

function countNewlines(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') n++
  }
  return n
}

/**
 * Tokenize PostgreSQL SQL while accurately handling:
 * - `--` line comments
 * - nested `/* ... *\/` block comments
 * - `'...'` and `E'...'` string literals
 * - `"..."` quoted identifiers
 * - `$tag$...$tag$` dollar-quoted bodies
 */
export function tokenizePgSql(text: string): SqlToken[] {
  const tokens: SqlToken[] = []
  const n = text.length
  let i = 0
  let line = 1

  while (i < n) {
    const c = text[i]!
    const startLine = line

    // Line comment
    if (c === '-' && text[i + 1] === '-') {
      let j = text.indexOf('\n', i + 2)
      if (j < 0) j = n
      tokens.push({ kind: 'comment', value: text.slice(i, j), line: startLine })
      i = j
      continue
    }

    // Nested block comment
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else {
          j++
        }
      }
      if (depth !== 0) {
        throw new Error(`unterminated block comment at line ${startLine}`)
      }
      const seg = text.slice(i, j)
      line += countNewlines(seg)
      tokens.push({ kind: 'comment', value: seg, line: startLine })
      i = j
      continue
    }

    // String literal ('...' or E'...')
    const isEscString =
      (c === 'e' || c === 'E') &&
      text[i + 1] === "'" &&
      (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]!))
    if (c === "'" || isEscString) {
      let j = i + (isEscString ? 2 : 1)
      let closed = false
      while (j < n) {
        if (isEscString && text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) {
        throw new Error(`unterminated string literal at line ${startLine}`)
      }
      const seg = text.slice(i, j)
      line += countNewlines(seg)
      tokens.push({ kind: 'string', value: seg, line: startLine })
      i = j
      continue
    }

    // Double-quoted identifier
    if (c === '"') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2
            continue
          }
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) {
        throw new Error(`unterminated quoted identifier at line ${startLine}`)
      }
      const seg = text.slice(i, j)
      line += countNewlines(seg)
      tokens.push({ kind: 'ident', value: seg, line: startLine })
      i = j
      continue
    }

    // Dollar-quoted body ($tag$ ... $tag$)
    if (c === '$' && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]!))) {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))
      if (m) {
        const tag = m[0]
        const end = text.indexOf(tag, i + tag.length)
        if (end < 0) {
          throw new Error(`unterminated ${tag} dollar-quoted body at line ${startLine}`)
        }
        const seg = text.slice(i, end + tag.length)
        line += countNewlines(seg)
        tokens.push({ kind: 'string', value: seg, line: startLine })
        i = end + tag.length
        continue
      }
    }

    // Statement terminator
    if (c === ';') {
      tokens.push({ kind: 'semi', value: ';', line: startLine })
      i++
      continue
    }

    // Plain code chunk
    let j = i + 1
    while (j < n) {
      const d = text[j]!
      if (d === ';' || d === "'" || d === '"' || d === '$') break
      if ((d === '-' && text[j + 1] === '-') || (d === '/' && text[j + 1] === '*')) break
      if ((d === 'e' || d === 'E') && text[j + 1] === "'" && !/[A-Za-z0-9_]/.test(text[j - 1]!)) {
        break
      }
      j++
    }
    const seg = text.slice(i, j)
    line += countNewlines(seg)
    tokens.push({ kind: 'code', value: seg, line: startLine })
    i = j
  }

  return tokens
}

function splitSqlStatements(text: string): SqlStatement[] {
  const tokens = tokenizePgSql(text)
  const stmts: SqlStatement[] = []
  let parts: string[] = []
  let startLine: number | null = null
  let dollarBodies: Array<{ body: string; line: number }> = []

  const flush = () => {
    const normalized = parts.join('').replace(/\s+/g, ' ').trim()
    if (normalized) {
      stmts.push({
        line: startLine ?? 1,
        code: normalized,
        dollarBodies,
      })
    }
    parts = []
    startLine = null
    dollarBodies = []
  }

  for (const tok of tokens) {
    if (tok.kind === 'semi') {
      flush()
      continue
    }
    if (tok.kind === 'comment') {
      // Comments are stripped completely so `-- compat:` or inline comments never bypass rules
      parts.push(' ')
      continue
    }
    if (startLine === null && tok.value.trim()) {
      const leading = tok.value.slice(0, tok.value.length - tok.value.trimStart().length)
      startLine = tok.line + countNewlines(leading)
    }
    if (tok.kind === 'string') {
      if (tok.value.startsWith('$')) {
        const stripped = tok.value.replace(/^\$[A-Za-z0-9_]*\$|\$[A-Za-z0-9_]*\$$/g, '')
        dollarBodies.push({ body: stripped, line: tok.line })
        parts.push(' $BODY$ ')
      } else {
        parts.push(" '' ")
      }
    } else {
      parts.push(tok.value)
    }
  }
  flush()
  return stmts
}

/**
 * Find the first occurrence of keyword `kw` (case-insensitive, word boundary) at
 * parenthesis depth 0 starting from `fromIdx`, returning the index immediately AFTER the keyword.
 */
function findTopLevelKeywordEnd(code: string, kw: string, fromIdx = 0): number {
  const upper = code.toUpperCase()
  const target = kw.toUpperCase()
  let depth = 0
  for (let i = fromIdx; i < code.length; i++) {
    const ch = code[i]!
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')') {
      if (depth > 0) depth--
      continue
    }
    if (depth !== 0) continue
    if (upper.startsWith(target, i)) {
      const before = i === 0 ? '' : code[i - 1]!
      const after = i + target.length >= code.length ? '' : code[i + target.length]!
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
        return i + target.length
      }
    }
  }
  return -1
}

/**
 * Iteratively peel arbitrarily nested PL/pgSQL control-flow prefixes inside `DO $$ ... $$`
 * (`<<label>>`, `DECLARE ... BEGIN`, `BEGIN`, `IF ... THEN`, `ELSIF/ELSEIF ... THEN`,
 * `ELSE`, `WHILE/FOR/FOREACH ... LOOP`, `LOOP`, `EXCEPTION`, `WHEN ... THEN`, `END [IF|LOOP]`)
 * so nested DDL statements like `BEGIN IF NOT EXISTS (...) THEN ALTER TABLE ... END IF; END`
 * are fully exposed for inspection.
 */
export function stripPlpgsqlControlHeaders(rawCode: string): string {
  let code = rawCode.trim()
  for (let iter = 0; iter < 32; iter++) {
    const prev = code

    // Optional block label: <<outer>>
    code = code.replace(/^<<[A-Za-z_][A-Za-z0-9_$]*>>\s*/i, '')

    // Leading DECLARE ... BEGIN (when declaration had no semicolons before BEGIN)
    if (/^DECLARE\b/i.test(code)) {
      const end = findTopLevelKeywordEnd(code, 'BEGIN', 7)
      if (end > 0) {
        code = code.slice(end).trim()
        continue
      }
    }

    // Simple block/branch openers: BEGIN, ELSE, LOOP, EXCEPTION
    if (/^(?:BEGIN|ELSE|LOOP|EXCEPTION)\b/i.test(code)) {
      code = code.replace(/^(?:BEGIN|ELSE|LOOP|EXCEPTION)\b\s*/i, '')
      continue
    }

    // IF / ELSIF / ELSEIF / WHEN <cond> THEN
    if (/^(?:IF|ELSIF|ELSEIF|WHEN)\b/i.test(code)) {
      const kwLen = /^(?:ELSIF|ELSEIF)\b/i.exec(code)?.[0].length ?? (/^WHEN\b/i.test(code) ? 4 : 2)
      const end = findTopLevelKeywordEnd(code, 'THEN', kwLen)
      if (end > 0) {
        code = code.slice(end).trim()
        continue
      }
    }

    // WHILE / FOR / FOREACH <cond> LOOP
    if (/^(?:WHILE|FOREACH|FOR)\b/i.test(code)) {
      const kwLen = /^(?:WHILE|FOREACH|FOR)\b/i.exec(code)![0].length
      const end = findTopLevelKeywordEnd(code, 'LOOP', kwLen)
      if (end > 0) {
        code = code.slice(end).trim()
        continue
      }
    }

    if (code === prev) break
  }
  return code
}

/** Normalize `[schema.]table` or `"public"."users"` into a comparable lowercase name. */
function normalizeTableIdent(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, '')
  const parts = cleaned.split('.').map((p) => {
    const s = p.trim()
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      return s.slice(1, -1).replace(/""/g, '"').toLowerCase()
    }
    return s.toLowerCase()
  })
  // Strip explicit `public.` or `pg_temp.` schema prefix for uniform matching
  if (parts.length === 2 && (parts[0] === 'public' || parts[0] === 'pg_temp')) {
    return parts[1]!
  }
  return parts.join('.')
}

const IDENT_PART = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)'
const QUALIFIED_IDENT = `${IDENT_PART}(?:\\s*\\.\\s*${IDENT_PART})?`

/** Split comma-separated clauses at parenthesis depth 0. */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '(') depth++
    else if (c === ')' && depth > 0) depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = s.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

function makeViolation(
  rule: PgSafetyRuleId,
  file: string,
  line: number,
  snippet: string,
): PgSafetyViolation {
  const meta = RULE_GUIDANCE[rule]
  return {
    rule,
    file,
    line,
    snippet: snippet.length > 180 ? `${snippet.slice(0, 177)}...` : snippet,
    why: meta.why,
    guidance: meta.guidance,
  }
}

function inspectAlterTable(
  stmt: SqlStatement,
  file: string,
  tempTables: ReadonlySet<string>,
  out: PgSafetyViolation[],
): void {
  const headerRe = new RegExp(
    `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(${QUALIFIED_IDENT})\\s+([\\s\\S]+)$`,
    'i',
  )
  const hm = headerRe.exec(stmt.code)
  if (!hm) return

  const tableName = normalizeTableIdent(hm[1]!)
  if (tempTables.has(tableName)) return

  const actionsRaw = hm[2]!
  const actions = splitTopLevelCommas(actionsRaw)

  for (const action of actions) {
    // Rule 3: RENAME TABLE / RENAME COLUMN
    if (
      /^RENAME\s+TO\b/i.test(action) ||
      /^RENAME\s+(?:COLUMN\s+)?(?:(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+)TO\b/i.test(action)
    ) {
      out.push(makeViolation('PG-BAN-RENAME', file, stmt.line, stmt.code))
      continue
    }

    // Rule 2: DROP COLUMN (supports both `DROP COLUMN foo` and `DROP foo` while ignoring DROP CONSTRAINT/DEFAULT/NOT NULL/etc.)
    if (
      /^DROP\s+COLUMN\b/i.test(action) ||
      /^DROP\s+(?:IF\s+EXISTS\s+)?(?!(?:CONSTRAINT|DEFAULT|NOT\s+NULL|IDENTITY|EXPRESSION|RULE|TRIGGER)\b)(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/i.test(
        action,
      )
    ) {
      out.push(makeViolation('PG-BAN-DROP-COLUMN', file, stmt.line, stmt.code))
      continue
    }

    // Rule 6: ALTER COLUMN ... [SET DATA] TYPE
    if (
      /^ALTER\s+(?:COLUMN\s+)?(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(
        action,
      )
    ) {
      out.push(makeViolation('PG-CHANGING-COLUMN-TYPE', file, stmt.line, stmt.code))
      continue
    }

    // Rule 5: ADD [COLUMN] ... NOT NULL without DEFAULT
    if (
      /^ADD\s+COLUMN\b/i.test(action) ||
      (/^ADD\s+(?!CONSTRAINT\b|CHECK\b|FOREIGN\b|PRIMARY\b|UNIQUE\b|EXCLUDE\b)/i.test(action) &&
        /\bNOT\s+NULL\b/i.test(action))
    ) {
      if (/\bNOT\s+NULL\b/i.test(action) && !/\bDEFAULT\b/i.test(action)) {
        out.push(makeViolation('PG-ADDING-REQUIRED-FIELD', file, stmt.line, stmt.code))
      }
      continue
    }

    // Rule 7b: ADD [CONSTRAINT <name>] CHECK (...) / FOREIGN KEY (...) without NOT VALID
    if (
      /^ADD\s+(?:CONSTRAINT\s+(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+)?(?:CHECK\b|FOREIGN\s+KEY\b)/i.test(
        action,
      )
    ) {
      if (!/\bNOT\s+VALID\b/i.test(action)) {
        out.push(makeViolation('PG-LOCKING-INDEX-OR-CONSTRAINT', file, stmt.line, stmt.code))
      }
    }
  }
}

interface InspectContext {
  file: string
  createdTables: Set<string>
  tempTables: Set<string>
  hasNoTransactionMarker: boolean
  insideDoBlock: boolean
  out: PgSafetyViolation[]
}

function inspectStatements(
  stmts: readonly SqlStatement[],
  ctx: InspectContext,
  lineOffset = 0,
): void {
  const createTableRe = new RegExp(
    `^CREATE\\s+(?:(GLOBAL|LOCAL)\\s+)?(?:(TEMP|TEMPORARY|UNLOGGED)\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_IDENT})\\b`,
    'i',
  )
  const dropTableRe = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i
  const truncateRe = /^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?([\s\S]+)$/i
  const createIndexRe = new RegExp(
    `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT_PART}\\s+)?ON\\s+(?:ONLY\\s+)?(${QUALIFIED_IDENT})\\b`,
    'i',
  )
  const dropIndexConcurrentlyRe = /^DROP\s+INDEX\s+CONCURRENTLY\b/i
  const reindexConcurrentlyRe = /^REINDEX\s+(?:(?:\([^)]*\)\s+)?)(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\s+CONCURRENTLY\b/i

  for (const rawStmt of stmts) {
    const stmt: SqlStatement = {
      ...rawStmt,
      line: rawStmt.line + lineOffset,
    }
    const code = stmt.code

    // Track newly created tables and temp tables in this migration
    const cm = createTableRe.exec(code)
    if (cm) {
      const qual = (cm[2] ?? '').trim().toUpperCase()
      const tbl = normalizeTableIdent(cm[3]!)
      ctx.createdTables.add(tbl)
      if (qual === 'TEMP' || qual === 'TEMPORARY') {
        ctx.tempTables.add(tbl)
      }
      continue
    }

    // Rule 1: DROP TABLE (ignore temp tables created in the same migration)
    const dm = dropTableRe.exec(code)
    if (dm) {
      const targetPart = dm[1]!.replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '')
      const targets = splitTopLevelCommas(targetPart).map(normalizeTableIdent)
      if (targets.some((t) => !ctx.tempTables.has(t))) {
        ctx.out.push(makeViolation('PG-BAN-DROP-TABLE', ctx.file, stmt.line, code))
      }
      continue
    }

    // Rule 4: TRUNCATE (ignore temp tables created in the same migration)
    const tm = truncateRe.exec(code)
    if (tm) {
      const targetPart = tm[1]!.replace(
        /\s+(?:RESTART\s+IDENTITY|CONTINUE\s+IDENTITY|CASCADE|RESTRICT).*$/i,
        '',
      )
      const targets = splitTopLevelCommas(targetPart).map((t) =>
        normalizeTableIdent(t.replace(/^ONLY\s+/i, '')),
      )
      if (targets.some((t) => !ctx.tempTables.has(t))) {
        ctx.out.push(makeViolation('PG-BAN-TRUNCATE', ctx.file, stmt.line, code))
      }
      continue
    }

    // Rule 7a & Rule 8: CREATE [UNIQUE] INDEX ...
    const im = createIndexRe.exec(code)
    if (im) {
      const isConcurrent = Boolean(im[1])
      const targetTable = normalizeTableIdent(im[2]!)
      if (isConcurrent) {
        if (!ctx.hasNoTransactionMarker || ctx.insideDoBlock) {
          ctx.out.push(
            makeViolation('PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION', ctx.file, stmt.line, code),
          )
        }
      } else if (!ctx.createdTables.has(targetTable) && !ctx.tempTables.has(targetTable)) {
        ctx.out.push(makeViolation('PG-LOCKING-INDEX-OR-CONSTRAINT', ctx.file, stmt.line, code))
      }
      continue
    }

    // Rule 8b: DROP INDEX CONCURRENTLY / REINDEX ... CONCURRENTLY requires `-- no-transaction`
    if (dropIndexConcurrentlyRe.test(code) || reindexConcurrentlyRe.test(code)) {
      if (!ctx.hasNoTransactionMarker || ctx.insideDoBlock) {
        ctx.out.push(
          makeViolation('PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION', ctx.file, stmt.line, code),
        )
      }
      continue
    }

    // Rules 2, 3, 5, 6, 7b: ALTER TABLE ...
    if (/^ALTER\s+TABLE\b/i.test(code)) {
      inspectAlterTable(stmt, ctx.file, ctx.tempTables, ctx.out)
    }

    // Recursively inspect DO $$ ... $$ procedural bodies (including nested IF/ELSIF/ELSE/LOOP/BEGIN/DO)
    if (/^DO\b/i.test(code) && stmt.dollarBodies.length > 0) {
      const innerCtx: InspectContext = { ...ctx, insideDoBlock: true }
      for (const db of stmt.dollarBodies) {
        const innerStmts = splitSqlStatements(db.body).map((s) => ({
          ...s,
          code: stripPlpgsqlControlHeaders(s.code),
        }))
        inspectStatements(innerStmts, innerCtx, db.line - 1)
      }
    }
  }
}

/**
 * Inspect SQL text of a single migration file for zero-downtime safety violations.
 * Pure, zero external dependencies, deterministic.
 */
export function checkPgMigrationSql(sql: string, file = '<inline.sql>'): PgSafetyViolation[] {
  const stmts = splitSqlStatements(sql)
  const out: PgSafetyViolation[] = []
  inspectStatements(stmts, {
    file,
    createdTables: new Set<string>(),
    tempTables: new Set<string>(),
    hasNoTransactionMarker: NO_TRANSACTION_MARKER_RE.test(sql),
    insideDoBlock: false,
    out,
  })
  return out
}

/** Optional external `squawk` overlay when `squawk` is installed on PATH. */
function runOptionalSquawk(absFile: string, relFile: string): PgSafetyViolation[] {
  const probe = spawnSync('squawk', ['--version'], { encoding: 'utf8', stdio: 'ignore' })
  if (probe.error || probe.status !== 0) return []

  const res = spawnSync('squawk', [absFile], { encoding: 'utf8' })
  if (res.status === 0) return []
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim()
  if (!output) return []
  const firstLine = output.split('\n').find((l) => l.trim().length > 0) ?? 'squawk reported an issue'
  return [makeViolation('PG-SQUAWK-FINDING', relFile, 1, firstLine)]
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

interface ChangedMigrationFilesInfo {
  files: string[]
  headSha: string
  prHeadSha?: string
  lastMigrationCommit?: string
  hasDirtyMigrationEdit: boolean
}

export function collectChangedMigrationFilesInfo(
  root: string,
  base: string,
): ChangedMigrationFilesInfo {
  // Verify base ref exists (fail-closed)
  runGit(root, ['rev-parse', '--verify', `${base}^{commit}`])
  const headSha = runGit(root, ['rev-parse', '--verify', 'HEAD']).trim()
  // On GitHub Actions `pull_request` synthetic merge commits, `HEAD^2` is the approved PR head SHA
  const head2Probe = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD^2'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const prHeadCandidate = head2Probe.status === 0 ? head2Probe.stdout.trim() : ''
  const prHeadSha = SHA40_RE.test(prHeadCandidate) ? prHeadCandidate : undefined

  const committed = splitLines(
    runGit(root, ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`, '--', DEFAULT_MIGRATIONS_GLOB]),
  )
  const unstaged = splitLines(
    runGit(root, ['diff', '--name-only', '--diff-filter=AMR', '--', DEFAULT_MIGRATIONS_GLOB]),
  )
  const staged = splitLines(
    runGit(root, ['diff', '--cached', '--name-only', '--diff-filter=AMR', '--', DEFAULT_MIGRATIONS_GLOB]),
  )
  const untracked = splitLines(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '--', DEFAULT_MIGRATIONS_GLOB]),
  )

  const hasDirtyMigrationEdit = unstaged.length > 0 || staged.length > 0 || untracked.length > 0

  let lastMigrationCommit: string | undefined
  if (committed.length > 0) {
    const mergeBase = runGit(root, ['merge-base', base, 'HEAD']).trim()
    const last = runGit(root, [
      'log',
      '-n',
      '1',
      '--format=%H',
      `${mergeBase}..HEAD`,
      '--',
      DEFAULT_MIGRATIONS_GLOB,
    ]).trim()
    if (SHA40_RE.test(last)) {
      lastMigrationCommit = last
    }
  }

  const set = new Set<string>([...committed, ...unstaged, ...staged, ...untracked])
  const files = [...set].filter((f) => existsSync(path.join(root, f))).sort()
  return {
    files,
    headSha,
    prHeadSha,
    lastMigrationCommit,
    hasDirtyMigrationEdit,
  }
}

export function collectChangedMigrationFiles(root: string, base: string): string[] {
  return collectChangedMigrationFilesInfo(root, base).files
}

export function formatPgViolation(v: PgSafetyViolation): string {
  return [
    `[GATE-ERROR] ${v.rule} ${v.file}:${v.line}`,
    `  Statement: ${v.snippet}`,
    `  Why blocked: ${v.why}`,
    '  Note: `-- compat:` comments CANNOT bypass PG zero-downtime safety rules.',
    '  Expand-Contract safe alternative:',
    `    ${v.guidance}`,
    `  Emergency escape hatch (Boss approval required): --approved-commit <40hex> (CI) or ${BOSS_APPROVAL_ENV}=1 (local)`,
  ].join('\n')
}

/** Rules that represent physically unexecutable SQL (e.g. CONCURRENTLY inside a transaction) and CANNOT be waived even with Boss approval. */
export const NON_WAIVABLE_RULES: ReadonlySet<PgSafetyRuleId> = new Set([
  'PG-CONCURRENTLY-REQUIRES-NO-TRANSACTION',
])

export function runPgMigrationSafetyCheck(opts: {
  root: string
  base?: string
  files?: string[]
  approvedCommit?: string
  approvedFiles?: string[]
  useSquawk?: boolean
  env?: Readonly<Record<string, string | undefined>>
}): PgMigrationSafetyResult {
  const env = opts.env ?? process.env
  const envApproved = env[BOSS_APPROVAL_ENV] === '1'

  if (opts.approvedCommit !== undefined && opts.approvedCommit !== '') {
    if (!SHA40_RE.test(opts.approvedCommit)) {
      throw new Error(
        `invalid --approved-commit ${JSON.stringify(opts.approvedCommit)}: expected 40-char hex git commit SHA`,
      )
    }
  }

  let targets: Array<{ rel: string; abs: string }>
  let headSha: string | undefined
  let prHeadSha: string | undefined
  let lastMigrationCommit: string | undefined
  let hasDirtyMigrationEdit = false

  if (opts.files && opts.files.length > 0) {
    targets = opts.files.map((f) => {
      const abs = path.isAbsolute(f) ? f : path.resolve(opts.root, f)
      const rel = path.relative(opts.root, abs) || f
      return { rel, abs }
    })
  } else if (opts.base) {
    const info = collectChangedMigrationFilesInfo(opts.root, opts.base)
    headSha = info.headSha
    prHeadSha = info.prHeadSha
    lastMigrationCommit = info.lastMigrationCommit
    hasDirtyMigrationEdit = info.hasDirtyMigrationEdit
    targets = info.files.map((rel) => ({ rel, abs: path.join(opts.root, rel) }))
  } else {
    throw new Error('either --base <ref> or --file <path> is required')
  }

  const violations: PgSafetyViolation[] = []
  for (const t of targets) {
    if (!existsSync(t.abs)) {
      throw new Error(`migration file not found: ${t.abs}`)
    }
    const sql = readFileSync(t.abs, 'utf8')
    violations.push(...checkPgMigrationSql(sql, t.rel))
    if (opts.useSquawk !== false) {
      violations.push(...runOptionalSquawk(t.abs, t.rel))
    }
  }

  // Trusted CI commit approval requires `--base`, clean migration working tree, and exact SHA match
  // against HEAD, GitHub PR synthetic merge parent HEAD^2, or the last migration-touching commit in
  // `<base>..HEAD` (batch-push safe).
  const normalizedApproved = opts.approvedCommit?.trim().toLowerCase()
  const commitApproved =
    Boolean(normalizedApproved) &&
    Boolean(opts.base) &&
    !hasDirtyMigrationEdit &&
    Boolean(headSha) &&
    (normalizedApproved === headSha!.toLowerCase() ||
      (Boolean(prHeadSha) && normalizedApproved === prHeadSha!.toLowerCase()) ||
      (Boolean(lastMigrationCommit) && normalizedApproved === lastMigrationCommit!.toLowerCase()))

  const approvedFileSet = new Set(
    Boolean(opts.base) && !hasDirtyMigrationEdit && opts.approvedFiles
      ? opts.approvedFiles.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
      : [],
  )

  const unwaivedViolations = violations.filter((v) => {
    if (NON_WAIVABLE_RULES.has(v.rule)) return true
    if (envApproved || commitApproved) return false
    const normFile = v.file.replace(/\\/g, '/').replace(/^\.\//, '')
    return !approvedFileSet.has(normFile)
  })

  const bossApproved =
    violations.length > 0 &&
    unwaivedViolations.length === 0 &&
    (envApproved || commitApproved || approvedFileSet.size > 0)
  const approvedVia = envApproved
    ? 'env'
    : commitApproved
      ? 'approved-commit'
      : approvedFileSet.size > 0
        ? 'approved-file'
        : undefined

  return {
    filesChecked: targets.map((t) => t.rel),
    violations,
    unwaivedViolations,
    bossApproved,
    approvedVia,
    headSha,
    lastMigrationCommit,
    approvedCommit: opts.approvedCommit || undefined,
    approvedFiles: [...approvedFileSet],
    hasDirtyMigrationEdit,
  }
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let base: string | undefined
  let approvedCommit: string | undefined
  const approvedFiles: string[] = []
  const files: string[] = []
  let useSquawk = true

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') {
      const v = argv[++i]
      if (!v) {
        console.error('[pg-migration-safety] --root requires a path')
        return 2
      }
      root = path.resolve(v)
    } else if (arg === '--base') {
      const v = argv[++i]
      if (!v) {
        console.error('[pg-migration-safety] --base requires a git ref')
        return 2
      }
      base = v
    } else if (arg === '--approved-commit') {
      const v = argv[++i]
      if (v === undefined) {
        console.error('[pg-migration-safety] --approved-commit requires a 40-char commit SHA')
        return 2
      }
      approvedCommit = v.trim()
    } else if (arg === '--approved-file') {
      const v = argv[++i]
      if (!v) {
        console.error('[pg-migration-safety] --approved-file requires a migration file path')
        return 2
      }
      approvedFiles.push(v.trim())
    } else if (arg === '--file') {
      const v = argv[++i]
      if (!v) {
        console.error('[pg-migration-safety] --file requires a path')
        return 2
      }
      files.push(v)
    } else if (arg === '--no-squawk') {
      useSquawk = false
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: npx tsx scripts/check-pg-migration-safety.ts (--base <ref> [--approved-commit <40hex>] [--approved-file <path>...] | --file <path>...) [--root <repo>] [--no-squawk]',
      )
      return 0
    } else {
      console.error(`[pg-migration-safety] unknown arg: ${arg}`)
      return 2
    }
  }

  if (!base && files.length === 0) {
    console.error('[pg-migration-safety] either --base <ref> or --file <path> is required')
    return 2
  }

  try {
    const res = runPgMigrationSafetyCheck({
      root,
      base,
      files,
      approvedCommit,
      approvedFiles,
      useSquawk,
    })
    if (res.violations.length === 0) {
      console.log(
        `[pg-migration-safety] ok: ${res.filesChecked.length} migration file(s) checked, 0 violations`,
      )
      return 0
    }
    const blocking = res.unwaivedViolations
    if (blocking.length === 0 && res.bossApproved) {
      const via =
        res.approvedVia === 'approved-commit'
          ? `--approved-commit=${res.approvedCommit}`
          : res.approvedVia === 'approved-file'
            ? `--approved-file (${res.approvedFiles?.join(', ')})`
            : `${BOSS_APPROVAL_ENV}=1`
      console.warn(
        `[pg-migration-safety] WARNING: ${res.violations.length} violation(s) bypassed via ${via}:`,
      )
      for (const v of res.violations) {
        console.warn(`  - ${v.rule} ${v.file}:${v.line}: ${v.snippet}`)
      }
      return 0
    }
    for (const v of blocking) {
      console.error(formatPgViolation(v))
    }
    if (res.approvedCommit) {
      console.error(
        `[pg-migration-safety] --approved-commit=${res.approvedCommit} did not clear ${blocking.length} blocking violation(s) (head=${res.headSha ?? 'n/a'}, lastMigrationCommit=${res.lastMigrationCommit ?? 'n/a'}, dirty=${Boolean(res.hasDirtyMigrationEdit)})`,
      )
    }
    console.error(
      `[pg-migration-safety] FAILED: ${res.violations.length} unsafe DDL violation(s) in ${res.filesChecked.length} file(s)`,
    )
    return 1
  } catch (err) {
    console.error(
      `[pg-migration-safety] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`,
    )
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
