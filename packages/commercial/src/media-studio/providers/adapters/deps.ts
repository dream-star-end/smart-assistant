// Services the built-in adapters ride on. Every field is optional: a missing service makes the
// matching provider unavailable (shown as not configured), never a boot failure.

import type { Image2RunInput, Image2RunResult } from '../../../billing/image2Run.js'
import type { ImageModelPolicy } from '../../../billing/imageModels.js'
import type { MiniMaxClientDeps } from '../../../minimax/mediaClient.js'
import type { MiniMaxMediaKey } from '../../../minimax/mediaKey.js'
import type { MuseBridgeHub } from '../../../muse/hub.js'

export interface BuiltinAdapterDeps {
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
    client: Omit<MiniMaxClientDeps, 'key'>
  }
}
