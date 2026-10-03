/** Cursor account-pool engine whose official Claude Code process lives in
 * that account's Grok Bot box. Parsing and the web timeline stay on CcbAdapter. */
import { unlinkSync } from 'node:fs'
import { CcbAdapter } from './ccbAdapter.js'
import type { EngineCapabilities } from './engineAdapter.js'
import type { EngineCreateOpts } from './registry.js'
import type { CursorCredentialSelection } from './cursorCredentialSelection.js'
import { writeBoxCcControlFile } from './cursorBoxCc.js'

export class CursorBoxCcAdapter extends CcbAdapter {
  override readonly engineId = 'cursor'
  override readonly capabilities: EngineCapabilities = {
    // proxy: the CLI's own usage is visible, but this path does not settle a
    // Cursor Sand bill or an Anthropic proxy bill. Login is the box's.
    billingMode: 'proxy',
    supportsEffort: false,
    resumeKind: 'ccb-session',
    needsServerRequestId: false,
    historyMode: 'native-resume',
    permissionModel: 'native',
    emitsCallUsage: true,
    emitsToolInputDeltas: true,
    supportsNativeCompact: false,
    multimodalInput: 'native',
  }

  private readonly controlHolder: { path: string | null }

  constructor(opts: EngineCreateOpts) {
    const selection = opts.cursorCredentialSelection
    if (!selection?.sandEnabled || selection.credentialKind !== 'session' || !selection.machineId) {
      throw new Error('BOX_CC_SESSION_REQUIRED')
    }
    const holder = { path: null as string | null }
    super({
      ...opts,
      harness: 'official-cc',
      boxResidentCc: true,
      prepareBoxCc: () => prepareControl(selection, opts.sessionKey, holder),
    })
    this.controlHolder = holder
  }

  override async shutdown(): Promise<void> {
    try {
      await super.shutdown()
    } finally {
      if (this.controlHolder.path) {
        try { unlinkSync(this.controlHolder.path) } catch { /* already gone */ }
        this.controlHolder.path = null
      }
    }
  }
}

async function prepareControl(
  selection: CursorCredentialSelection,
  sessionKey: string,
  holder: { path: string | null },
): Promise<string> {
  if (!holder.path) holder.path = await writeBoxCcControlFile({ selection, sessionKey })
  return holder.path
}
