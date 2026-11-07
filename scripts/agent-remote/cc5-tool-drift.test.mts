/** OCV5-746 unit tests for scripts/agent-remote/cc5-tool-drift.mts (diff logic + exit codes).
 *
 * Run: npx tsx --test scripts/agent-remote/cc5-tool-drift.test.mts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type ToolDefinition,
  type ToolSet,
  diffDescription,
  diffSchema,
  diffToolSets,
  parseToolDocument,
  renderMarkdown,
  runCli,
} from './cc5-tool-drift.mts'

const schema = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const tool = (
  name: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  description = `${name} tool`,
): ToolDefinition => ({
  name,
  description,
  inputSchema: schema(properties, required),
  deferred: false,
})

const set = (label: string, tools: ToolDefinition[]): ToolSet => ({ label, meta: {}, tools })

const kinds = (changes: { path: string; kind: string }[]) =>
  changes.map((change) => `${change.path}:${change.kind}`)

// ---------------------------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------------------------

test('parseToolDocument reads an API request body', () => {
  const parsed = parseToolDocument(
    JSON.stringify({
      tools: [
        { name: 'Read', description: 'reads', input_schema: { type: 'object', properties: {} } },
        {
          name: 'CronList',
          description: 'cron',
          input_schema: { type: 'object', properties: {} },
          defer_loading: true,
        },
      ],
    }),
  )
  assert.deepEqual(
    parsed.map((entry) => [entry.name, entry.deferred]),
    [
      ['Read', false],
      ['CronList', true],
    ],
  )
})

test('parseToolDocument reads an MCP tools/list result and a bare array', () => {
  const mcp = parseToolDocument(
    JSON.stringify({
      jsonrpc: '2.0',
      result: { tools: [{ name: 'Bash', description: 'b', inputSchema: { type: 'object' } }] },
    }),
  )
  assert.deepEqual(
    mcp.map((entry) => entry.name),
    ['Bash'],
  )
  const bare = parseToolDocument(
    JSON.stringify([{ name: 'Write', description: 'w', inputSchema: { type: 'object' } }]),
  )
  assert.deepEqual(
    bare.map((entry) => entry.name),
    ['Write'],
  )
})

test('parseToolDocument merges an NDJSON transcript and keeps deferred names', () => {
  const lines = [
    JSON.stringify({
      type: 'api-request-shape',
      shape: { tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }] },
    }),
    JSON.stringify({
      type: 'capture',
      deferred_names: ['CronList'],
      tools: [{ name: 'Skill', description: 's', input_schema: { type: 'object' } }],
    }),
    'not json',
  ]
  const parsed = parseToolDocument(lines.join('\n'))
  assert.deepEqual(parsed.map((entry) => entry.name).sort(), ['CronList', 'Read', 'Skill'])
  const cron = parsed.find((entry) => entry.name === 'CronList')!
  assert.equal(cron.deferred, true)
  assert.equal(cron.inputSchema, null)
})

test('parseToolDocument rejects documents without tools', () => {
  assert.throws(() => parseToolDocument('{"nope":true}'), /CC5_DRIFT_INPUT_NO_TOOLS/)
  assert.throws(() => parseToolDocument('garbage'), /CC5_DRIFT_INPUT_NOT_JSON/)
})

// ---------------------------------------------------------------------------------------------
// Schema diff
// ---------------------------------------------------------------------------------------------

test('diffSchema reports property additions, removals and nested changes', () => {
  const official = schema(
    {
      file_path: { type: 'string' },
      offset: { type: 'integer' },
      nested: {
        type: 'object',
        properties: { keep: { type: 'string' }, added: { type: 'boolean' } },
      },
    },
    ['file_path'],
  )
  const ccb = schema(
    {
      file_path: { type: 'string' },
      removed_here: { type: 'string' },
      nested: { type: 'object', properties: { keep: { type: 'number' } } },
    },
    ['file_path'],
  )
  assert.deepEqual(kinds(diffSchema(official, ccb)).sort(), [
    '$.properties.nested.properties.added:property-removed',
    '$.properties.nested.properties.keep.type:type-changed',
    '$.properties.offset:property-removed',
    '$.properties.removed_here:property-added',
  ])
})

test('diffSchema reports required, enum, type and additionalProperties changes', () => {
  const official: Record<string, unknown> = {
    type: 'object',
    required: ['a'],
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['auto', 'fast'] },
      count: { type: 'number' },
      items: { type: 'array', items: { type: 'string' } },
    },
  }
  const ccb: Record<string, unknown> = {
    type: 'object',
    required: ['a', 'b'],
    additionalProperties: true,
    properties: {
      mode: { type: 'string', enum: ['auto', 'deep'] },
      count: { type: ['number', 'null'] },
      items: { type: 'array', items: { type: 'number' } },
    },
  }
  assert.deepEqual(kinds(diffSchema(official, ccb)).sort(), [
    '$.additionalProperties:additional-properties-changed',
    '$.properties.count.type:type-changed',
    '$.properties.items.items.type:type-changed',
    '$.properties.mode.enum:enum-added',
    '$.properties.mode.enum:enum-removed',
    '$.required:required-added',
  ])
})

test('diffSchema ignores the $schema draft URL and reports nested description edits', () => {
  const official = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...schema({ a: { type: 'string', description: 'new' } }),
  }
  const ccb = { ...schema({ a: { type: 'string', description: 'old' } }) }
  const changes = diffSchema(official, ccb)
  assert.deepEqual(kinds(changes), ['$.properties.a.description:value-changed'])
  assert.deepEqual(diffSchema(null, ccb), [])
})

// ---------------------------------------------------------------------------------------------
// Description diff
// ---------------------------------------------------------------------------------------------

test('diffDescription reports sha and the first differing line', () => {
  assert.equal(diffDescription('same', 'same'), null)
  const diff = diffDescription('line one\nline two\n', 'line one\nline THREE\n')!
  assert.equal(diff.line, 2)
  assert.equal(diff.officialLine, 'line two')
  assert.equal(diff.ccbLine, 'line THREE')
  assert.match(diff.officialSha, /^[0-9a-f]{12}$/)
  assert.notEqual(diff.officialSha, diff.ccbSha)
})

test('diffDescription notices a pure trailing-length change', () => {
  const diff = diffDescription('prefix\nsuffix', 'prefix\nsuffix\nextra')!
  assert.equal(diff.line, 3)
})

// ---------------------------------------------------------------------------------------------
// Set comparison and policy
// ---------------------------------------------------------------------------------------------

test('diffToolSets separates policy exclusions from real drift', () => {
  const official = set('official', [
    tool('Bash', { command: { type: 'string' } }, ['command']),
    tool('Read', { file_path: { type: 'string' } }, ['file_path']),
    tool('Agent'),
    tool('CronList'),
    tool('SendMessage'),
    tool('Monitor'), // new official tool the host does not serve: real drift
    tool('ToolSearch'),
  ])
  const ccb = set('ccb', [
    tool('Bash', { command: { type: 'string' } }, ['command']),
    tool('Read', { file_path: { type: 'string' }, offset: { type: 'integer' } }, ['file_path']),
    tool('SearchExtraTools'),
    tool('ExecuteExtraTool'),
    tool('TodoWrite'),
  ])
  const report = diffToolSets(official, ccb)
  assert.deepEqual(report.missing, ['Monitor'])
  assert.deepEqual(report.extra, ['TodoWrite'])
  assert.deepEqual(report.expected.excluded, ['Agent', 'CronList', 'SendMessage'])
  assert.deepEqual(report.expected.platform, ['ExecuteExtraTool', 'SearchExtraTools'])
  assert.deepEqual(report.expected.mechanism, ['ToolSearch'])
  assert.deepEqual(report.schemaDrift, ['Read'])
  assert.equal(report.hasUnexpectedDrift, true)
  assert.equal(report.counts.missing, 1)
  assert.equal(report.counts.extra, 1)
})

test('diffToolSets is clean when only expected differences remain', () => {
  const official = set('official', [tool('Bash'), tool('Agent'), tool('AskUserQuestion')])
  const ccb = set('ccb', [tool('Bash'), tool('SearchExtraTools'), tool('AskUserQuestion')])
  const report = diffToolSets(official, ccb)
  assert.equal(report.hasUnexpectedDrift, false)
  assert.deepEqual(report.missing, [])
  assert.deepEqual(report.extra, [])
  assert.deepEqual(report.expected.excluded, ['Agent'])
})

test('diffToolSets counts description drift and honours --allow', () => {
  const official = set('official', [tool('Read', {}, [], 'Reads a file.'), tool('Monitor')])
  const ccb = set('ccb', [tool('Read', {}, [], 'Reads files.'), tool('TodoWrite')])
  const strict = diffToolSets(official, ccb)
  assert.deepEqual(strict.descriptionDrift, ['Read'])
  assert.equal(strict.hasUnexpectedDrift, true)
  const allowed = diffToolSets(official, ccb, { allow: ['Monitor', 'TodoWrite'] })
  assert.deepEqual(allowed.expected.allowed, ['Monitor', 'TodoWrite'])
  assert.equal(allowed.missing.length, 0)
  assert.equal(allowed.extra.length, 0)
  assert.equal(allowed.hasUnexpectedDrift, true, 'description drift is never allowlisted')
})

test('renderMarkdown states the verdict and lists each section', () => {
  const official = set('official', [tool('Bash'), tool('Monitor'), tool('Agent')])
  const ccb = set('ccb', [tool('Bash', {}, [], 'Other text'), tool('SearchExtraTools')])
  const markdown = renderMarkdown(diffToolSets(official, ccb), '2026-11-07T00:00:00.000Z')
  assert.match(markdown, /Result: DRIFT/)
  assert.match(markdown, /### 1\.1 Official tools missing from CCB[\s\S]*`Monitor`/)
  assert.match(markdown, /### 1\.4 Description differences[\s\S]*`Bash`/)
  assert.match(markdown, /### 2\.1 Platform-only CCB tools[\s\S]*`SearchExtraTools`/)
  assert.match(markdown, /`Agent`/)
})

// ---------------------------------------------------------------------------------------------
// CLI exit codes
// ---------------------------------------------------------------------------------------------

test('runCli returns 0 without drift, 1 with drift, 2 on usage errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc5-drift-test-'))
  try {
    const official = join(dir, 'official.json')
    const clean = join(dir, 'clean.json')
    const drifted = join(dir, 'drifted.json')
    const out = join(dir, 'report.md')
    writeFileSync(
      official,
      JSON.stringify({
        tools: [
          { name: 'Bash', description: 'b', input_schema: schema({ command: { type: 'string' } }) },
        ],
      }),
    )
    writeFileSync(
      clean,
      JSON.stringify({
        tools: [
          { name: 'Bash', description: 'b', input_schema: schema({ command: { type: 'string' } }) },
        ],
      }),
    )
    writeFileSync(
      drifted,
      JSON.stringify({
        tools: [
          { name: 'Bash', description: 'b', input_schema: schema({ command: { type: 'number' } }) },
        ],
      }),
    )
    assert.equal(await runCli(['--official', official, '--ccb', clean, '--out', out]), 0)
    assert.equal(await runCli(['--official', official, '--ccb', drifted, '--out', out]), 1)
    assert.equal(await runCli(['--official', official]), 2)
    assert.equal(await runCli(['--official', official, '--ccb', clean, '--ccb-live']), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
