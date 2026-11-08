/** One mapping from a gateway session to the Codex protocol kernel, local and remote. */
import type { CodexAppServerRunnerOpts, CodexRemoteKernelRuntime } from './engine/codexAppServerRunner.js'
import type { EngineCreateOpts } from './engine/registry.js'

export function codexRunnerOptions(
  opts: EngineCreateOpts,
  remote?: CodexRemoteKernelRuntime,
): CodexAppServerRunnerOpts {
  return {
    sessionKey: opts.sessionKey,
    systemHelpContextFile: opts.systemHelpContextFile,
    agentId: opts.agentId,
    cwd: opts.agentBaseDir,
    resumeSessionId: opts.resumeSessionId,
    resolveResumeFallback: opts.resolveResumeFallback,
    model: opts.model,
    persona: opts.persona,
    identityCompat: opts.identityCompat,
    // 安全 gate(见 codexAdapter 文件头):engine 路由后任意 provider 的 agent 都可能落到
    // codex 底座,这里强制 'codex-native' 让 promptSlots 的 literature scrub
    // 与 GPT understand_image 提示段按 codex 语义生效,不受 agents.yaml 摆布。
    agentProvider: 'codex-native',
    effortLevel: opts.effortLevel,
    config: opts.config,
    delegationDepth: opts.delegationDepth,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    runContext: opts.runContext,
    frozenProjectContext: opts.frozenProjectContext,
    getRepoSnapshot: opts.getRepoSnapshot,
    hermeticNoTools: opts.hermeticNoTools,
    structuredOutputSchema: opts.structuredOutputSchema,
    ...(remote ? { remote } : {}),
  }
}
