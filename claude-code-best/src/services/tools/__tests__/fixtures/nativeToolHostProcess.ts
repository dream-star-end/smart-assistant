// Synthetic integration fixture. This process receives only its parent's
// private IPC channel; it is not an authenticated product transport.
import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  NativeToolHostLaunch,
  NativeToolHostRuntime,
} from '../../createNativeToolHostBootstrap.js'
Object.assign(globalThis, {
  MACRO: {
    VERSION: 'fixture',
    BUILD_TIME: '',
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '',
    VERSION_CHANGELOG: '',
  },
})
process.chdir(process.argv[3]!)
const { createNativeToolHostBootstrap } = await import('../../createNativeToolHostBootstrap.js')
const { hasPermissionsToUseTool } = await import('../../../../utils/permissions/permissions.js')
const { createAssistantMessage } = await import('../../../../utils/messages.js')
const cwd = process.cwd()
const journal = join(cwd, 'synthetic-journal.jsonl')
const record = (value: unknown) => appendFile(journal, `${JSON.stringify(value)}\n`)
let ownedClosed = false
let hookReady = false
let policyEntries = 0
let listenersRemoved = false
let stopSweeps = 0
const nativeSessionId = process.argv[2]!
const launch: NativeToolHostLaunch = {
  cwd,
  nativeSessionId,
  mainLoopModel: 'fixture-no-model',
  permission: {
    allowedToolsCli: [
      'Read',
      'Edit',
      'Bash(pwd)',
      'Bash(cat target.txt)',
      'Bash(printf native-host-smoke)',
    ],
    disallowedToolsCli: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    addDirs: [],
  },
}
const runtime: NativeToolHostRuntime = {
  initialMessages: [],
  commandAuth: {
    role: 'native-tool-host-fixture',
    revision: 'fixture-v1',
    includeAnthropicAccountCommands: true,
    hasAnthropicApiKeyAuth: false,
  },
  commandEnabled: (command) => command.name !== 'native-denied-dynamic', // Synthetic trusted profile; not a product default.
  prepareExecutionPolicy: async () => {
    hookReady = true
    policyEntries++
  },
  runStartupHooks: async () => {
    if (!hookReady) throw new Error('policy-not-ready')
  },
  sandboxAsk: async () => false,
  diagnostic: () => {},
  canUseTool: async (...args) => {
    const result = await hasPermissionsToUseTool(...args)
    if (result.behavior === 'ask') throw new Error('fixture-unapproved-permission')
    return result
  },
  handleElicitation: undefined,
  onStateChange: () => {},
  onViewChange: () => {},
  ownsTool: () => true,
  authorizeBatch: async (blocks) => {
    await record({ phase: 'admit', ids: blocks.map((b) => b.id) })
  },
  beforeExecution: async (request) => {
    await record({ phase: 'dispatch', id: request.toolUseId })
  },
  beforeToolCall: async (request) => {
    await record({ phase: 'call', id: request.toolUseId })
  },
  recordUpdate: async (update) => {
    if (update.message) await record({ phase: 'update', message: update.message })
  },
  recordFailure: async (error) => {
    await record({ phase: 'failure', error: String(error) })
  },
  installBackgroundListeners: () => () => {
    listenersRemoved = true
  },
  stopTasks: async () => {
    stopSweeps++
  },
  drainBackground: async () => {},
  closeResources: async () => {
    ownedClosed = true
  },
}
const first = createNativeToolHostBootstrap(launch, runtime)
const duplicate = createNativeToolHostBootstrap(
  { ...launch, nativeSessionId: randomUUID() },
  runtime,
)
const [host, duplicateResult] = await Promise.all([
  first,
  duplicate.then(
    () => ({ accepted: true, error: '' }),
    (error) => ({ accepted: false, error: String(error) }),
  ),
])
const commandModule = await import('../../../../commands.js')
const skillModule = await import('../../../../skills/loadSkillsDir.js')
// Warm the actual Skill helper, then use its real discovery signal invalidator.
await commandModule.getSkillToolCommands(cwd)
const unsubscribeSkills = skillModule.onDynamicSkillsLoaded(
  commandModule.clearCommandMemoizationCaches,
)
try {
  await skillModule.addSkillDirectories([join(cwd, 'nested', '.claude', 'skills')])
} finally {
  unsubscribeSkills()
}
for (const command of skillModule.getDynamicSkills()) {
  if (!['native-allowed-dynamic', 'native-denied-dynamic'].includes(command.name)) continue
  command.availability = ['claude-ai']
  command.isEnabled = () => {
    throw new Error('host-local-auth-predicate-used')
  }
}
const repeatedCommands = await commandModule.getCommands(cwd)
const repeatedSkills = await commandModule.getSkillToolCommands(cwd)
const { default: loginCommand } = await import('../../../../commands/login/index.js')
const profileProbe = {
  commands: repeatedCommands.map((c) => c.name),
  skills: repeatedSkills.map((c) => c.name),
  builtinLogin: commandModule.builtInCommandNames().has('login'),
  loginDescriptions: [loginCommand(true).description, loginCommand(false).description],
}
process.send!({
  type: 'ready',
  pid: process.pid,
  tools: host.tools.map((t) => t.name),
  commandCount: host.commands.length,
  profileProbe,
  mcpServerCount: host.mcpServerCount,
  disabledPlugins: host.plugins.disabled.map((p) => p.name),
  policyEntries,
  duplicateResult,
})
let busy = false
process.on('message', async (value: unknown) => {
  const input = value as { type: string; id: string; name: string; input: Record<string, unknown> }
  if (busy) {
    process.send!({ type: 'failed', error: 'fixture-busy' })
    return
  }
  busy = true
  try {
    if (input.type === 'close') {
      await host.dispose()
      process.send!({
        type: 'closed',
        ownedClosed,
        listenersRemoved,
        stopSweeps,
        file: await readFile(join(cwd, 'target.txt'), 'utf8'),
      })
      process.disconnect!()
      return
    }
    const block = {
      type: 'tool_use' as const,
      id: input.id,
      name: input.name,
      caller: { type: 'direct' as const },
      input: input.input,
    }
    const assistant = createAssistantMessage({ content: [block] })
    const run = host.session.executeBatch([block], [assistant], [assistant])
    const messages = []
    for await (const message of run.stream) messages.push(message)
    await run.done
    process.send!({
      type: 'result',
      id: input.id,
      messages,
      cached: host.session.getContext().readFileState.has(join(cwd, 'target.txt')),
    })
  } catch (error) {
    process.send!({ type: 'failed', error: String(error) })
  } finally {
    busy = false
  }
})
