import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { advisorReadOnlyThreadConfig, assertAdvisorReadOnlyRuntime, buildAdvisorReadOnlyArgs } from '../engine/codexAdvisorReadOnly.js'

// Opt-in integration probe: all model traffic terminates at a local capture
// server; no production credentials or model API calls. Set the exact pinned
// binary path with CODEX_ADVISOR_NATIVE_BINARY.
test('installed Codex actually removes execution schemas and keeps safe MCP plus consult', {
  skip: !process.env.CODEX_ADVISOR_NATIVE_BINARY,
  timeout: 45_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-native-readonly-'))
  const mcp = join(cwd, 'readonly-mcp.cjs')
  const catalog = join(cwd, 'probe-models.json')
  // Supply deterministic metadata so the control arm always exposes patch,
  // even after this historical slug disappears from the vendor catalog.
  await writeFile(catalog, JSON.stringify({ models: [{
    slug: 'readonly-probe-model', display_name: 'Probe', description: 'Local test only',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'low' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
    availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'tokens', limit: 10000 },
    base_instructions: 'You are a local test probe. Reply OK.',
    context_window: 200000, experimental_supported_tools: [],
  }] }))
  await writeFile(mcp, `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const r = JSON.parse(line); if (r.id === undefined) return;
  const result = r.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'readonly-probe', version: '1' } }
    : r.method === 'tools/list' ? { tools: ['oc_grep','consult_advisor','skill_save'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }
    : { content: [{ type: 'text', text: 'read only' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
});
`)
  await writeFile(join(cwd, 'config.toml'), `[mcp_servers.inherited]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(mcp)}]\n`)
  try {
    const namesByMode: string[][] = []
    let threadId: string | undefined
    for (const readOnly of [false, true, false]) {
      let resolveBody!: (value: any) => void
      const bodyReceived = new Promise<any>(resolve => { resolveBody = resolve })
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"type":"response.completed","response":{"id":"probe","status":"completed","output":[]}}\n\n')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      const proc = spawn(process.env.CODEX_ADVISOR_NATIVE_BINARY!, [
        'app-server',
        '-c', 'model_provider="probe"',
        '-c', `model_providers.probe={name="Probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
        '-c', 'model="readonly-probe-model"',
        '-c', `model_catalog_json=${JSON.stringify(catalog)}`,
        '-c', 'features.apps=false', '-c', 'features.plugins=false',
        '-c', 'mcp_servers={}',
        '-c', `mcp_servers.openclaude_memory.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.openclaude_memory.args=[${JSON.stringify(mcp)}]`,
        ...(readOnly ? ['-c', 'mcp_servers.openclaude_memory.enabled_tools=["oc_grep","consult_advisor"]', ...buildAdvisorReadOnlyArgs()] : []),
        '--listen', 'stdio://',
      ], { cwd, env: { ...process.env, CODEX_HOME: cwd, OPENAI_API_KEY: 'local-probe-only' } })
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
      let resolveCompleted!: () => void
      const turnCompleted = new Promise<void>(resolve => { resolveCompleted = resolve })
      let serial = 0
      let stderr = ''
      proc.stderr.on('data', chunk => { stderr += chunk.toString() })
      proc.on('exit', code => {
        for (const p of pending.values()) p.reject(new Error(`Codex exited ${code}: ${stderr.slice(-2000)}`))
        pending.clear()
      })
      const lines = createInterface({ input: proc.stdout })
      lines.on('line', line => {
        const response = JSON.parse(line)
        if (response.method === 'turn/completed') resolveCompleted()
        const p = pending.get(response.id)
        if (!p) return
        pending.delete(response.id)
        if (response.error) p.reject(new Error(JSON.stringify(response.error)))
        else p.resolve(response.result)
      })
      const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        const id = ++serial
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out: ${stderr.slice(-2000)}`))
        }, 10_000)
        pending.set(id, {
          resolve: value => { clearTimeout(timeout); resolve(value) },
          reject: error => { clearTimeout(timeout); reject(error) },
        })
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
      try {
        const initialized = await request('initialize', { clientInfo: { name: 'readonly-probe', version: '1' }, capabilities: { experimentalApi: true } })
        console.log(JSON.stringify({ userAgent: initialized.userAgent }))
        if (readOnly) assertAdvisorReadOnlyRuntime(initialized)
        const configuration = await request('config/read', { includeLayers: false, cwd })
        proc.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
        const thread = await request(threadId ? 'thread/resume' : 'thread/start', {
          ...(threadId ? { threadId } : {}),
          approvalPolicy: 'never', sandbox: readOnly ? 'read-only' : 'danger-full-access', cwd,
          ...(readOnly ? { environments: [], config: advisorReadOnlyThreadConfig(configuration, true) } : {}),
        })
        threadId = thread.thread.id
        await request('turn/start', {
          threadId: thread.thread.id, input: [{ type: 'text', text: 'Reply OK without executing tools.' }],
          ...(readOnly ? { environments: [], sandboxPolicy: { type: 'readOnly', networkAccess: false } } : {}),
        })
        const body = await Promise.race([
          bodyReceived,
          new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error(`No local request: ${stderr.slice(-2000)}`)), 15_000); timeout.unref() }),
        ])
        const names: string[] = []
        const collect = (value: any): void => {
          if (Array.isArray(value)) { for (const v of value) collect(v); return }
          if (!value || typeof value !== 'object') return
          if (typeof value.name === 'string') names.push(value.name)
          // code-mode embeds nested tool definitions in its description.
          if (typeof value.description === 'string') names.push(value.description)
          if (value.tools) collect(value.tools)
          if (value.functions) collect(value.functions)
        }
        collect(body.tools)
        await Promise.race([turnCompleted, new Promise((_, reject) => {
          const timeout = setTimeout(() => reject(new Error('Local probe turn did not complete')), 10_000)
          timeout.unref()
        })])
        namesByMode.push(names)
        console.log(JSON.stringify({ readOnly, tools: names.filter(n => n.length < 160) }))
      } finally {
        lines.close()
        if (proc.exitCode === null && proc.signalCode === null) {
          await new Promise<void>(resolve => {
            proc.once('close', () => resolve())
            proc.kill('SIGTERM')
          })
        }
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    }
    const normal = namesByMode[0].join('\n')
    const readonly = namesByMode[1].join('\n')
    assert.match(normal, /apply_patch/)
    assert.match(normal, /exec_command/)
    assert.doesNotMatch(readonly, /apply_patch|exec_command|write_stdin|shell_command|image_gen|skill_save|spawn_agent|request_permissions|computer_use|browser_use|create_goal|update_goal/)
    assert.match(readonly, /oc_grep/)
    assert.match(readonly, /consult_advisor/)
    assert.match(namesByMode[2].join('\n'), /apply_patch/)
    assert.match(namesByMode[2].join('\n'), /exec_command/)
    assert.match(namesByMode[2].join('\n'), /skill_save/)
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 })
  }
})
