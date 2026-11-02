import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('independent ToolHost bootstraps the full native pool and runs real Read/Edit/Bash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-tool-host-'))
  const hostCwd = join(root, 'host')
  const controlDir = join(root, 'driver')
  const home = join(root, 'home')
  const config = join(home, '.claude')
  await Promise.all([hostCwd, controlDir, config].map((p) => mkdir(p, { recursive: true })))
  await writeFile(join(hostCwd, 'target.txt'), 'HOST_OLD\n')
  await writeFile(join(controlDir, 'target.txt'), 'CONTROL_UNTOUCHED\n')
  // Real FileChanged watcher must be closed before the child can exit. This
  // fixture has no Setup/SessionStart/model hooks, MCP servers or LSP configs.
  await writeFile(
    join(config, 'settings.json'),
    JSON.stringify({
      sandbox: { enabled: false },
      enabledPlugins: { 'weixin@builtin': false },
      hooks: {
        FileChanged: [
          {
            matcher: 'target.txt',
            hooks: [{ type: 'command', command: 'printf native-host-file-change', timeout: 5 }],
          },
        ],
      },
    }),
  )
  const skillRoot = join(hostCwd, 'nested', '.claude', 'skills')
  for (const name of ['native-allowed-dynamic', 'native-denied-dynamic']) {
    const dir = join(skillRoot, name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Synthetic native Host profile probe\n---\nSynthetic skill body.\n`,
    )
  }
  const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/nativeToolHostProcess.ts', import.meta.url)),
      randomUUID(),
      hostCwd,
    ],
    {
      // Initialize Bun's TS loader in its actual source tree; the fixture moves
      // to the execution cwd before importing any business modules.
      cwd: sourceRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        OPENCLAUDE_HOME: join(home, 'openclaude'),
        TMPDIR: root,
        NODE_ENV: 'test',
      },
    },
  )
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (b) => {
      if (output.length < 512 * 1024) output += b.toString()
    })
  const exit = once(child, 'close')
  const inbox: any[] = []
  let receiver: ((message: any) => void) | undefined
  child.on('message', (message) => {
    if (receiver) {
      const deliver = receiver
      receiver = undefined
      deliver(message)
    } else inbox.push(message)
  })
  async function next(type: string, timeout = 20000) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let message: any
    try {
      message = inbox.length
        ? inbox.shift()
        : await Promise.race([
            new Promise<any>((resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`host-message-timeout: ${output}`)),
                timeout,
              )
              receiver = (value) => resolve(value)
            }),
            exit.then(([code, signal]) => {
              throw new Error(`host-exited: ${code}/${signal}\n${output}`)
            }),
          ])
    } finally {
      clearTimeout(timer)
      receiver = undefined
    }
    if (message?.type !== type)
      throw new Error(`host-unexpected-message: ${JSON.stringify(message)}\n${output}`)
    return message
  }
  async function execute(id: string, name: string, input: Record<string, unknown>) {
    child.send({ type: 'execute', id, name, input })
    const result = await next('result')
    expect(result.id).toBe(id)
    return result
  }
  try {
    const ready = await next('ready', 90000)
    expect(ready.pid).not.toBe(process.pid)
    expect(ready.policyEntries).toBe(1)
    expect(ready.duplicateResult.accepted).toBe(false)
    expect(ready.duplicateResult.error).toContain('native-host-process-already-claimed')
    for (const name of ['Read', 'Edit', 'Bash', 'Glob', 'Grep']) expect(ready.tools).toContain(name)
    expect(ready.tools.length).toBeGreaterThan(5)
    expect(ready.commandCount).toBeGreaterThan(10)
    expect(ready.mcpServerCount).toBe(0)
    expect(ready.disabledPlugins).toContain('weixin')
    expect(ready.profileProbe.builtinLogin).toBe(true)
    expect(ready.profileProbe.loginDescriptions).toEqual([
      'Switch Anthropic accounts',
      'Sign in with your Anthropic account',
    ])
    for (const names of [ready.profileProbe.commands, ready.profileProbe.skills]) {
      expect(names).toContain('native-allowed-dynamic')
      expect(names).not.toContain('native-denied-dynamic')
    }
    expect(ready.profileProbe.commands.indexOf('native-allowed-dynamic')).toBeLessThan(
      ready.profileProbe.commands.indexOf('help'),
    )
    const read = await execute('toolu_real_read', 'Read', {
      file_path: join(hostCwd, 'target.txt'),
    })
    expect(JSON.stringify(read.messages)).toContain('HOST_OLD')
    expect(read.cached).toBe(true)
    const edit = await execute('toolu_real_edit', 'Edit', {
      file_path: join(hostCwd, 'target.txt'),
      old_string: 'HOST_OLD',
      new_string: 'HOST_NEW',
    })
    expect(JSON.stringify(edit.messages)).not.toContain('"is_error":true')
    expect(await readFile(join(hostCwd, 'target.txt'), 'utf8')).toBe('HOST_NEW\n')
    const pwd = await execute('toolu_real_pwd', 'Bash', { command: 'pwd' })
    expect(JSON.stringify(pwd.messages)).toContain(hostCwd)
    const cat = await execute('toolu_real_cat', 'Bash', { command: 'cat target.txt' })
    expect(JSON.stringify(cat.messages)).toContain('HOST_NEW')
    const printf = await execute('toolu_real_printf', 'Bash', {
      command: 'printf native-host-smoke',
    })
    expect(JSON.stringify(printf.messages)).toContain('native-host-smoke')
    const denied = await execute('toolu_real_denied', 'Bash', { command: 'touch never-created' })
    expect(JSON.stringify(denied.messages)).toContain('fixture-unapproved-permission')
    expect(
      await readFile(join(hostCwd, 'never-created')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    child.send({ type: 'close' })
    const closed = await next('closed')
    expect(closed.ownedClosed).toBe(true)
    expect(closed.listenersRemoved).toBe(true)
    expect(closed.stopSweeps).toBe(2)
    expect(closed.file).toBe('HOST_NEW\n')
    const [code, signal] = await Promise.race([
      exit,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`host-exit-timeout: ${output}`)), 10000),
      ),
    ])
    expect(code).toBe(0)
    expect(signal).toBeNull()
    expect(await readFile(join(controlDir, 'target.txt'), 'utf8')).toBe('CONTROL_UNTOUCHED\n')
    const records = (await readFile(join(hostCwd, 'synthetic-journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records.filter((r) => r.phase === 'call').map((r) => r.id)).toEqual([
      'toolu_real_read',
      'toolu_real_edit',
      'toolu_real_pwd',
      'toolu_real_cat',
      'toolu_real_printf',
    ])
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGKILL')
      await exit
    }
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
