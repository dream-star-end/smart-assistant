import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { paths, type OpenClaudeConfig } from '@openclaude/storage'
import { GrokAdapter } from '../engine/grokAdapter.js'
import { CursorAdapter, cursorResumeStorePath } from '../engine/cursorAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'

function opts(dir: string, engine: string): EngineCreateOpts {
  return { agentId: 'main', agentBaseDir: dir, sessionKey: `agent:main:webchat:dm:readonly-${engine}`, model: engine === 'grok' ? 'grok-build' : 'cursor-auto', config: { version: 1, gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' }, auth: { mode: 'api_key', claudeCodePath: dir }, defaults: { model: engine === 'grok' ? 'grok-build' : 'cursor-auto' } } as OpenClaudeConfig } as EngineCreateOpts
}

for (const engine of ['grok', 'cursor'] as const) {
  test(`${engine} no-write turn keeps reads, removes writes, and restores tools on the next turn`, { timeout: 90_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), `advisor-readonly-${engine}-`))
    const target = join(dir, 'outline.md')
    const capture = join(dir, 'calls.jsonl')
    const bin = join(dir, 'fake-cli.cjs')
    const cursorSessionId = randomUUID()
    await writeFile(target, 'original')
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const engine = ${JSON.stringify(engine)};
const restricted = engine === 'grok' ? argv[argv.indexOf('--tools') + 1] === 'read_file,grep,list_dir' : argv[argv.indexOf('--mode') + 1] === 'ask' && !argv.includes('--force');
let policy;
if (engine === 'grok') policy = fs.readFileSync(require('node:path').join(process.env.GROK_HOME, 'config.toml'), 'utf8');
else policy = JSON.parse(fs.readFileSync(process.env.OPENCLAUDE_CURSOR_MCP_CONFIG, 'utf8')).mcpServers['openclaude-memory'].env.OPENCLAUDE_ADVISOR_READ_ONLY;
if (!restricted) fs.writeFileSync(${JSON.stringify(target)}, 'changed');
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv, policy, cwd: process.cwd(), home: process.env.HOME, resumeId: process.env.OPENCLAUDE_CURSOR_RESUME_ID, writeCalls: restricted ? 0 : 1, writeCharges: restricted ? 0 : 1 }) + '\\n');
if (engine === 'grok') {
  console.log(JSON.stringify({ type: 'tool_call', toolCallId: 'read-1', toolName: 'read_file', rawInput: { path: ${JSON.stringify(target)} } }));
  console.log(JSON.stringify({ type: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: { text: fs.readFileSync(${JSON.stringify(target)}, 'utf8') } }));
  console.log(JSON.stringify({ type: 'text', data: 'read verified' }));
  console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'readonly-test', usage: { input_tokens: 1, output_tokens: 1 } }));
} else {
  console.log(JSON.stringify({type:'tool_call',subtype:'started',call_id:'read-1',tool_call:{readToolCall:{args:{path:${JSON.stringify(target)}}}}}));
  console.log(JSON.stringify({type:'tool_call',subtype:'completed',call_id:'read-1',tool_call:{readToolCall:{args:{path:${JSON.stringify(target)}},result:{success:{content:'read'}}}}}));
  console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'read verified'}]}}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'read verified'}));
}
`)
    await chmod(bin, 0o755)
    const binEnv = engine === 'grok' ? 'OC_GROK_CLI_BIN' : 'OC_CURSOR_WRAPPER_BIN'
    const keys = [binEnv, 'OPENCLAUDE_HOME', 'OC_MODEL_AUTHORITY', 'OPENCLAUDE_ADVISOR_READ_ONLY']
    const old = keys.map((key) => process.env[key])
    process.env[binEnv] = bin
    process.env.OPENCLAUDE_HOME = join(dir, 'home')
    process.env.OPENCLAUDE_ADVISOR_READ_ONLY = '1'
    delete process.env.OC_MODEL_AUTHORITY
    const oldStorageHome = paths.home
    paths.home = join(dir, 'storage-home')
    if (engine === 'cursor') {
      const store = cursorResumeStorePath(dir, cursorSessionId)
      await mkdir(dirname(store), { recursive: true })
      const db = new Database(store)
      db.exec("CREATE TABLE history (text TEXT); INSERT INTO history VALUES ('prior conversation')")
      db.close()
    }
    const adapter = engine === 'grok' ? new GrokAdapter(opts(dir, engine)) : new CursorAdapter({ ...opts(dir, engine), resumeSessionId: cursorSessionId })
    adapter.on('error', () => {})
    if (adapter instanceof GrokAdapter) {
      const token = 'a'.repeat(64)
      adapter.setGrokRoute({ routeToken: token, baseUrl: `http://127.0.0.1:18789/internal/v5/grok-relay/route/${token}/v1` })
    }
    try {
      for (const readOnly of [true, false]) {
        const run = adapter.submitTurn({ input: 'verify the outline', readOnly, onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
        await run.submitted
        const summary = await run.summary
        await adapter.waitForOutputDrain()
        assert.equal(summary?.isError, false, JSON.stringify(summary))
        assert.equal(summary?.assistantText, 'read verified')
        assert.ok(summary?.tools.some((tool) => tool.toolName === 'Read'))
        assert.equal(await readFile(target, 'utf8'), readOnly ? 'original' : 'changed')
      }
      const [restricted, normal] = (await readFile(capture, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(restricted.writeCalls, 0)
      assert.equal(restricted.writeCharges, 0)
      assert.equal(normal.writeCalls, 1)
      if (engine === 'grok') {
        assert.notEqual(restricted.cwd, dir)
        assert.equal(restricted.home, restricted.cwd)
        assert.equal(normal.cwd, dir)
        assert.ok(restricted.argv[restricted.argv.indexOf('--rules') + 1].includes(dir))
        assert.match(restricted.policy, /OPENCLAUDE_ADVISOR_READ_ONLY = "1"/)
        assert.match(normal.policy, /OPENCLAUDE_ADVISOR_READ_ONLY = "0"/)
      } else {
        assert.equal(restricted.policy, '1')
        assert.equal(normal.policy, '0')
        assert.notEqual(restricted.cwd, dir)
        assert.equal(normal.cwd, dir)
        assert.equal(restricted.resumeId, cursorSessionId)
        assert.equal(normal.resumeId, cursorSessionId)
        const db = new Database(cursorResumeStorePath(dir, cursorSessionId), { readonly: true })
        assert.deepEqual(db.prepare('SELECT text FROM history').all(), [{ text: 'prior conversation' }])
        db.close()
      }
    } finally {
      await adapter.shutdown()
      keys.forEach((key, i) => old[i] === undefined ? delete process.env[key] : process.env[key] = old[i])
      paths.home = oldStorageHome
      await rm(dir, { recursive: true, force: true })
    }
  })
}
