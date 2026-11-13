// Built-in adapter catalogue. Adding a vendor (e.g. the music provider the user picks later):
// write an AdapterFactory next to these, add it here, then add an OC_STUDIO_PROVIDERS entry
// whose key lives in a file (keyFile). The orchestrator and the web UI need no change.

import type { AdapterFactory } from '../registry.js'
import type { BuiltinAdapterDeps } from './deps.js'
import { gptImageAdapter } from './gptImage.js'
import { minimaxSpeechAdapter } from './minimaxSpeech.js'
import { museImageAdapter, museVideoAdapter } from './muse.js'
import { curatedCatalogAdapter, userLibraryAdapter } from './musicLibrary.js'

export const BUILTIN_ADAPTERS: readonly AdapterFactory<BuiltinAdapterDeps>[] = [
  gptImageAdapter,
  museImageAdapter,
  museVideoAdapter,
  minimaxSpeechAdapter,
  curatedCatalogAdapter,
  userLibraryAdapter,
]

export type { BuiltinAdapterDeps }
