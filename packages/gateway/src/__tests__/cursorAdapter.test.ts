import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import {
  CURSOR_MAX_PLATFORM_ENVELOPE_BYTES,
  CURSOR_MAX_PROMPT_ARG_BYTES,
  CURSOR_MAX_TURN_PAYLOAD_BYTES,
  CursorAdapter,
  _internals,
} from '../engine/cursorAdapter.js'
import type { EngineEvent, EngineExternalBillingEvent } from '../engine/engineEvents.js'
import type { EngineCreateOpts } from '../engine/registry.js'

const REQUEST = 'b'.repeat(32)
const GATEWAY_SECRET = 'gateway_secret_must_only_be_in_token_file'
const AMBIENT_SECRET_KEYS = [
  'OPENCLAUDE_V3_CONTAINER_TOKEN',
  'ANTHROPIC_API_KEY',
  'CURSOR_API_KEY',
  'DATABASE_URL',
  'MINIMAX_API_KEY',
] as const
function opts(cwd: string, model = 'cursor-auto'): EngineCreateOpts {
  return {
    sessionKey: 'agent:main:webchat:dm:cursor-test',
    agentId: 'main',
    agentBaseDir: cwd,
    config: {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: GATEWAY_SECRET },
      auth: { mode: 'api_key', claudeCodePath: cwd },
      defaults: { model: 'cursor-auto', permissionMode: 'default' },
    } as OpenClaudeConfig,
    persona: path.join(cwd, 'persona.md'),
    permissionMode: 'bypassPermissions',
    model,
  } as EngineCreateOpts
}
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}
async function createBaselineSkills(root: string): Promise<string> {
  const baselineRoot = path.join(root, 'baseline-skills')
  const skillDir = path.join(baselineRoot, 'skill-search')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: skill-search',
      'description: "Search the OpenClaude skill catalog"',
      'version: 1.0.0',
      '---',
      '',
      '# skill-search',
    ].join('\n'),
  )
  return baselineRoot
}

describe('CursorAdapter', () => {
  test('prefers the hot-config Cursor wrapper and preserves the image fallback', () => {
    assert.equal(
      _internals.resolveCursorWrapperBin(undefined, true),
      '/run/oc/platform/current/bin/oc-cursor',
    )
    assert.equal(
      _internals.resolveCursorWrapperBin(undefined, false),
      '/usr/local/bin/oc-cursor',
    )
    assert.equal(
      _internals.resolveCursorWrapperBin('  /tmp/test-cursor-wrapper  ', true),
      '/tmp/test-cursor-wrapper',
    )
  })

  // ── 工具卡归一化:Cursor 原生工具 → 产品工具名 + 产品 input 形态 ──
  // fixture 形态取自 selfhost 真实 turn tape(cursor-opus-5-high 会话)。
  test('normalizes cursor-native tool names and inputs to product card shapes', () => {
    // editToolCall 携带 streamContent(整文件写入)→ Write
    const editAsWrite = {
      type: 'tool_call',
      tool_call: {
        id: 't-edit-write',
        editToolCall: { args: { path: '/tmp/probe.sh', streamContent: '#!/bin/bash\nexit 0\n' } },
      },
    }
    assert.equal(_internals.toolNameOf(editAsWrite as never), 'Write')
    assert.deepEqual(_internals.toolInputOf(editAsWrite as never), {
      file_path: '/tmp/probe.sh',
      content: '#!/bin/bash\nexit 0\n',
    })

    // editToolCall 携带 old/new(局部编辑)→ Edit
    const editAsEdit = {
      type: 'tool_call',
      tool_call: {
        id: 't-edit-patch',
        editToolCall: { args: { path: '/tmp/a.ts', old_string: 'foo', new_string: 'bar' } },
      },
    }
    assert.equal(_internals.toolNameOf(editAsEdit as never), 'Edit')
    assert.deepEqual(_internals.toolInputOf(editAsEdit as never), {
      file_path: '/tmp/a.ts',
      old_string: 'foo',
      new_string: 'bar',
    })

    // updateTodosToolCall + Python repr 字符串化的 todos → TodoWrite + 产品枚举
    const todos = {
      type: 'tool_call',
      tool_call: {
        id: 't-todos',
        updateTodosToolCall: {
          args: {
            merge: 'False',
            todos: `[{'content': '勘察', 'status': 'TODO_STATUS_IN_PROGRESS'}, {'content': '实现', 'status': 'TODO_STATUS_PENDING'}, {'content': '验证', 'status': 'TODO_STATUS_COMPLETED'}]`,
          },
        },
      },
    }
    assert.equal(_internals.toolNameOf(todos as never), 'TodoWrite')
    assert.deepEqual(_internals.toolInputOf(todos as never), {
      todos: [
        { content: '勘察', status: 'in_progress' },
        { content: '实现', status: 'pending' },
        { content: '验证', status: 'completed' },
      ],
    })

    // taskToolCall → Task(description/prompt 提到顶层)
    const task = {
      type: 'tool_call',
      tool_call: {
        id: 't-task',
        taskToolCall: {
          args: { description: '调研项目', prompt: '任务:调研并产出报告', subagentType: '' },
        },
      },
    }
    assert.equal(_internals.toolNameOf(task as never), 'Task')
    assert.deepEqual(_internals.toolInputOf(task as never), {
      description: '调研项目',
      prompt: '任务:调研并产出报告',
    })

    // askQuestionToolCall + Python repr questions → AskUserQuestion wire 形态
    const ask = {
      type: 'tool_call',
      tool_call: {
        id: 't-ask',
        askQuestionToolCall: {
          args: {
            title: '确认下线范围',
            runAsync: 'False',
            questions: `[{'allowMultiple': False, 'id': 'replacement', 'options': [{'id': 'flash', 'label': '用 flash 替代'}, {'id': 'none', 'label': '直接下线'}], 'prompt': '下线前需要确认替代方案'}]`,
          },
        },
      },
    }
    assert.equal(_internals.toolNameOf(ask as never), 'AskUserQuestion')
    assert.deepEqual(_internals.toolInputOf(ask as never), {
      questions: [{
        question: '下线前需要确认替代方案',
        header: '确认下线范围',
        options: [
          { label: '用 flash 替代' },
          { label: '直接下线' },
        ],
      }],
    })

    // awaitToolCall → TaskOutput(task_id)
    const awaitTool = {
      type: 'tool_call',
      tool_call: { id: 't-await', awaitToolCall: { args: { taskId: '455287', blockUntilMs: '60000' } } },
    }
    assert.equal(_internals.toolNameOf(awaitTool as never), 'TaskOutput')
    assert.deepEqual(_internals.toolInputOf(awaitTool as never), { task_id: '455287' })

    // grepToolCall → Grep(pattern/path)
    const grep = {
      type: 'tool_call',
      tool_call: {
        id: 't-grep',
        grepToolCall: { args: { pattern: 'check:v5', path: '/repo/package.json', outputMode: 'content' } },
      },
    }
    assert.equal(_internals.toolNameOf(grep as never), 'Grep')
    assert.deepEqual(_internals.toolInputOf(grep as never), {
      pattern: 'check:v5',
      path: '/repo/package.json',
    })
  })

  test('python-repr loose parsing never rewrites True/False/None inside string content', () => {
    // codex 审计 blocker:全局替换会把内容里的英文词改写并持久化。
    // 字符串字面量内的词必须原样保留,裸字面量才转换。
    const contentPreserved = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-words',
        updateTodosToolCall: {
          args: {
            todos: `[{'content': '核验 True / False / None 分支', 'status': 'TODO_STATUS_PENDING'}]`,
          },
        },
      },
    }
    const input = _internals.toolInputOf(contentPreserved as never) as { todos: Array<{ content: string; status: string }> }
    if (input.todos?.[0]?.content !== '核验 True / False / None 分支') {
      throw new Error(`string content rewritten: ${JSON.stringify(input)}`)
    }
    if (input.todos[0]!.status !== 'pending') throw new Error('bare literal not converted')

    // 内容里嵌双引号:repr 解析器(单引号定界)必须逐字保留并成功归一化 ——
    // 旧"引号替换+JSON.parse"路线对这种输入要么解析失败回退、要么歪打正着
    // 篡改内容(codex 审计/复审两轮 blocker)。
    const ambiguous = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-ambiguous',
        updateTodosToolCall: {
          args: {
            todos: `[{'content': '带 "双引号" 的 True 文案', 'status': 'TODO_STATUS_PENDING'}]`,
          },
        },
      },
    }
    const parsed = _internals.toolInputOf(ambiguous as never) as { todos: Array<{ content: string; status: string }> }
    if (parsed.todos?.[0]?.content !== '带 "双引号" 的 True 文案') {
      throw new Error(`embedded dquote content not verbatim: ${JSON.stringify(parsed)}`)
    }
    if (parsed.todos[0]!.status !== 'pending') throw new Error('status not normalized 3')

    // 裸 True/False/None + 嵌套引号内容混合:allowMultiple 是裸 False → false;
    // 选项文案里的词保留;反斜杠转义不吞字符。
    const ask = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-ask',
        askQuestionToolCall: {
          args: {
            title: '确认',
            questions: `[{'allowMultiple': False, 'prompt': '保留 True 与 None 文案', 'options': [{'id': 'a', 'label': 'None'}, {'id': 'b', 'label': 'keep True'}]}]`,
          },
        },
      },
    }
    const askInput = _internals.toolInputOf(ask as never) as {
      questions: Array<{ question: string; multiSelect?: boolean; options: Array<{ label: string }> }>
    }
    if (askInput.questions[0]!.question !== '保留 True 与 None 文案') throw new Error('question content rewritten')
    if (askInput.questions[0]!.multiSelect !== undefined) throw new Error('bare False not converted to false')
    if (askInput.questions[0]!.options[0]!.label !== 'None') throw new Error('option label rewritten')
    if (askInput.questions[0]!.options[1]!.label !== 'keep True') throw new Error('option label rewritten 2')
  })

  test('python repr with embedded double quotes parses with content verbatim (codex re-audit)', () => {
    // 复审反例:内容里嵌双引号 + 裸 True。旧"全局引号替换"路线会把它歪打正着
    // 解析成 {"content":"a","flag":true,"tail":"b"} —— 内容被静默截断重组。
    // repr 解析器必须逐字保留单引号字符串内容(含双引号),裸 True 只在字符串外。
    const embedded = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-embedded-dquote',
        updateTodosToolCall: {
          args: {
            todos: `[{'content': 'a", "flag": True, "tail": "b', 'status': 'TODO_STATUS_PENDING'}]`,
          },
        },
      },
    }
    const input = _internals.toolInputOf(embedded as never) as { todos: Array<{ content: string; status: string }> }
    if (input.todos?.[0]?.content !== 'a", "flag": True, "tail": "b') {
      throw new Error(`content not verbatim: ${JSON.stringify(input)}`)
    }
    if (input.todos[0]!.status !== 'pending') throw new Error('status not normalized')

    // 转义单引号 \' 与转义反斜杠在内容里按字面还原。
    const escaped = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-escaped',
        updateTodosToolCall: {
          args: { todos: `[{'content': 'it\\'s a C:\\\\path True', 'status': 'TODO_STATUS_COMPLETED'}]` },
        },
      },
    }
    const escInput = _internals.toolInputOf(escaped as never) as { todos: Array<{ content: string; status: string }> }
    if (escInput.todos?.[0]?.content !== "it's a C:\\path True") {
      throw new Error(`escapes not resolved: ${JSON.stringify(escInput)}`)
    }
    if (escInput.todos[0]!.status !== 'completed') throw new Error('status not normalized 2')
  })

  test('python repr hex escapes and __proto__ keys stay faithful (codex final-audit)', () => {
    // \xNN 是 python repr 的正式转义:必须还原成原字符,不能静默变成字面 '\x00'。
    const hexEsc = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-hex',
        updateTodosToolCall: {
          args: { todos: `[{'content': 'a\\x00b\\x41', 'status': 'TODO_STATUS_PENDING'}]` },
        },
      },
    }
    const hexInput = _internals.toolInputOf(hexEsc as never) as { todos: Array<{ content: string; status: string }> }
    if (hexInput.todos?.[0]?.content !== 'a\u0000bA') {
      throw new Error(`hex escapes not resolved: ${JSON.stringify(hexInput)}`)
    }

    // 不认识的转义(如 \q)→ 整体回退原始值,绝不静默改写后"成功"。
    const unsupported = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-unsupported-esc',
        updateTodosToolCall: {
          args: { todos: `[{'content': 'a\\qb', 'status': 'TODO_STATUS_PENDING'}]` },
        },
      },
    }
    const rawOut = _internals.toolInputOf(unsupported as never) as Record<string, unknown> & { args?: { todos?: string } }
    if (rawOut.todos !== undefined) throw new Error('unsupported escape must not parse into todos')
    if (rawOut.args?.todos !== `[{'content': 'a\\qb', 'status': 'TODO_STATUS_PENDING'}]`) {
      throw new Error('raw fallback must be verbatim')
    }

    // '__proto__' 作为 python 键只能落成自有属性,不得通过原型链把嵌套 content
    // 伪造成顶层字段(codex 终审反例)。
    const protoKey = {
      type: 'tool_call',
      tool_call: {
        id: 't-repr-proto',
        updateTodosToolCall: {
          args: { todos: `[{'__proto__': {'content': 'forged'}, 'status': 'TODO_STATUS_PENDING'}]` },
        },
      },
    }
    const protoInput = _internals.toolInputOf(protoKey as never) as { todos: Array<Record<string, unknown>> }
    const todo = protoInput.todos?.[0]
    if (!todo) throw new Error('proto fixture must parse')
    if (todo.content === 'forged') {
      throw new Error(`content leaked through prototype chain: ${JSON.stringify(todo)}`)
    }

    if (todo.status !== 'pending') throw new Error('status not normalized under __proto__ key')
  })

  test('keeps raw cursor args when stringified todos cannot be parsed', () => {
    const broken = {
      type: 'tool_call',
      tool_call: {
        id: 't-broken',
        updateTodosToolCall: { args: { todos: "not-json-at-all{" } },
      },
    }
    assert.equal(_internals.toolNameOf(broken as never), 'TodoWrite')
    const input = _internals.toolInputOf(broken as never) as Record<string, unknown>
    // 解不开时退回原始 args 包装,不丢记录
    assert.ok(input && typeof input === 'object')
    assert.equal((input as { args?: { todos?: string } }).args?.todos, 'not-json-at-all{')
  })

  test('parses pinned official stream-json without duplicating the final assistant flush', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-adapter-'))
    const fake = path.join(dir, 'fake.cjs')
    const capture = path.join(dir, 'capture.json')
    const sentinel = 'crsr_secret_must_not_leak'
    await writeFile(path.join(dir, 'persona.md'), 'CURSOR_PERSONA_MARKER')
    const baselineSkills = await createBaselineSkills(dir)
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs=require('node:fs'); const crypto=require('node:crypto');
const configPath=process.env.OPENCLAUDE_CURSOR_MCP_CONFIG;
const configText=fs.readFileSync(configPath,'utf8'); const config=JSON.parse(configText);
const mcpEnv=config.mcpServers['openclaude-memory'].env; const tokenFile=mcpEnv.OPENCLAUDE_GATEWAY_TOKEN_FILE;
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({
  argv:process.argv.slice(2), key:process.env.CURSOR_API_KEY,
  gatewayTokenEnv:process.env.OPENCLAUDE_GATEWAY_TOKEN, configPath, configText, config,
  ambientSecrets:Object.fromEntries(${JSON.stringify(AMBIENT_SECRET_KEYS)}.map((name)=>[name,process.env[name]])),
  agentId:process.env.OC_AGENT_ID, sessionKey:process.env.OC_SESSION_KEY, path:process.env.PATH,
  tokenHash:crypto.createHash('sha256').update(fs.readFileSync(tokenFile)).digest('hex'),
  configMode:fs.statSync(configPath).mode & 0o777, tokenMode:fs.statSync(tokenFile).mode & 0o777,
  contextMode:fs.statSync(require('node:path').dirname(configPath)).mode & 0o777,
}))
for(const e of [
  {type:'system',subtype:'init',apiKeySource:'env',model:'Auto'},
  {type:'thinking',subtype:'delta',text:'think'},
  {type:'thinking',subtype:'completed'},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'CURSOR'}]},timestamp_ms:1},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'_'}]},timestamp_ms:2},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'OK'}]},timestamp_ms:3},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'CURSOR_OK'}]}},
  {type:'result',subtype:'success',is_error:false,result:'CURSOR_OK',usage:{inputTokens:10,outputTokens:4,cacheReadTokens:3,cacheWriteTokens:2}},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldBaselineSkills = process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
    const oldAmbientSecrets = Object.fromEntries(
      AMBIENT_SECRET_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof AMBIENT_SECRET_KEYS)[number], string | undefined>
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = baselineSkills
    for (const key of AMBIENT_SECRET_KEYS) process.env[key] = `${sentinel}_${key}`
    try {
      const adapterOpts = opts(dir)
      adapterOpts.sessionId = 'cursor-repo-session'
      adapterOpts.getRepoSnapshot = () => ({
        status: 'ready',
        selectionVersion: 1,
        owner: 'example',
        repo: 'context-repo',
        branch: 'main',
        workspaceDir: dir,
        headSha: '1234567890abcdef',
        errorCode: null,
        errorMessage: null,
      })
      const adapter = new CursorAdapter(adapterOpts)
      const events: EngineEvent[] = []
      const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (event) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'plain cursor turn payload',
        requestId: REQUEST,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.equal(summary?.assistantText, 'CURSOR_OK')
      assert.equal(summary?.thinkingText, 'think')
      assert.deepEqual(billing, [
        {
          requestId: REQUEST,
          engine: 'cursor',
          status: 'success',
          durationMs: billing[0]!.durationMs,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      ])
      const text = events
        .filter(
          (event): event is Extract<EngineEvent, { kind: 'block' }> =>
            event.kind === 'block' && event.block.kind === 'text',
        )
        .map((event) => (event.block.kind === 'text' ? event.block.text : ''))
        .join('')
      assert.equal(text, 'CURSOR_OK')
      const launched = JSON.parse(await readFile(capture, 'utf8'))
      assert.deepEqual(launched.argv.slice(0, 2), ['--force', '--'])
      assert.equal(launched.argv.includes('--mode'), false)
      assert.equal(launched.argv.includes('--model'), false)
      assert.equal(launched.argv.includes('--output-format'), false)
      assert.equal(launched.key, undefined)
      assert.equal(launched.gatewayTokenEnv, undefined)
      assert.deepEqual(launched.ambientSecrets, {})
      assert.equal(launched.agentId, 'main')
      assert.equal(launched.sessionKey, 'agent:main:webchat:dm:cursor-test')
      assert.equal(launched.path, '/usr/local/bin:/usr/bin:/bin')
      assert.equal(launched.configMode, 0o600)
      assert.equal(launched.tokenMode, 0o600)
      assert.equal(launched.contextMode, 0o700)
      assert.equal(launched.tokenHash, createHash('sha256').update(GATEWAY_SECRET).digest('hex'))
      assert.deepEqual(Object.keys(launched.config), ['mcpServers'])
      assert.deepEqual(Object.keys(launched.config.mcpServers), ['openclaude-memory'])
      assert.deepEqual(Object.keys(launched.config.mcpServers['openclaude-memory']).sort(), [
        'args',
        'command',
        'env',
      ])
      assert.equal(launched.configText.includes(GATEWAY_SECRET), false)
      assert.equal(JSON.stringify(launched.argv).includes(GATEWAY_SECRET), false)
      const prompt = launched.argv.at(-1) as string
      assert.match(prompt, /CURSOR_PERSONA_MARKER/)
      assert.match(prompt, /# Skills/)
      assert.match(prompt, /# Memory/)
      assert.match(prompt, /# Platform capabilities/)
      assert.match(prompt, /example\/context-repo/)
      assert.match(prompt, /HEAD `1234567`/)
      assert.match(prompt, /<openclaude_platform_context>/)
      assert.equal(
        JSON.parse(prompt.split('<openclaude_current_turn_payload_json>').at(-1)!.split('\n')[2]!),
        'plain cursor turn payload',
      )
      assert.equal(JSON.stringify(events).includes(sentinel), false)
      await assert.rejects(stat(launched.configPath))
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('OPENCLAUDE_BASELINE_SKILLS_DIR', oldBaselineSkills)
      for (const key of AMBIENT_SECRET_KEYS) restoreEnv(key, oldAmbientSecrets[key])
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rebuilds platform and MCP context for every stateless turn on one adapter', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-multiturn-'))
    const fake = path.join(dir, 'fake.cjs')
    const capture = path.join(dir, 'captures.jsonl')
    await writeFile(path.join(dir, 'persona.md'), 'CURSOR_SECOND_TURN_PERSONA_MARKER')
    const baselineSkills = await createBaselineSkills(dir)
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs=require('node:fs'); const crypto=require('node:crypto');
const argv=process.argv.slice(2); const configPath=process.env.OPENCLAUDE_CURSOR_MCP_CONFIG;
const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
const tokenPath=config.mcpServers['openclaude-memory'].env.OPENCLAUDE_GATEWAY_TOKEN_FILE;
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({
  argv, prompt:argv.at(-1), configPath, tokenPath,
  tokenHash:crypto.createHash('sha256').update(fs.readFileSync(tokenPath)).digest('hex'),
})+'\\n');
console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'TURN_OK'}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    const oldBaselineSkills = process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = baselineSkills
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const runTurn = async (input: string): Promise<void> => {
        const run = adapter.submitTurn({
          input,
          requestId: REQUEST,
          onEvent: () => {},
          sessionTotals: { totalCostUSD: 0, turns: 0 },
          toolUseIdToName: new Map(),
        })
        await run.submitted
        assert.equal((await run.summary)?.assistantText, 'TURN_OK')
        await adapter.waitForOutputDrain()
      }

      await runTurn('FIRST_TURN_PAYLOAD_ONLY')
      await runTurn('SECOND_STATELESS_REPLAY_PAYLOAD_ONLY')

      const launched = (await readFile(capture, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(launched.length, 2)
      assert.notEqual(launched[0].configPath, launched[1].configPath)
      assert.notEqual(launched[0].tokenPath, launched[1].tokenPath)
      for (const [index, expectedPayload] of [
        [0, 'FIRST_TURN_PAYLOAD_ONLY'],
        [1, 'SECOND_STATELESS_REPLAY_PAYLOAD_ONLY'],
      ] as const) {
        const turn = launched[index]
        assert.equal(turn.argv.includes('--resume'), false)
        assert.equal(turn.argv.includes('--continue'), false)
        assert.match(turn.prompt, /CURSOR_SECOND_TURN_PERSONA_MARKER/)
        assert.match(turn.prompt, /<openclaude_platform_context>/)
        assert.match(turn.prompt, /# Skills/)
        assert.match(turn.prompt, /# Memory/)
        assert.match(turn.prompt, /# Platform capabilities/)
        assert.equal(
          JSON.parse(
            turn.prompt
              .split('<openclaude_current_turn_payload_json>')
              .at(-1)
              .split('\n')[2],
          ),
          expectedPayload,
        )
        assert.equal(turn.tokenHash, createHash('sha256').update(GATEWAY_SECRET).digest('hex'))
        await assert.rejects(stat(turn.configPath))
        await assert.rejects(stat(turn.tokenPath))
      }
      assert.equal(launched[1].prompt.includes('FIRST_TURN_PAYLOAD_ONLY'), false)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      restoreEnv('OPENCLAUDE_BASELINE_SKILLS_DIR', oldBaselineSkills)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('suppresses timestamped aggregate flushes before retry and interaction_query', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-boundary-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
for(const e of [
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'A'}]},timestamp_ms:1},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'A'}]},timestamp_ms:2},
  {type:'retry',subtype:'rate_limit',timestamp_ms:3},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'B'}]},timestamp_ms:4},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'B'}]},timestamp_ms:5},
  {type:'interaction_query',subtype:'request',query_type:'ask_question',timestamp_ms:6},
  {type:'interaction_query',subtype:'response',query_type:'ask_question',timestamp_ms:7},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'C'}]},timestamp_ms:8},
  {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'C'}]}},
  {type:'result',subtype:'success',is_error:false},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.assistantText, 'ABC')
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('parses pinned official tool_call started/completed, including completion-only calls, and normalizes one-of variants', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-tool-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
for(const e of [
  {type:'tool_call',subtype:'started',call_id:'schema-0',tool_call:{getMcpToolsToolCall:{args:{server:'openclaude-memory',toolName:'skill_search'}}}},
  {type:'tool_call',subtype:'completed',call_id:'schema-0',tool_call:{getMcpToolsToolCall:{args:{server:'openclaude-memory',toolName:'skill_search'},result:{success:{content:'schema'}}}}},
  {type:'tool_call',subtype:'started',tool_call:{toolCallId:'shell\\n1',shellToolCall:{args:{command:'pwd'}}}},
  {type:'tool_call',subtype:'completed',tool_call:{toolCallId:'shell\\n1',shellToolCall:{args:{command:'pwd'},result:{success:{stdout:'ok',stderr:''}}}}},
  {type:'tool_call',subtype:'completed',tool_call:{toolCallId:'read\\n2',readToolCall:{args:{path:'/missing',offset:2,limit:3},result:{error:{message:'missing'}}}}},
  {type:'tool_call',subtype:'started',call_id:'glob-3',tool_call:{globToolCall:{args:{globPattern:'*.ts',targetDirectory:'/repo'}}}},
  {type:'tool_call',subtype:'completed',call_id:'glob-3',tool_call:{globToolCall:{args:{globPattern:'*.ts',targetDirectory:'/repo'},result:{success:{files:['a.ts','b.ts']}}}}},
  {type:'tool_call',subtype:'started',call_id:'web-4',tool_call:{webSearchToolCall:{args:{searchTerm:'official Cursor CLI'}}}},
  {type:'tool_call',subtype:'completed',call_id:'web-4',tool_call:{webSearchToolCall:{args:{searchTerm:'official Cursor CLI'},result:{success:{references:[{title:'overview',url:'https://cursor.com/docs/cli/overview',chunk:'official result'}]}}}}},
  {type:'tool_call',subtype:'started',call_id:'mcp-5',tool_call:{mcpToolCall:{args:{name:'openclaude-memory-skill_search',args:{query:'cursor'},toolName:'skill_search',serverIdentifier:'openclaude-memory'}}}},
  {type:'tool_call',subtype:'completed',call_id:'mcp-5',tool_call:{mcpToolCall:{args:{name:'openclaude-memory-skill_search',args:{query:'cursor'},toolName:'skill_search',serverIdentifier:'openclaude-memory'},result:{success:{content:[{text:{text:'found skill'}}],isError:false}}}}},
  {type:'result',subtype:'success',is_error:false},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.tools.length, 5)
      assert.match(summary?.tools[0]?.toolUseId ?? '', /^cursor-tool-[a-f0-9]{64}$/)
      assert.equal(summary?.tools[0]?.toolName, 'Bash')
      assert.deepEqual(summary?.tools[0]?.inputJson, { command: 'pwd' })
      assert.equal(summary?.tools[0]?.output, 'ok')
      assert.equal(summary?.tools[0]?.completed, true)
      assert.equal(summary?.tools[0]?.isError, false)
      assert.equal(summary?.tools[1]?.toolName, 'Read')
      assert.deepEqual(summary?.tools[1]?.inputJson, { file_path: '/missing', offset: 2, limit: 3 })
      assert.equal(summary?.tools[1]?.completed, true)
      assert.equal(summary?.tools[1]?.isError, true)
      assert.match(summary?.tools[1]?.output ?? '', /missing/)
      assert.equal(summary?.tools[2]?.toolName, 'Glob')
      assert.deepEqual(summary?.tools[2]?.inputJson, { pattern: '*.ts', path: '/repo' })
      assert.equal(summary?.tools[2]?.output, 'a.ts\nb.ts')
      assert.equal(summary?.tools[3]?.toolName, 'WebSearch')
      assert.deepEqual(summary?.tools[3]?.inputJson, { query: 'official Cursor CLI' })
      assert.equal(summary?.tools[3]?.output, 'official result')
      assert.equal(summary?.tools[4]?.toolName, 'mcp__openclaude-memory__skill_search')
      assert.deepEqual(summary?.tools[4]?.inputJson, { query: 'cursor' })
      assert.equal(summary?.tools[4]?.output, 'found skill')
      assert.equal(summary?.tools[4]?.isError, false)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('creates ordered text/thinking segments across one tool boundary with indexed live ids', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-segments-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
for(const e of [
  {type:'text',text:'A'},
  {type:'thinking',text:'T'},
  {type:'tool_call',subtype:'started',call_id:'tool-1',tool_call:{shellToolCall:{args:{command:'pwd'}}}},
  {type:'tool_call',subtype:'completed',call_id:'tool-1',tool_call:{shellToolCall:{result:{success:{stdout:'ok'}}}}},
  {type:'text',text:'B'},
  {type:'thinking',text:'U'},
  {type:'result',subtype:'success',is_error:false},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const events: EngineEvent[] = []
      let ordinal = 0
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        assistantMessageId: 'assistant-base',
        thinkingMessageId: 'thinking-base',
        nextDurableEventOrdinal: () => ordinal++,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()

      assert.deepEqual(
        summary?.assistantSegments.map(({ index, text }) => ({ index, text })),
        [
          { index: 0, text: 'A' },
          { index: 1, text: 'B' },
        ],
      )
      assert.deepEqual(
        summary?.thinkingSegments.map(({ index, text }) => ({ index, text })),
        [
          { index: 0, text: 'T' },
          { index: 1, text: 'U' },
        ],
      )
      const textIds = events.flatMap((event) =>
        event.kind === 'block' && event.block.kind === 'text' ? [event.block.messageId] : [],
      )
      const thinkingIds = events.flatMap((event) =>
        event.kind === 'block' && event.block.kind === 'thinking' ? [event.block.messageId] : [],
      )
      assert.deepEqual(textIds, ['assistant-base-s0', 'assistant-base-s1'])
      assert.deepEqual(thinkingIds, ['thinking-base-s0', 'thinking-base-s1'])
      const firstTextOrdinal = summary?.assistantSegments[0]?.eventOrdinal ?? -1
      const firstThinkingOrdinal = summary?.thinkingSegments[0]?.eventOrdinal ?? -1
      const toolOrdinal = summary?.tools[0]?.eventOrdinal ?? -1
      const secondTextOrdinal = summary?.assistantSegments[1]?.eventOrdinal ?? -1
      const secondThinkingOrdinal = summary?.thinkingSegments[1]?.eventOrdinal ?? -1
      assert.ok(firstTextOrdinal < firstThinkingOrdinal)
      assert.ok(firstThinkingOrdinal < toolOrdinal)
      assert.ok(toolOrdinal < secondTextOrdinal)
      assert.ok(secondTextOrdinal < secondThinkingOrdinal)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('domain-separated tool ids remain stable and cannot collide with raw safe-looking ids', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-tool-ids-'))
    const fake = path.join(dir, 'fake.cjs')
    const firstRaw = 'unsafe\nraw'
    const firstDerived = `cursor-tool-${createHash('sha256')
      .update(`openclaude:cursor-tool-id:v1:0:${firstRaw}`)
      .digest('hex')}`
    await writeFile(
      fake,
      `#!/usr/bin/env node
for(const e of [
  {type:'tool_call',subtype:'started',call_id:${JSON.stringify(firstRaw)},tool_call:{shellToolCall:{args:{command:'pwd'}}}},
  {type:'tool_call',subtype:'completed',call_id:${JSON.stringify(firstRaw)},tool_call:{shellToolCall:{result:{success:{stdout:'ok'}}}}},
  {type:'tool_call',subtype:'completed',call_id:${JSON.stringify(firstDerived)},tool_call:{globToolCall:{args:{globPattern:'*'},result:{rejected:{message:'no'}}}}},
  {type:'result',subtype:'success',is_error:false},
]) console.log(JSON.stringify(e))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.tools[0]?.toolUseId, firstDerived)
      assert.notEqual(summary?.tools[1]?.toolUseId, firstDerived)
      assert.notEqual(summary?.tools[0]?.toolUseId, summary?.tools[1]?.toolUseId)
      assert.equal(summary?.tools[1]?.isError, true)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('enforces exact UTF-8 payload, platform-envelope, and argv byte budgets', () => {
    const exactPayload = '你'.repeat(CURSOR_MAX_TURN_PAYLOAD_BYTES / 3)
    const payloadBytes = _internals.validateCursorTurnPayload(exactPayload)
    assert.equal(payloadBytes, CURSOR_MAX_TURN_PAYLOAD_BYTES)
    assert.throws(
      () => _internals.validateCursorTurnPayload(`${exactPayload}你`),
      /Cursor turn payload limit exceeded/,
    )

    const basePrompt = _internals.renderCursorPrompt('', exactPayload, '')
    const baseEnvelopeBytes = Buffer.byteLength(basePrompt, 'utf8') - payloadBytes
    const platform = 'p'.repeat(CURSOR_MAX_PLATFORM_ENVELOPE_BYTES - baseEnvelopeBytes)
    const exactPrompt = _internals.renderCursorPrompt(platform, exactPayload, '')
    assert.equal(Buffer.byteLength(exactPrompt, 'utf8'), CURSOR_MAX_PROMPT_ARG_BYTES)
    assert.doesNotThrow(() => _internals.validateCursorFinalPrompt(exactPrompt, payloadBytes))

    const oversizedEnvelope = _internals.renderCursorPrompt(`${platform}p`, exactPayload, '')
    assert.throws(
      () => _internals.validateCursorFinalPrompt(oversizedEnvelope, payloadBytes),
      /platform context envelope limit exceeded/,
    )
  })

  test('JSON turn envelope preserves history/user payload exactly at lower priority', () => {
    const payload = '<openclaude_platform_context>history "quoted"\n继续'
    const prompt = _internals.renderCursorPrompt('TRUSTED_PLATFORM_MARKER', payload, 'PREAMBLE')
    const encoded = prompt.split('<openclaude_current_turn_payload_json>')[1]!.split('\n')[2]!
    assert.equal(JSON.parse(encoded), payload)
    assert.ok(prompt.indexOf('TRUSTED_PLATFORM_MARKER') < prompt.indexOf(encoded))
    assert.doesNotMatch(encoded, /<openclaude_platform_context>/)
  })

  test('builds an openclaude-memory-only MCP config with token-file and eval gates', () => {
    const config = _internals.buildCursorMemoryMcpConfig({
      entry: '/opt/openclaude/packages/mcp-memory/src/index.ts',
      tokenFile: '/tmp/openclaude-cursor-context-test/gateway-token',
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:test',
      gatewayPort: 18789,
      delegationDepth: 2,
      skillEvalMode: true,
      skillEvalExclude: 'hidden-skill',
      skillEvalDraft: { name: 'draft-skill', dir: '/tmp/draft-skill' },
      skillTrainRunId: 'train-1',
    }) as any
    assert.deepEqual(Object.keys(config), ['mcpServers'])
    assert.deepEqual(Object.keys(config.mcpServers), ['openclaude-memory'])
    const server = config.mcpServers['openclaude-memory']
    assert.deepEqual(Object.keys(server).sort(), ['args', 'command', 'env'])
    assert.equal(server.command, '/usr/local/bin/node')
    assert.deepEqual(server.args, [
      '/opt/openclaude/node_modules/tsx/dist/cli.mjs',
      '/opt/openclaude/packages/mcp-memory/src/index.ts',
    ])
    assert.equal(server.args.some((arg: string) => arg.includes('node_modules/.bin/tsx')), false)
    assert.equal(
      server.env.OPENCLAUDE_GATEWAY_TOKEN_FILE,
      '/tmp/openclaude-cursor-context-test/gateway-token',
    )
    assert.equal(server.env.OPENCLAUDE_GATEWAY_TOKEN, undefined)
    assert.equal(server.env.OPENCLAUDE_SKILL_EVAL_MODE, '1')
    assert.equal(server.env.OPENCLAUDE_SKILL_EVAL_EXCLUDE, 'hidden-skill')
    assert.equal(server.env.OPENCLAUDE_SKILL_EVAL_DRAFT_NAME, 'draft-skill')
    assert.equal(server.env.OPENCLAUDE_SKILL_TRAIN_RUN_ID, 'train-1')
  })

  test('rejects an oversized UTF-8 prompt before spawning the Cursor wrapper', async () => {
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = '/definitely/not/a/cursor-wrapper'
    try {
      const adapter = new CursorAdapter(opts('/tmp'))
      assert.equal(adapter.capabilities.maxPromptBytes, CURSOR_MAX_TURN_PAYLOAD_BYTES)
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: '你'.repeat(40_000),
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await assert.rejects(run.submitted, /PROMPT_TOO_LONG/)
      const summary = await run.summary
      assert.equal(summary?.isError, true)
      assert.equal(summary?.errorClass, 'context_too_long')
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
    }
  })

  test('cleans only its fenced temp context when spawn fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-spawn-fail-'))
    const cwdSentinel = path.join(dir, 'cwd-sentinel')
    const home = await mkdtemp(path.join(tmpdir(), 'oc-cursor-home-sentinel-'))
    const homeSentinel = path.join(home, 'home-sentinel')
    await writeFile(cwdSentinel, 'keep')
    await writeFile(homeSentinel, 'keep')
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldHome = process.env.HOME
    process.env.OC_CURSOR_WRAPPER_BIN = path.join(dir, 'missing-wrapper')
    process.env.HOME = home
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'spawn must fail',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const summary = await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(summary?.isError, true)
      assert.equal(
        (adapter as unknown as { ownedContextDirs: Set<string> }).ownedContextDirs.size,
        0,
      )
      assert.equal(await readFile(cwdSentinel, 'utf8'), 'keep')
      assert.equal(await readFile(homeSentinel, 'utf8'), 'keep')
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('HOME', oldHome)
      await rm(dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  test('missing usage stays absent and auth/quota failures are external unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-error-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
console.log(JSON.stringify({type:'error',message:'401 authentication credential unavailable'}))
console.log(JSON.stringify({type:'result',subtype:'error',is_error:true}))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      const billing: EngineExternalBillingEvent[] = []
      const events: EngineEvent[] = []
      adapter.on('external_billing', (event) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: (event) => events.push(event),
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(billing[0]?.status, 'unavailable')
      assert.equal(billing[0]?.terminalCode, 'AUTH_UNAVAILABLE')
      assert.equal('usage' in billing[0]!, false)
      assert.equal(
        events.some((event) => event.kind === 'usage'),
        false,
      )
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('result.is_error cannot produce success external billing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-result-error-'))
    const fake = path.join(dir, 'fake.cjs')
    await writeFile(
      fake,
      `#!/usr/bin/env node
console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'quota exhausted'}))
`,
    )
    await chmod(fake, 0o755)
    const old = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    try {
      const adapter = new CursorAdapter(opts(dir))
      const billing: EngineExternalBillingEvent[] = []
      adapter.on('external_billing', (event) => billing.push(event))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      await run.summary
      await adapter.waitForOutputDrain()
      assert.equal(billing[0]?.status, 'unavailable')
      assert.equal(billing[0]?.terminalCode, 'QUOTA_UNAVAILABLE')
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', old)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test(
    'Stop interrupts the detached Cursor process group and emits cancelled terminal state',
    { timeout: 5_000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-stop-'))
      const fake = path.join(dir, 'fake.sh')
      const ready = path.join(dir, 'ready')
      const contextPathCapture = path.join(dir, 'context-path')
      await writeFile(
        fake,
        `#!/bin/sh
trap 'exit 130' INT TERM
printf '%s' "$OPENCLAUDE_CURSOR_MCP_CONFIG" > ${JSON.stringify(contextPathCapture)}
: > ${JSON.stringify(ready)}
while :; do sleep 1; done
`,
      )
      await chmod(fake, 0o755)
      const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
      process.env.OC_CURSOR_WRAPPER_BIN = fake
      try {
        const adapter = new CursorAdapter(opts(dir))
        const events: EngineEvent[] = []
        const billing: EngineExternalBillingEvent[] = []
        adapter.on('external_billing', (event) => billing.push(event))
        adapter.on('error', () => {})
        const run = adapter.submitTurn({
          input: 'wait',
          requestId: REQUEST,
          onEvent: (event) => events.push(event),
          sessionTotals: { totalCostUSD: 0, turns: 0 },
          toolUseIdToName: new Map(),
        })
        await run.submitted
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            await stat(ready)
            break
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        await stat(ready)
        assert.equal(adapter.interrupt(), true)
        const summary = await run.summary
        await adapter.waitForOutputDrain()
        assert.equal(summary?.stopReason, 'interrupted')
        assert.equal(billing[0]?.status, 'error')
        assert.equal(billing[0]?.terminalCode, 'USER_CANCELLED')
        assert.equal(
          events.some(
            (event) => event.kind === 'final' && event.meta?.stopReason === 'interrupted',
          ),
          true,
        )
        const configPath = await readFile(contextPathCapture, 'utf8')
        await assert.rejects(stat(configPath))
      } finally {
        restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  test('maps every canonical model to its exact controlled CLI argument', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-models-'))
    const fake = path.join(dir, 'fake.cjs')
    const capture = path.join(dir, 'capture.jsonl')
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2))+'\\n');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false}));
`,
    )
    await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    const models: Array<[string, string | null]> = [
      ['cursor-auto', null],
      ['cursor-grok-4.6-high', 'cursor-grok-4.6-high'],
      ['cursor-composer-2.5-fast', 'composer-2.5-fast'],
      ['cursor-opus-5-high', 'claude-opus-5-thinking-high'],
      ['cursor-fable-5-high', 'claude-fable-5-thinking-high'],
      ['cursor-grok-4.5-high', 'cursor-grok-4.5-high'],
    ]
    try {
      for (const [model] of models) {
        const adapter = new CursorAdapter(opts(dir, model))
        adapter.on('error', () => {})
        const run = adapter.submitTurn({
          input: 'x',
          requestId: REQUEST,
          onEvent: () => {},
          sessionTotals: { totalCostUSD: 0, turns: 0 },
          toolUseIdToName: new Map(),
        })
        await run.submitted
        await run.summary
        await adapter.waitForOutputDrain()
      }
      const guardedOpts = opts(dir)
      guardedOpts.permissionMode = 'default'
      const guarded = new CursorAdapter(guardedOpts)
      guarded.on('error', () => {})
      const guardedRun = guarded.submitTurn({
        input: 'x',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await guardedRun.submitted
      await guardedRun.summary
      await guarded.waitForOutputDrain()

      const launched = (await readFile(capture, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
      models.forEach(([, upstream], index) => {
        if (upstream === null) assert.equal(launched[index]!.includes('--model'), false)
        else assert.deepEqual(launched[index]!.slice(0, 2), ['--model', upstream])
        assert.equal(launched[index]!.includes('--force'), true)
        assert.equal(launched[index]!.includes('--mode'), false)
      })
      assert.equal(launched.at(-1)!.includes('--force'), true)
      assert.equal(launched.at(-1)!.includes('--mode'), false)
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects models outside the controlled allowlist', () => {
    const adapter = new CursorAdapter(opts('/tmp'))
    assert.throws(() => adapter.setModel('cursor-auto --force'), /not allowlisted/)
    assert.throws(() => adapter.setModel('gpt-5.3-codex'), /not allowlisted/)
    assert.throws(() => adapter.setEffortLevel('high'), /does not expose/)
  })

  // The wrapper starts the CLI through setsid, so a descendant that outlives
  // it sits in a session no signal of ours reaches while still holding this
  // turn's stdout. 'close' then never fires. Shutdown used to await that
  // barrier forever, which left the turn without a terminal state and the
  // client stuck in "stopping".
  test('shutdown gives up on a descendant that keeps stdout open', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-escaped-'))
    const fake = path.join(dir, 'fake.cjs')
    const escapedPidFile = path.join(dir, 'escaped.pid')
    await writeFile(path.join(dir, 'persona.md'), 'PERSONA')
    await writeFile(
      fake,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
escaped.unref();
fs.writeFileSync(${JSON.stringify(escapedPidFile)}, String(escaped.pid));
console.log(JSON.stringify({ type: 'assistant', text: 'working' }));
setInterval(() => {}, 1000);
`,
    )
    await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldGrace = process.env.OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS
    const oldFinal = process.env.OPENCLAUDE_CURSOR_SHUTDOWN_FINAL_DRAIN_MS
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    process.env.OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS = '150'
    process.env.OPENCLAUDE_CURSOR_SHUTDOWN_FINAL_DRAIN_MS = '150'
    let escapedPid: number | undefined
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'turn that escapes its process group',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      for (let i = 0; i < 200 && escapedPid === undefined; i += 1) {
        try {
          escapedPid = Number.parseInt(await readFile(escapedPidFile, 'utf8'), 10)
        } catch {
          await new Promise((ready) => setTimeout(ready, 25))
        }
      }
      assert.ok(escapedPid, 'the fake wrapper never spawned its escaped descendant')

      adapter.interrupt()
      const started = Date.now()
      await adapter.shutdown()
      await adapter.waitForOutputDrain()
      const elapsed = Date.now() - started
      assert.ok(elapsed < 10_000, `shutdown must be bounded, took ${elapsed}ms`)
      // The escalation is what makes the wait bounded rather than lucky: the
      // wrapper itself must be gone even though its descendant is not.
      assert.equal(adapter.isRunning, false)
      assert.equal(process.kill(escapedPid, 0), true)
    } finally {
      if (escapedPid) {
        try { process.kill(escapedPid, 'SIGKILL') } catch { /* already reaped */ }
      }
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS', oldGrace)
      restoreEnv('OPENCLAUDE_CURSOR_SHUTDOWN_FINAL_DRAIN_MS', oldFinal)
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Giving up on a process hands it to the OS but keeps the adapter alive for
  // the next turn. The abandoned turn's 'close' can then fire hours later,
  // when the barrier it would resolve and the `active` context it would clear
  // belong to a live turn — freezing that turn's transcript mid-stream.
  test('a late close from an abandoned turn cannot settle the next one', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-late-close-'))
    const escaping = path.join(dir, 'escaping.cjs')
    const surviving = path.join(dir, 'surviving.cjs')
    const escapedPidFile = path.join(dir, 'escaped.pid')
    await writeFile(path.join(dir, 'persona.md'), 'PERSONA')
    await writeFile(
      escaping,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
escaped.unref();
fs.writeFileSync(${JSON.stringify(escapedPidFile)}, String(escaped.pid));
setInterval(() => {}, 1000);
`,
    )
    await writeFile(
      surviving,
      `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'assistant', text: 'the live turn' }));
setInterval(() => {}, 1000);
`,
    )
    await chmod(escaping, 0o755)
    await chmod(surviving, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldGrace = process.env.OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS
    const oldFinal = process.env.OPENCLAUDE_CURSOR_SHUTDOWN_FINAL_DRAIN_MS
    process.env.OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS = '150'
    process.env.OPENCLAUDE_CURSOR_SHUTDOWN_FINAL_DRAIN_MS = '150'
    const adapter = new CursorAdapter(opts(dir))
    adapter.on('error', () => {})
    let escapedPid: number | undefined
    try {
      process.env.OC_CURSOR_WRAPPER_BIN = escaping
      const abandoned = adapter.submitTurn({
        input: 'turn whose descendant never lets go of stdout',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await abandoned.submitted
      for (let i = 0; i < 200 && escapedPid === undefined; i += 1) {
        try {
          escapedPid = Number.parseInt(await readFile(escapedPidFile, 'utf8'), 10)
        } catch {
          await new Promise((ready) => setTimeout(ready, 25))
        }
      }
      assert.ok(escapedPid, 'the fake wrapper never spawned its escaped descendant')
      adapter.interrupt()
      await adapter.shutdown()

      process.env.OC_CURSOR_WRAPPER_BIN = surviving
      const live = adapter.submitTurn({
        input: 'the turn that must not be settled by its predecessor',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await live.submitted

      // Whatever the abandoned wrapper was still holding is released now.
      process.kill(escapedPid, 'SIGKILL')
      escapedPid = undefined

      const stillOpen = Symbol('still-open')
      const settled: unknown = await Promise.race([
        adapter.waitForOutputDrain().then(() => 'drained'),
        new Promise((late) => setTimeout(() => late(stillOpen), 500)),
      ])
      assert.equal(settled, stillOpen, 'the abandoned turn resolved the live turn\'s close barrier')
      assert.equal(adapter.isRunning, true)
      assert.equal(live.finalized, false)
      live.end()
    } finally {
      if (escapedPid) {
        try { process.kill(escapedPid, 'SIGKILL') } catch { /* already reaped */ }
      }
      await adapter.shutdown().catch(() => {})
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS', oldGrace)
      restoreEnv('OPENCLAUDE_CURSOR_SHUTDOWN_FINAL_DRAIN_MS', oldFinal)
      await rm(dir, { recursive: true, force: true })
    }
  })

  // submitTurn() awaits the platform prompt before it spawns anything, so Stop
  // can arrive while the turn has no child at all. The close barrier only ever
  // resolves through a child, so waiting on it here would hang Stop; giving up
  // without arming the spawn would strand a CLI holding CURSOR_API_KEY. Which
  // of the two sides wins is a real race and this test does not fix it — both
  // outcomes owe the same invariant, so both are asserted.
  test('Stop racing a turn that has not spawned yet stays bounded and leaves no child', { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-cursor-prespawn-'))
    const fake = path.join(dir, 'fake.cjs')
    const pidFile = path.join(dir, 'wrapper.pid')
    await writeFile(path.join(dir, 'persona.md'), 'PERSONA')
    await writeFile(
      fake,
      `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    )
    await chmod(fake, 0o755)
    const oldBin = process.env.OC_CURSOR_WRAPPER_BIN
    const oldGrace = process.env.OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS
    process.env.OC_CURSOR_WRAPPER_BIN = fake
    process.env.OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS = '0'
    try {
      const adapter = new CursorAdapter(opts(dir))
      adapter.on('error', () => {})
      const run = adapter.submitTurn({
        input: 'stopped before it ever spawned',
        requestId: REQUEST,
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      run.submitted.catch(() => {})
      // No await on `submitted`: that is the whole point — the turn is still
      // suspended inside buildPromptContext() and ctx.proc is still null.
      const started = Date.now()
      await adapter.shutdown()
      const elapsed = Date.now() - started
      assert.ok(elapsed < 10_000, `shutdown must be bounded, took ${elapsed}ms`)
      await run.submitted.catch(() => {})
      assert.equal(adapter.isRunning, false)

      // Whichever side won the race, the wrapper must not survive the turn.
      let wrapperPid: number | undefined
      try {
        wrapperPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
      } catch {
        wrapperPid = undefined
      }
      if (wrapperPid) {
        let alive = true
        for (let i = 0; i < 100 && alive; i += 1) {
          try {
            process.kill(wrapperPid, 0)
            await new Promise((wait) => setTimeout(wait, 25))
          } catch {
            alive = false
          }
        }
        if (alive) {
          try { process.kill(wrapperPid, 'SIGKILL') } catch { /* already reaped */ }
        }
        assert.equal(alive, false, 'the wrapper spawned after Stop was left running')
      }
    } finally {
      restoreEnv('OC_CURSOR_WRAPPER_BIN', oldBin)
      restoreEnv('OPENCLAUDE_CURSOR_SHUTDOWN_GRACE_MS', oldGrace)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
