/** Internal, trusted execution-process composition. One native UUID per process.
 * Set HOME/config/cwd before importing this module. This is not a wire decoder
 * or a product entry point. Models, authenticated relay and OS drain are not
 * implemented here; the supervisor must supply the actual runtime callbacks.
 */
import { isAbsolute, resolve } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import type { Command, CommandAuthPresentation } from '../../commands.js'
import type { initializeToolPermissionContext } from '../../utils/permissions/permissionSetup.js'
import type { SandboxAskCallback } from '../../utils/sandbox/sandbox-adapter.js'
import type { NativeToolSessionOptions } from './createNativeToolSession.js'

export interface NativeToolHostLaunch {
  cwd: string
  nativeSessionId: string
  mainLoopModel: string
  permission: Parameters<typeof initializeToolPermissionContext>[0]
}
export interface NativeToolHostRuntime
  extends Omit<
    NativeToolSessionOptions,
    'initialAppState' | 'options' | 'readFileState' | 'closeResources'
  > {
  /** Complete availability AND isEnabled decision from the trusted model/policy
   * owner. Unknown commands return false. Never fall back to local auth. */
  commandEnabled(command: Command): boolean
  commandAuth: CommandAuthPresentation
  /** Install the trusted managed-policy/hook-model callback state before any
   * permission, plugin hooks, watcher or startup-hook execution. */
  prepareExecutionPolicy(): Promise<void>
  /** Durable occurrence-owned Setup/SessionStart; not rerun on reconnect. */
  runStartupHooks(getContext: () => ToolUseContext): Promise<void>
  sandboxAsk: SandboxAskCallback
  diagnostic(message: string): void
  closeResources(): Promise<void>
}
let claimed = false

export async function createNativeToolHostBootstrap(
  launch: NativeToolHostLaunch,
  runtime: NativeToolHostRuntime,
) {
  if (claimed) throw new Error('native-host-process-already-claimed')
  launch = {
    ...launch,
    permission: {
      ...launch.permission,
      allowedToolsCli: [...launch.permission.allowedToolsCli],
      disallowedToolsCli: [...launch.permission.disallowedToolsCli],
      addDirs: [...launch.permission.addDirs],
      ...(launch.permission.baseToolsCli
        ? { baseToolsCli: [...launch.permission.baseToolsCli] }
        : {}),
    },
  }
  // Existing setup's root/TTY/network bypass safety flow must be extracted
  // before this internal factory may accept those modes. No product caller yet.
  if (
    launch.permission.permissionMode === 'bypassPermissions' ||
    launch.permission.allowDangerouslySkipPermissions
  )
    throw new Error('native-host-bypass-startup-guard-not-integrated')
  if (
    !isAbsolute(launch.cwd) ||
    resolve(launch.cwd) !== resolve(process.cwd()) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      launch.nativeSessionId,
    ) ||
    !launch.mainLoopModel ||
    !process.env.HOME ||
    !isAbsolute(process.env.HOME) ||
    !process.env.CLAUDE_CONFIG_DIR ||
    !isAbsolute(process.env.CLAUDE_CONFIG_DIR)
  )
    throw new Error('native-host-launch-invalid')
  const required = [
    'commandEnabled',
    'prepareExecutionPolicy',
    'runStartupHooks',
    'sandboxAsk',
    'diagnostic',
    'closeResources',
    'canUseTool',
    'onStateChange',
    'onViewChange',
    'ownsTool',
    'authorizeBatch',
    'beforeExecution',
    'beforeToolCall',
    'recordUpdate',
    'recordFailure',
    'installBackgroundListeners',
    'stopTasks',
    'drainBackground',
  ] as const
  for (const key of required)
    if (typeof runtime[key] !== 'function') throw new Error('native-host-runtime-required')
  // All imports above are type-only except node:path. Business imports happen
  // only after the caller fixed private HOME/config/cwd for this process.
  // Reserve synchronously before any await; global native state cannot race.
  claimed = true
  const env = await import('../../utils/envUtils.js')
  if (
    env.isBareMode() ||
    env.isOpenClaudeAdvisorHermetic() ||
    env.isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)
  )
    throw new Error('native-host-reduced-or-installing-profile')
  const closers: Array<() => Promise<void>> = []
  let closePromise: Promise<void> | undefined
  const closeOwned = () =>
    (closePromise ??= (async () => {
      const failures: unknown[] = []
      for (const close of [...closers].reverse())
        try {
          await close()
        } catch (error) {
          failures.push(error)
        }
      if (failures.length) throw new AggregateError(failures, 'native-host-cleanup-unknown')
    })())
  try {
    const state = await import('../../bootstrap/state.js')
    state.setOriginalCwd(launch.cwd)
    state.setProjectRoot(launch.cwd)
    state.setCwdState(launch.cwd)
    state.switchSession(launch.nativeSessionId as Parameters<typeof state.switchSession>[0])
    const { runCleanupFunctions } = await import('../../utils/cleanupRegistry.js')
    // Last in reverse cleanup: covers acquisitions whose discovery failed
    // before their connected client could be exposed to our callback.
    closers.push(runCleanupFunctions)
    closers.push(runtime.closeResources.bind(runtime))
    const { enableConfigs } = await import('../../utils/config.js')
    enableConfigs()
    await runtime.prepareExecutionPolicy()
    const { installNativeHostCommandProfile, getCommands } = await import('../../commands.js')
    const commandEnabled = runtime.commandEnabled.bind(runtime)
    installNativeHostCommandProfile({ enabled: commandEnabled, auth: runtime.commandAuth })
    const { initBuiltinPlugins } = await import('../../plugins/bundled/index.js')
    const { initBundledSkills } = await import('../../skills/bundled/index.js')
    initBuiltinPlugins()
    initBundledSkills()
    const { loadAllPluginsCacheOnly } = await import('../../utils/plugins/pluginLoader.js')
    const plugins = await loadAllPluginsCacheOnly()
    const { loadPluginHooks } = await import('../../utils/plugins/loadPluginHooks.js')
    await loadPluginHooks()
    const { captureHooksConfigSnapshot } = await import('../../utils/hooks/hooksConfigSnapshot.js')
    captureHooksConfigSnapshot()
    const { initializeToolPermissionContext } = await import(
      '../../utils/permissions/permissionSetup.js'
    )
    const permission = await initializeToolPermissionContext(launch.permission)
    for (const warning of permission.warnings) runtime.diagnostic(warning)
    const { getDefaultAppState } = await import('../../state/AppStateStore.js')
    const appState = getDefaultAppState()
    appState.toolPermissionContext = permission.toolPermissionContext
    appState.mainLoopModel = launch.mainLoopModel
    appState.plugins = {
      ...appState.plugins,
      enabled: plugins.enabled,
      disabled: plugins.disabled,
      errors: plugins.errors,
    }
    const { SandboxManager } = await import('../../utils/sandbox/sandbox-adapter.js')
    closers.push(() => SandboxManager.reset())
    const unavailable = SandboxManager.getSandboxUnavailableReason()
    if (unavailable) {
      if (SandboxManager.isSandboxRequired())
        throw new Error('native-host-required-sandbox-unavailable')
      runtime.diagnostic(`Sandbox unavailable: ${unavailable}`)
    } else if (SandboxManager.isSandboxingEnabled()) {
      await SandboxManager.initialize(runtime.sandboxAsk)
    }
    const { getClaudeCodeMcpConfigs } = await import('../mcp/config.js')
    const { getMcpToolsCommandsAndResources } = await import('../mcp/client.js')
    const mcp = await getClaudeCodeMcpConfigs()
    appState.plugins.errors.push(...mcp.errors)
    await getMcpToolsCommandsAndResources(({ client, tools, commands, resources }) => {
      appState.mcp.clients = appState.mcp.clients
        .filter((c) => c.name !== client.name)
        .concat(client)
      appState.mcp.tools.push(...tools)
      appState.mcp.commands.push(...commands)
      if (resources) appState.mcp.resources[client.name] = resources
      if (client.type === 'connected') closers.push(client.cleanup)
    }, mcp.servers)
    const { getAgentDefinitionsWithOverrides } = await import(
      '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
    )
    appState.agentDefinitions = await getAgentDefinitionsWithOverrides(launch.cwd)
    const commands = [
      ...(await getCommands(launch.cwd)),
      ...appState.mcp.commands.filter((command) => commandEnabled(command) === true),
    ]
    const lsp = await import('../lsp/manager.js')
    closers.push(lsp.shutdownLspServerManager)
    lsp.initializeLspServerManager()
    await lsp.waitForInitialization()
    if (lsp.getInitializationStatus().status === 'failed')
      runtime.diagnostic('LSP initialization failed')
    const { assembleToolPool } = await import('../../tools.js')
    const tools = assembleToolPool(appState.toolPermissionContext, appState.mcp.tools)
    const { createNativeToolSession } = await import('./createNativeToolSession.js')
    const session = createNativeToolSession({
      ...runtime,
      initialAppState: appState,
      options: {
        commands,
        debug: false,
        mainLoopModel: launch.mainLoopModel,
        tools,
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: appState.mcp.clients,
        mcpResources: appState.mcp.resources,
        isNonInteractiveSession: true,
        agentDefinitions: appState.agentDefinitions,
      },
      closeResources: closeOwned,
    })
    // If any following startup step fails, stop foreground/background work
    // before releasing resources. No retry may report cleanup success after an
    // unobservable resource close failed (closeOwned retains its rejection).
    try {
      await runtime.runStartupHooks(session.getContext)
      const watcher = await import('../../utils/hooks/fileChangedWatcher.js')
      closers.push(watcher.disposeFileChangedWatcher)
      watcher.initializeFileChangedWatcher(launch.cwd)
    } catch (error) {
      try {
        await session.dispose()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'native-host-startup-and-cleanup-failed')
      }
      throw error
    }
    return {
      session,
      tools,
      commands,
      permission,
      plugins,
      mcpServerCount: Object.keys(mcp.servers).length,
      dispose: () => session.dispose(),
    }
  } catch (error) {
    try {
      await closeOwned()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'native-host-bootstrap-and-cleanup-failed')
    }
    throw error
  }
}
