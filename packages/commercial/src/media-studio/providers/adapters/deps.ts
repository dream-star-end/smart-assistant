// Services the built-in adapters ride on. Every field is optional: a missing service makes the
// matching provider unavailable (shown as not configured), never a boot failure.

import type { Pool } from 'pg'
import type { Image2RunInput, Image2RunResult } from '../../../billing/image2Run.js'
import type { ImageModelPolicy } from '../../../billing/imageModels.js'
import type {
  MiniMaxClientDeps,
  cloneVoice,
  designVoice,
  synthesizeSpeech,
} from '../../../minimax/mediaClient.js'
import type { MiniMaxMediaKey } from '../../../minimax/mediaKey.js'
import type { SystemVoice } from '../../../minimax/voices.js'
import type { MuseBridgeHub } from '../../../muse/hub.js'

export interface BuiltinAdapterDeps {
  /** Ledger reads for chargedFor (A2-1 deferred reconciliation). */
  pool?: Pool
  image2?: {
    enabled: boolean
    policy: ImageModelPolicy
    run(input: Image2RunInput): Promise<Image2RunResult>
  }
  muse?: {
    hub: Pick<MuseBridgeHub, 'bridgeOnline' | 'isAllowed' | 'submit' | 'view' | 'fileFor'>
    prices: { image: bigint; video: bigint }
    readFile(path: string): Promise<Buffer>
  }
  minimax?: {
    /** OCV5-589 resolution (MINIMAX_MEDIA_KEY_FILE, else MINIMAX_TOKEN_PLAN_KEY). */
    mediaKey: MiniMaxMediaKey
    /** The voice cache is built per provider from that provider's own key (code r1 P1). */
    client: Omit<MiniMaxClientDeps, 'key' | 'voices'>
    /** Test seams; production uses the real client, voice list and ledger. */
    speech?: typeof synthesizeSpeech
    fetchVoices?: (key: string) => Promise<SystemVoice[]>
    debitedFor?: (usageId: bigint) => Promise<bigint>
    design?: typeof designVoice
    clone?: typeof cloneVoice
    fetchPreview?: (url: string) => Promise<Buffer | null>
  }
}
