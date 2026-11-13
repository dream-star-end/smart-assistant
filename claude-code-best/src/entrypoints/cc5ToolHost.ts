/** Tool-only execution endpoint for the bound personal CC5 web session.
 * The gateway authenticates the session/turn and journals each attempt before
 * this private stdio process receives it. This endpoint never starts a model loop.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'

export const CC5_TOOL_PROFILE = 'full'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
/** Must stay equal to packages/gateway/src/cc5NativeTool.ts CC5_TOOL_RESULT_MAX_BYTES. */
const MAX_RESULT_BYTES = 131072
/** Must stay equal to packages/gateway/src/cc5NativeTool.ts CC5_TOOL_INPUT_MAX_BYTES. */
const MAX_INPUT_BYTES = 98304
const MAX_PROFILE_BYTES = 65536
const MAX_TOOLS = 128
/** Inside the gateway's 11-minute tools/call bound. */
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
/** Tools this host cannot serve: they need its own interactive UI, or (Agent) a model loop it never runs.
 * Permission prompts (AskUserQuestion) go to the client; delegation is mcp__openclaude-memory__delegate_task. */
const INTERACTIVE_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'EnterPlanMode',
  'ExitPlanMode',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
])

function requireHost(value: unknown): asserts value {
  if (!value) throw new Error('CC5_TOOL_HOST_REQUEST_REJECTED')
}
export interface Cc5HostProfile {
  version: 1
  cwd: string
  mcpConfigPath: string | null
  settingsPath: string | null
  disallowedTools: string[]
}
const PROFILE_KEYS = 'cwd,disallowedTools,mcpConfigPath,settingsPath,version'

function readAbsolutePath(value: unknown): string | null {
  requireHost(
    value === null ||
      (typeof value === 'string' && value.length > 0 && isAbsolute(value)),
  )
  return value
}
export function parseCc5HostProfile(value: unknown): Cc5HostProfile {
  requireHost(value && typeof value === 'object' && !Array.isArray(value))
  const profile = value as Record<string, unknown>
  requireHost(
    Object.keys(profile).sort().join(',') === PROFILE_KEYS &&
      profile.version === 1,
  )
  requireHost(typeof profile.cwd === 'string' && isAbsolute(profile.cwd))
  const disallowedTools = profile.disallowedTools
  requireHost(
    Array.isArray(disallowedTools) &&
      disallowedTools.length <= 256 &&
      disallowedTools.every(
        name =>
          typeof name === 'string' && name.length > 0 && name.length <= 512,
      ),
  )
  requireHost(Buffer.byteLength(JSON.stringify(profile)) <= MAX_PROFILE_BYTES)
  return {
    version: 1,
    cwd: profile.cwd as string,
    mcpConfigPath: readAbsolutePath(profile.mcpConfigPath),
    settingsPath: readAbsolutePath(profile.settingsPath),
    disallowedTools: disallowedTools as string[],
  }
}
export function readCc5HostProfile(path: string): Cc5HostProfile {
  requireHost(isAbsolute(path))
  let text: string
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const meta = fstatSync(fd)
    requireHost(
      meta.isFile() &&
        meta.uid === process.getuid?.() &&
        (meta.mode & 0o077) === 0 &&
        meta.size <= MAX_PROFILE_BYTES,
    )
    const buffer = Buffer.alloc(MAX_PROFILE_BYTES + 1)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    requireHost(read <= MAX_PROFILE_BYTES)
    text = buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('CC5_TOOL_HOST_REQUEST_REJECTED')
  }
  return parseCc5HostProfile(value)
}

/** A reserved profile must never fall through to the credential-bearing CLI.
 * Ordinary commands return false; malformed or expanded profile commands fail
 * before main/init (including their preAction hook) can be imported.
 */
export function isCc5ToolHostCommand(args: readonly string[]): boolean {
  if (
    !args.some(
      arg =>
        arg.startsWith('--tool-profile') || arg.startsWith('--tool-allowlist'),
    )
  )
    return false
  requireHost(
    args.length === 6 &&
      args[0] === 'mcp' &&
      args[1] === 'serve' &&
      args[2] === '--tool-profile' &&
      args[3] === CC5_TOOL_PROFILE &&
      args[4] === '--host-profile' &&
      isAbsolute(args[5]),
  )
  return true
}
interface HostCall {
  name: string
  arguments?: unknown
  _meta?: Record<string, unknown>
}
export interface Cc5HostInvocation {
  name: string
  input: Record<string, unknown>
  nativeSessionId: string
  toolUseId: string
  turnKey: string
  signal: AbortSignal
}
interface HostRuntime {
  execute(input: Cc5HostInvocation): Promise<CallToolResult>
  close(): Promise<void>
}

function readArguments(value: unknown): Record<string, unknown> {
  const input = structuredClone(value === undefined ? {} : value)
  requireHost(input && typeof input === 'object' && !Array.isArray(input))
  requireHost(Buffer.byteLength(JSON.stringify(input)) <= MAX_INPUT_BYTES)
  return input as Record<string, unknown>
}

/** One tool pipeline at a time; cancellation revokes new calls before draining.
 * A used ID stays burned after errors or cancellation. Only the gateway may
 * reconcile an unknown attempt; reconnecting cannot execute it again here.
 */
export function createCc5ToolDispatcher(
  runtime: HostRuntime,
  listed: ReadonlySet<string>,
) {
  const abort = new AbortController()
  const used = new Set<string>()
  let session: string | undefined
  let active: Promise<CallToolResult> | undefined
  let closing: Promise<void> | undefined
  return {
    call(raw: HostCall): Promise<CallToolResult> {
      requireHost(
        !abort.signal.aborted &&
          !active &&
          typeof raw.name === 'string' &&
          listed.has(raw.name),
      )
      const meta = structuredClone(raw._meta)
      requireHost(
        meta &&
          Object.keys(meta).sort().join(',') ===
            'claudecode/toolUseId,openclaude/nativeSessionId,openclaude/turnKey',
      )
      const nativeSessionId = meta['openclaude/nativeSessionId']
      const toolUseId = meta['claudecode/toolUseId']
      const turnKey = meta['openclaude/turnKey']
      requireHost(
        typeof nativeSessionId === 'string' &&
          UUID.test(nativeSessionId) &&
          (!session || session === nativeSessionId) &&
          typeof toolUseId === 'string' &&
          toolUseId.length > 0 &&
          Buffer.byteLength(toolUseId) <= 65536 &&
          typeof turnKey === 'string' &&
          turnKey.length > 0 &&
          turnKey.length <= 512 &&
          !used.has(toolUseId) &&
          used.size < 10000,
      )
      const name = raw.name
      const input = readArguments(raw.arguments)
      session ??= nativeSessionId
      used.add(toolUseId)
      const running = Promise.resolve().then(async () => {
        requireHost(!abort.signal.aborted)
        const result = await runtime.execute({
          name,
          input,
          nativeSessionId,
          toolUseId,
          turnKey,
          signal: abort.signal,
        })
        requireHost(
          Array.isArray(result.content) && typeof result.isError === 'boolean',
        )
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES)
          throw new Error('CC5_TOOL_HOST_RESULT_LIMIT')
        return result
      })
      active = running
      void running
        .finally(() => {
          if (active === running) active = undefined
        })
        .catch(() => {})
      return running
    },
    close(): Promise<void> {
      if (closing) return closing
      abort.abort()
      closing = (async () => {
        await active?.catch(() => {})
        await runtime.close()
      })()
      return closing
    },
  }
}

/** Called only by the explicit full-tool `mcp serve` profile. Its launcher must
 * set background disabling before loading the CLI (Bash caches it on import).
 */
export async function startCc5ToolHost(profilePath: string): Promise<void> {
  const profile = readCc5HostProfile(profilePath)
  requireHost(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1')
  const bootstrap = await import('../bootstrap/state.js')
  bootstrap.setIsInteractive(false)
  bootstrap.setOriginalCwd(profile.cwd)
  bootstrap.setProjectRoot(profile.cwd)
  const { setCwd } = await import('../utils/Shell.js')
  setCwd(profile.cwd)
  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()
  if (profile.settingsPath) {
    bootstrap.setFlagSettingsPath(profile.settingsPath)
    const { resetSettingsCache } = await import(
      '../utils/settings/settingsCache.js'
    )
    resetSettingsCache()
  }
  const { loadPluginHooks } = await import(
    '../utils/plugins/loadPluginHooks.js'
  )
  await loadPluginHooks()
  const { captureHooksConfigSnapshot } = await import(
    '../utils/hooks/hooksConfigSnapshot.js'
  )
  captureHooksConfigSnapshot()
  // MCP servers only read the explicit config path and the cwd/settings already in place above, so
  // their boot can overlap the permission context. The pool is assembled from the same two values
  // as before, in the same order.
  const mcpPrefetch = profile.mcpConfigPath
    ? connectCc5McpTools(profile.mcpConfigPath)
    : undefined
  mcpPrefetch?.catch(() => {})
  const { initializeToolPermissionContext } = await import(
    '../utils/permissions/permissionSetup.js'
  )
  const { toolPermissionContext } = await initializeToolPermissionContext({
    allowedToolsCli: [],
    disallowedToolsCli: profile.disallowedTools,
    baseToolsCli: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    addDirs: [],
  })
  // Prompts are answered by the client (canUseTool below); CCB's own headless auto-reject would deny them first.
  const permissionContext = toolPermissionContext
  const { getDefaultAppState } = await import('../state/AppStateStore.js')
  const { createStore } = await import('../state/store.js')
  const store = createStore({
    ...getDefaultAppState(),
    toolPermissionContext: permissionContext,
  })
  const { clients, tools: mcpTools } = mcpPrefetch
    ? await mcpPrefetch
    : { clients: [], tools: [] }
  const { assembleToolPool } = await import('../tools.js')
  const tools = assembleToolPool(
    store.getState().toolPermissionContext,
    mcpTools,
  ).filter(tool => !INTERACTIVE_TOOLS.has(tool.name))
  const { toolToAPISchema } = await import('../utils/api.js')
  const { isSearchExtraToolsEnabled } = await import(
    '../utils/searchExtraTools.js'
  )
  const { isDeferredTool } = await import(
    '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
  )
  const { SEARCH_EXTRA_TOOLS_TOOL_NAME } = await import(
    '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/constants.js'
  )
  const agents: [] = []
  const model = 'claude-sonnet-5'
  const getToolPermissionContext = async () =>
    store.getState().toolPermissionContext
  const toolSearch = await isSearchExtraToolsEnabled(
    model,
    tools,
    getToolPermissionContext,
    agents,
    'cc5-tool-host',
  )
  const listedTools = toolSearch
    ? tools.filter(
        tool =>
          !isDeferredTool(tool) || tool.name === SEARCH_EXTRA_TOOLS_TOOL_NAME,
      )
    : tools.filter(tool => tool.name !== SEARCH_EXTRA_TOOLS_TOOL_NAME)
  const listedSchemas = await Promise.all(
    listedTools.map(async tool => {
      const schema = (await toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents,
        model,
      })) as {
        name?: unknown
        description?: unknown
        input_schema?: unknown
      }
      requireHost(
        typeof schema.name === 'string' &&
          typeof schema.description === 'string' &&
          schema.input_schema &&
          typeof schema.input_schema === 'object' &&
          !Array.isArray(schema.input_schema),
      )
      return {
        name: schema.name,
        description: schema.description,
        inputSchema: schema.input_schema as Record<string, unknown>,
      }
    }),
  )
  requireHost(
    listedSchemas.length >= 1 &&
      listedSchemas.length <= MAX_TOOLS &&
      new Set(listedSchemas.map(schema => schema.name)).size ===
        listedSchemas.length &&
      listedSchemas.every(
        schema =>
          TOOL_NAME.test(schema.name) && schema.inputSchema.type === 'object',
      ),
  )
  const { createFileStateCacheWithSizeLimit } = await import(
    '../utils/fileStateCache.js'
  )
  const { hasPermissionsToUseTool } = await import(
    '../utils/permissions/permissions.js'
  )
  const { outputSchema: permissionOutputSchema, permissionPromptToolResultToPermissionDecision } =
    await import('../utils/permissions/PermissionPromptToolResultSchema.js')
  const { ResultSchema } = await import('@modelcontextprotocol/sdk/types.js')
  // Set once the MCP server exists: a prompt is a client request inside the pending tools/call.
  let askClient: ((params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | undefined
  type CanUseTool = typeof hasPermissionsToUseTool
  const canUseTool: CanUseTool = async (...args) => {
    const decision = await hasPermissionsToUseTool(...args)
    if (decision.behavior !== 'ask') return decision
    const [tool, input, toolUseContext, , toolUseID] = args
    let reply: unknown
    try {
      // The same can_use_tool payload a local CCB writes to stdout; the gateway answers it with its card.
      reply = await askClient?.({ tool_name: tool.name, input, tool_use_id: toolUseID },
        toolUseContext.abortController.signal)
    } catch {}
    const parsed = permissionOutputSchema().safeParse(reply)
    return permissionPromptToolResultToPermissionDecision(parsed.success ? parsed.data
      : { behavior: 'deny', message: 'The user did not answer this permission request.', toolUseID },
      tool, input, toolUseContext)
  }
  const { runTools } = await import('../services/tools/toolOrchestration.js')
  const { createAssistantMessage } = await import('../utils/messages.js')
  const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
  if (
    SandboxManager.getSandboxUnavailableReason() &&
    SandboxManager.isSandboxRequired()
  )
    throw new Error('CC5_TOOL_HOST_SANDBOX_REQUIRED')
  if (SandboxManager.isSandboxingEnabled())
    await SandboxManager.initialize(async () => false)
  const { runCleanupFunctions } = await import('../utils/cleanupRegistry.js')
  let inProgress = new Set<string>()
  let responseLength = 0
  let nativeSessionId: string | undefined
  let context: ToolUseContext = {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools,
      debug: false,
      verbose: false,
      mainLoopModel: 'claude-sonnet-5',
      thinkingConfig: { type: 'disabled' },
      mcpClients: clients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: store.getState,
    setAppState: store.setState,
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    requireCanUseTool: true,
    setInProgressToolUseIDs: update => {
      inProgress = update(inProgress)
    },
    setResponseLength: update => {
      responseLength = update(responseLength)
    },
    updateFileHistoryState: update =>
      store.setState(state => ({
        ...state,
        fileHistory: update(state.fileHistory),
      })),
    updateAttributionState: update =>
      store.setState(state => ({
        ...state,
        attribution: update(state.attribution),
      })),
  }
  const dispatcher = createCc5ToolDispatcher(
    {
      async execute(call) {
        if (!nativeSessionId) {
          nativeSessionId = call.nativeSessionId
          bootstrap.switchSession(
            nativeSessionId as Parameters<typeof bootstrap.switchSession>[0],
          )
        }
        const block: ToolUseBlock = {
          type: 'tool_use',
          id: call.toolUseId,
          name: call.name,
          input: call.input,
        }
        const assistant = createAssistantMessage({ content: [block] })
        let messages = [...context.messages.slice(-62), assistant]
        context = { ...context, messages }
        const onAbort = () =>
          context.abortController.abort('cc5-tool-host-closed')
        call.signal.addEventListener('abort', onAbort, { once: true })
        if (call.signal.aborted) onAbort()
        let result: CallToolResult | undefined
        // A tool's follow-up user messages (a skill's body, ExecuteExtraTool's "not discovered yet") are what a
        // local model reads next; here they travel inside this call's result, after the tool's own content.
        const followUp: string[] = []
        try {
          for await (const update of runTools(
            [block],
            [assistant],
            canUseTool,
            context,
          )) {
            context = { ...update.newContext, messages }
            if (!update.message) continue
            messages = [...messages, update.message]
            context = { ...context, messages }
            const message = update.message as Message & {
              message?: {
                content?: Array<{
                  type: string
                  tool_use_id?: string
                  content?: unknown
                  is_error?: boolean
                }>
              }
            }
            if (message.type === 'user' && typeof message.message?.content === 'string')
              followUp.push(message.message.content)
            for (const item of Array.isArray(message.message?.content)
              ? message.message.content
              : []) {
              if (message.type === 'user' && item.type === 'text' && typeof (item as { text?: unknown }).text === 'string')
                followUp.push((item as { text: string }).text)
              if (
                item.type !== 'tool_result' ||
                item.tool_use_id !== call.toolUseId
              )
                continue
              requireHost(!result)
              result = {
                content: toMcpContent(item.content),
                isError: item.is_error === true,
              }
            }
          }
        } finally {
          call.signal.removeEventListener('abort', onAbort)
        }
        requireHost(result)
        if (followUp.length > 0)
          result = { ...result, content: [...result.content, ...followUp.map(text => ({ type: 'text' as const, text }))] }
        const failed = result.isError === true
        const sourcePath =
          (call.name === 'Read' || call.name === 'Write') &&
          typeof call.input.file_path === 'string'
            ? call.input.file_path
            : undefined
        return boundCc5ToolResultSize(result, sourcePath).catch(() => ({
          content: [
            {
              type: 'text' as const,
              text: '[cc5 tool result omitted: too large to transfer]',
            },
          ],
          isError: failed,
        }))
      },
      async close() {
        context.abortController.abort('cc5-tool-host-closed')
        for (const client of clients) {
          if (client.type === 'connected')
            await client.cleanup().catch(() => {})
        }
        await SandboxManager.reset()
        await runCleanupFunctions()
      },
    },
    new Set(listedSchemas.map(schema => schema.name)),
  )
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  )
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  )
  const server = new Server(
    { name: 'openclaude-cc5-tool-host', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  askClient = (params, signal) => server.request({ method: 'openclaude/can_use_tool', params }, ResultSchema,
    { signal, timeout: PERMISSION_TIMEOUT_MS })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedSchemas,
  }))
  server.setRequestHandler(CallToolRequestSchema, async request =>
    dispatcher.call(request.params),
  )
  let shutdown: Promise<void> | undefined
  const close = () =>
    (shutdown ??= dispatcher.close().finally(async () => {
      await server.close()
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
      process.stdin.removeListener('end', onSignal)
    }))
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1
    })
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  process.stdin.once('end', onSignal)
  try {
    await server.connect(new StdioServerTransport())
  } catch (error) {
    await close()
    throw error
  }
}

/** The same client code a local chat uses for --mcp-config: parse the file,
 * then let CCB connect every server and build the MCP tool objects. */
async function connectCc5McpTools(mcpConfigPath: string) {
  const { parseMcpConfigFromFilePath } = await import(
    '../services/mcp/config.js'
  )
  const parsed = parseMcpConfigFromFilePath({
    filePath: mcpConfigPath,
    expandVars: true,
    scope: 'dynamic',
  })
  requireHost(parsed.config && parsed.errors.length === 0)
  const { prefetchAllMcpResources } = await import('../services/mcp/client.js')
  const { clients, tools } = await prefetchAllMcpResources(
    parsed.config.mcpServers,
  )
  return { clients, tools }
}

function toMcpContent(value: unknown): CallToolResult['content'] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  requireHost(Array.isArray(value))
  return value.map(block => {
    requireHost(block && typeof block === 'object')
    if (block.type === 'text' && typeof block.text === 'string')
      return { type: 'text' as const, text: block.text }
    requireHost(
      block.type === 'image' &&
        block.source?.type === 'base64' &&
        typeof block.source.media_type === 'string' &&
        typeof block.source.data === 'string',
    )
    return {
      type: 'image' as const,
      mimeType: block.source.media_type,
      data: block.source.data,
    }
  })
}

/** Keep an oversized tool result under MAX_RESULT_BYTES without turning image
 * data into text: text blocks keep their head plus a truncation note, image
 * blocks are recompressed into the remaining byte budget (split proportionally
 * when there are several), and any image that cannot fit is replaced by a
 * placeholder. Image failures degrade that one block; they never fail a turn. */
export async function boundCc5ToolResultSize(
  result: CallToolResult,
  sourcePath?: string,
): Promise<CallToolResult> {
  const isError = result.isError === true
  if (resultBytes({ content: result.content, isError }) <= MAX_RESULT_BYTES)
    return result
  const originalBytes = resultBytes({ content: result.content, isError })
  const note = `\n\n[cc5 tool result truncated: original ${originalBytes} bytes]`
  const content = (Array.isArray(result.content)
    ? result.content
    : []) as unknown as Array<Record<string, unknown>>
  const isImage = (
    block: Record<string, unknown>,
  ): block is { type: 'image'; mimeType?: string; data: string } =>
    block.type === 'image' && typeof block.data === 'string'
  const images = content.filter(isImage)
  if (images.length === 0) return truncateTextResult(content, isError, note)
  // Text keeps priority: when placeholders alone overflow, truncate the text.
  const placeheld = content.map(block =>
    isImage(block)
      ? textBlock(imageOmittedText(base64Bytes(block.data), sourcePath))
      : block,
  )
  if (
    resultBytes({ content: appendNote(placeheld, note), isError }) >
    MAX_RESULT_BYTES
  )
    return truncateTextResult(placeheld, isError, note)
  // Spend the remaining budget on the images, proportionally to their raw size.
  const reserved = resultBytes({
    content: appendNote(
      content.filter(block => !isImage(block)),
      note,
    ),
    isError,
  })
  const imageBudget = MAX_RESULT_BYTES - reserved
  const totalRaw = images.reduce(
    (sum, block) => sum + base64Bytes(block.data),
    0,
  )
  const boundedImages = new Map<
    Record<string, unknown>,
    Record<string, unknown>
  >()
  if (imageBudget > images.length * 256 && totalRaw > 0) {
    const { compressImageBuffer } = await import('../utils/imageResizer.js')
    for (const image of images) {
      const rawBytes = base64Bytes(image.data)
      const share = Math.floor(
        ((imageBudget - images.length * 256) * rawBytes) / totalRaw,
      )
      const maxBytes = Math.floor(((share * 3) / 4) * 0.95)
      try {
        const compressed = await compressImageBuffer(
          Buffer.from(image.data, 'base64'),
          Math.max(maxBytes, 1024),
          typeof image.mimeType === 'string' ? image.mimeType : undefined,
        )
        boundedImages.set(image, {
          type: 'image',
          mimeType: compressed.mediaType,
          data: compressed.base64,
        })
      } catch {
        boundedImages.set(
          image,
          textBlock(imageOmittedText(rawBytes, sourcePath)),
        )
      }
    }
  }
  const bounded = content.map(block =>
    isImage(block)
      ? (boundedImages.get(block) ??
        textBlock(imageOmittedText(base64Bytes(block.data), sourcePath)))
      : block,
  )
  let final = appendNote(bounded, note)
  // Compression can overshoot its share; drop the largest image until it fits.
  while (resultBytes({ content: final, isError }) > MAX_RESULT_BYTES) {
    const largest = final.reduce<{ index: number; length: number } | null>(
      (best, block, index) => {
        const length = isImage(block) ? block.data.length : 0
        return length > (best?.length ?? 0) ? { index, length } : best
      },
      null,
    )
    if (!largest || largest.length === 0)
      return truncateTextResult(bounded, isError, note)
    final = final.map((block, index) =>
      index === largest.index
        ? textBlock(
            imageOmittedText(base64Bytes(block.data as string), sourcePath),
          )
        : block,
    )
  }
  return { content: final as unknown as CallToolResult['content'], isError }
}

const imageOmittedText = (bytes: number, sourcePath?: string): string =>
  `[image omitted: original ${bytes} bytes, too large to transfer` +
  `${sourcePath ? `; source: ${sourcePath}` : ''}; read a smaller region or downscale]`

function resultBytes(result: { content: unknown; isError: boolean }): number {
  return Buffer.byteLength(
    JSON.stringify({ content: result.content, isError: result.isError }),
  )
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

function textBlock(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function appendNote(
  content: Array<Record<string, unknown>>,
  note: string,
): Array<Record<string, unknown>> {
  const copy = content.map(block => ({ ...block }))
  for (let index = copy.length - 1; index >= 0; index--) {
    const block = copy[index]
    if (block.type === 'text' && typeof block.text === 'string') {
      copy[index] = textBlock(`${block.text}${note}`)
      return copy
    }
  }
  copy.push(textBlock(note.trimStart()))
  return copy
}

/** Cut a UTF-8 buffer at a whole-character boundary so the model never sees U+FFFD. */
function truncateUtf8(bytes: Buffer, length: number): string {
  let end = Math.min(length, bytes.length)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

function truncateTextResult(
  content: Array<Record<string, unknown>>,
  isError: boolean,
  note: string,
): CallToolResult {
  const head = content
    .map(block =>
      typeof block.text === 'string' ? block.text : JSON.stringify(block),
    )
    .join('\n\n')
  const bytes = Buffer.from(head, 'utf8')
  const render = (length: number): CallToolResult => ({
    content: [{ type: 'text', text: `${truncateUtf8(bytes, length)}${note}` }],
    isError,
  })
  let low = 0
  let high = bytes.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (
      resultBytes({ content: render(middle).content, isError }) <=
      MAX_RESULT_BYTES
    )
      low = middle
    else high = middle - 1
  }
  return render(low)
}
