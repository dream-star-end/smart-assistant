import type { Server } from 'node:http'

export interface QwenChinaRelayOptions {
  apiKey: Buffer
  upstreamUrl?: string
  fetchImpl?: typeof fetch
  log?: (event: Record<string, unknown>) => void
}

export function createQwenChinaRelayServer(options: QwenChinaRelayOptions): Server
