/** Register after both classes initialize; the base adapter never imports its subclass. */
import { readFileSync } from 'node:fs'
import { isCc5ExecutionBackend } from '@openclaude/protocol'
import { SubprocessRunner } from '../subprocessRunner.js'
import { CcbAdapter } from './ccbAdapter.js'
import { Cc5InteractiveAdapter } from './cc5InteractiveAdapter.js'
import { registerEngine, registerEngineRemoteContext, type EngineCreateOpts } from './registry.js'

export function createCcbBackend(opts: EngineCreateOpts) {
  if (opts.executionBackend !== undefined) {
    if (!isCc5ExecutionBackend(opts.executionBackend)) throw new Error('CC5_BACKEND_SCOPE_INVALID')
    return new Cc5InteractiveAdapter(opts)
  }
  if (opts.cc5BridgePort) throw new Error('CC5_BACKEND_SCOPE_REQUIRED')
  return new CcbAdapter(opts)
}

registerEngine('ccb', createCcbBackend)

registerEngineRemoteContext('ccb', async ({ opts, supportsVision, promptPolicy, promptOnly }) => {
  const runner = new SubprocessRunner({
    ...opts,
    harness: 'official-cc',
    authorityEngine: 'ccb',
    boxResidentCc: true,
  })
  if (promptPolicy !== undefined) {
    runner.setPromptPrivacy(promptPolicy)
  }
  const { learning, profile, env, cleanup } = await runner.prepareRemoteToolContext({
    supportsVision,
  })
  const platformPrompt = learning.extraPromptFile
    ? readFileSync(learning.extraPromptFile, 'utf8')
    : ''
  if (promptOnly) {
    cleanup()
    return {
      profile,
      env,
      platformPrompt,
      promptCwd: profile.cwd,
      promptPolicyFingerprint: runner.promptPolicyFingerprint,
      promptIntelligentUi: runner.promptIntelligentUi,
      cleanup: () => {},
    }
  }
  return {
    profile,
    env,
    platformPrompt,
    promptCwd: profile.cwd,
    promptPolicyFingerprint: runner.promptPolicyFingerprint,
    promptIntelligentUi: runner.promptIntelligentUi,
    cleanup,
  }
})
