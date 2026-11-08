import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Cc5ToolHost } from '../cc5ToolHost.js'

const NATIVE_SESSION = 'd71e4679-e7df-482a-a129-a998a8f51f7e'
const identity = (toolUseId: string) => ({
  nativeSessionId: NATIVE_SESSION,
  turnKey: 'turn-one',
  toolUseId,
})
const text = (result: { content: unknown }) => JSON.stringify(result.content)
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
/** A tool call that never settles would otherwise burn the whole test budget. */
const within = async <T,>(work: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test(
  'the real tool host serves the full local pool and executes real tools',
  { timeout: 300000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc5-full-host-'))
    const cwd = join(root, 'cwd')
    const home = join(root, 'home')
    mkdirSync(cwd)
    mkdirSync(home)
    const fixture = fileURLToPath(new URL('./fixtures/cc5EchoMcpServer.mjs', import.meta.url))
    const mcpConfigPath = join(root, 'mcp.json')
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [fixture] } },
      }),
      { mode: 0o600 },
    )
    // A user skill whose body only reaches the model through the Skill tool's follow-up message.
    const skillDir = join(home, '.claude', 'skills', 'cc5-sentinel')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'),
      '---\nname: cc5-sentinel\ndescription: Test skill for the remote tool host.\n---\nSay CC5_SKILL_BODY_SENTINEL_746 and stop.\n')
    const lifecycleId = randomUUID()
    const previousHome = process.env.HOME
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
    const host = new Cc5ToolHost(root, lifecycleId, {
      cwd,
      mcpConfigPath,
      settingsPath: null,
      disallowedTools: [],
    })
    try {
      const profilePath = join(root, 'host-profile.json')
      assert.equal(statSync(profilePath).mode & 0o777, 0o600)
      assert.deepEqual(JSON.parse(readFileSync(profilePath, 'utf8')), {
        version: 1,
        cwd,
        mcpConfigPath,
        settingsPath: null,
        disallowedTools: [],
      })

      const tools = await host.tools()
      const names = tools.map((tool) => tool.name)
      assert.ok(tools.length >= 1 && tools.length <= 128)
      assert.equal(new Set(names).size, names.length)
      for (const tool of tools) {
        assert.match(tool.name, /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/)
        assert.equal(typeof tool.description, 'string')
        assert.equal((tool.inputSchema as { type?: unknown }).type, 'object')
      }
      for (const name of ['Write', 'Grep', 'Bash', 'ExecuteExtraTool']) {
        assert.ok(names.includes(name), `missing ${name}; got ${names.join(',')}`)
      }
      // AskUserQuestion is a core tool answered by the gateway's permission card
      // (Cc5ToolHost.onPermission), so it must stay in the pool.
      assert.ok(names.includes('AskUserQuestion'), `missing AskUserQuestion; got ${names.join(',')}`)
      // Interactive-UI, messaging and scheduler tools stay out of a tool-only host.
      for (const name of [
        'Agent',
        'EnterPlanMode',
        'ExitPlanMode',
        'SendMessage',
        'CronCreate',
        'CronDelete',
        'CronList',
        'RemoteTrigger',
      ]) {
        assert.ok(!names.includes(name), `${name} must not be listed`)
      }
      // The MCP tool is deferred: discoverable, not directly listed.
      assert.ok(!names.includes('mcp__fixture__echo'))

      const probe = join(cwd, 'probe.txt')
      const write = await host.execute(
        'Write',
        { file_path: probe, content: 'cc5 hello\n' },
        identity('write-1'),
      )
      assert.equal(write.isError, false, text(write))
      assert.equal(readFileSync(probe, 'utf8'), 'cc5 hello\n')

      const grep = await host.execute(
        'Grep',
        { pattern: 'cc5 hello', path: cwd, output_mode: 'content' },
        identity('grep-1'),
      )
      assert.equal(grep.isError, false, text(grep))
      assert.match(text(grep), /probe\.txt/)

      // The reason lives in a follow-up message; without it the model sees only {"result":null}.
      const early = await host.execute(
        'ExecuteExtraTool',
        { tool_name: 'mcp__fixture__echo', params: { text: 'too early' } },
        identity('extra-early'),
      )
      assert.match(text(early), /has not been discovered yet/)

      const skill = await host.execute('Skill', { skill: 'cc5-sentinel' }, identity('skill-1'))
      assert.equal(skill.isError, false, text(skill))
      assert.match(text(skill), /CC5_SKILL_BODY_SENTINEL_746/)

      const search = await host.execute(
        'SearchExtraTools',
        { query: 'select:mcp__fixture__echo' },
        identity('search-1'),
      )
      assert.equal(search.isError, false, text(search))
      assert.match(text(search), /mcp__fixture__echo/)

      const extra = await host.execute(
        'ExecuteExtraTool',
        { tool_name: 'mcp__fixture__echo', params: { text: 'ping' } },
        identity('extra-1'),
      )
      assert.equal(extra.isError, false, text(extra))
      assert.match(text(extra), /fixture-echo:ping/)
    } finally {
      await host.close().catch(() => {})
      process.env.HOME = previousHome
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
      rmSync(root, { recursive: true, force: true })
    }
  },
)

const QUESTION = 'Which colour?'
const ANSWER_LABEL = 'Blue'
/** One question, two options — the shape a question card sends today. */
const ASK_INPUT = {
  questions: [
    {
      question: QUESTION,
      header: 'Colour',
      options: [
        { label: 'Red', description: 'warm tone' },
        { label: ANSWER_LABEL, description: 'cool tone' },
      ],
    },
  ],
}

test(
  'the real tool host round-trips AskUserQuestion through the permission card',
  { timeout: 300000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cc5-ask-host-'))
    const cwd = join(root, 'cwd')
    const home = join(root, 'home')
    mkdirSync(cwd)
    mkdirSync(home)
    const previousHome = process.env.HOME
    process.env.HOME = home
    const requests: unknown[] = []
    let mode: 'allow' | 'deny' | 'reject' = 'allow'
    const host = new Cc5ToolHost(
      root,
      randomUUID(),
      { cwd, mcpConfigPath: null, settingsPath: null, disallowedTools: [] },
      async (request) => {
        requests.push(structuredClone(request))
        if (mode === 'reject') throw new Error('the user closed the question card')
        if (mode === 'deny') return { behavior: 'deny', message: 'no' }
        return {
          behavior: 'allow',
          updatedInput: { ...record(record(request).input), answers: { [QUESTION]: ANSWER_LABEL } },
        }
      },
    )
    try {
      const tools = await host.tools()
      const ask = tools.find((tool) => tool.name === 'AskUserQuestion')

      await t.test('tools() lists AskUserQuestion with its question-card input schema', () => {
        assert.ok(ask, 'AskUserQuestion must be listed')
        const schema = record(ask.inputSchema)
        assert.equal(schema.type, 'object')
        assert.ok(list(schema.required).includes('questions'), 'questions is required')
        const questions = record(record(schema.properties).questions)
        assert.equal(questions.type, 'array')
        assert.equal(questions.minItems, 1)
        assert.equal(questions.maxItems, 4)
        const question = record(questions.items)
        for (const key of ['question', 'header', 'options', 'multiSelect']) {
          assert.ok(list(question.required).includes(key), `question.${key} is required`)
        }
        const options = record(record(question.properties).options)
        assert.equal(options.type, 'array')
        assert.equal(options.minItems, 2)
        assert.equal(options.maxItems, 4)
        const option = record(options.items)
        for (const key of ['label', 'description']) {
          assert.ok(list(option.required).includes(key), `option.${key} is required`)
        }
      })

      await t.test('an allow answer reaches the tool result as the chosen label', async () => {
        mode = 'allow'
        const answered = await within(
          host.execute('AskUserQuestion', ASK_INPUT, identity('ask-allow-1')),
          60000,
          'allow call',
        )
        assert.equal(
          requests.length,
          1,
          `the permission request must reach onPermission; result was ${text(answered)}`,
        )
        // The card shows the input after the tool's own schema defaults, as a local chat's card does.
        const normalised = { questions: ASK_INPUT.questions.map((question) => ({ ...question, multiSelect: false })) }
        assert.deepEqual(requests, [{ tool_name: 'AskUserQuestion', input: normalised, tool_use_id: 'ask-allow-1' }])
        assert.equal(answered.isError, false, text(answered))
        assert.ok(answered.content.some((block) => block.type === 'text' && String(block.text).includes(`"${QUESTION}"="${ANSWER_LABEL}"`)), text(answered))
      })

      await t.test('a deny answer fails the tool without hanging', async () => {
        mode = 'deny'
        const before = requests.length
        const denied = await within(
          host.execute('AskUserQuestion', ASK_INPUT, identity('ask-deny-1')),
          60000,
          'deny call',
        )
        assert.equal(
          requests.length,
          before + 1,
          `the deny request must reach onPermission; result was ${text(denied)}`,
        )
        assert.equal(denied.isError, true, text(denied))
        assert.ok(text(denied).includes('no'), `the deny message must reach the tool result: ${text(denied)}`)
      })

      await t.test('a rejected permission callback fails the tool without hanging', async () => {
        mode = 'reject'
        const before = requests.length
        const started = Date.now()
        const rejected = await within(
          host.execute('AskUserQuestion', ASK_INPUT, identity('ask-reject-1')),
          20000,
          'reject call',
        )
        assert.equal(
          requests.length,
          before + 1,
          `the request must reach onPermission before it rejects; result was ${text(rejected)}`,
        )
        assert.equal(rejected.isError, true, text(rejected))
        assert.ok(Date.now() - started < 15000, 'rejection must not wait for the 10-minute permission timeout')
      })
    } finally {
      await host.close().catch(() => {})
      process.env.HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  },
)


test('R1 real supervisor late proof permits close retry but never another tool effect', { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cc5-late-stop-'))
  const cwd = join(root, 'cwd'), home = join(root, 'home')
  mkdirSync(cwd); mkdirSync(home)
  const lifecycleId = randomUUID()
  const host = new Cc5ToolHost(root, lifecycleId, {
    cwd, mcpConfigPath: null, settingsPath: null, disallowedTools: [],
  }, undefined, { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') })
  // Fault injection targets only this fixture's real supervisor, not a close() wrapper.
  const child = (host as unknown as { child: import('node:child_process').ChildProcess }).child
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    await host.tools()
    child.kill('SIGSTOP'); await pause(50)
    await assert.rejects(host.close(), /CC5_TOOLHOST_STOP_UNKNOWN/)
    child.kill('SIGCONT')
    for (let i = 0; i < 300 && child.exitCode === null; i++) await pause(20)
    assert.equal(child.exitCode, 0)
    const proof = JSON.parse(readFileSync(join(root, 'stopped.json'), 'utf8'))
    assert.equal(proof.lifecycleId, lifecycleId)
    assert.equal(proof.supervisorPid, child.pid)
    assert.equal(proof.localStopped, true)
    await host.close()
    await assert.rejects(host.execute('Write', { file_path: join(cwd, 'forbidden'), content: 'late' }, identity('late')), /CLOSED/)
    assert.deepEqual(await import('node:fs').then(fs => fs.readdirSync(cwd)), [])
  } finally {
    child.kill('SIGCONT')
    await host.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
