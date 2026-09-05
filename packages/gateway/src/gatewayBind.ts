export type GatewayListenOpts = {
  port: number
  host: string
  exclusive: boolean
}

/**
 * OPENCLAUDE_GATEWAY_PORT from the desktop Host (or tests). Empty / non-integer
 * / out-of-range values keep `configPort` so Linux containers without the env
 * are unchanged.
 */
export function parseGatewayPortOverride(raw: string | undefined | null): number | null {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  if (!/^[0-9]+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return n
}

/**
 * Resolve gateway listen host/port/exclusive.
 *
 * OPENCLAUDE_GATEWAY_BIND overrides config.bind when set (desktop passes 127.0.0.1).
 * OPENCLAUDE_GATEWAY_PORT overrides config.port when set (desktop Host injects the
 * loopback port it reserved). Default host/port are the current config values
 * (unchanged on Linux containers). exclusive:true on win32, or whenever the
 * bind override env is set.
 */
export function resolveGatewayListen(
  configBind: string,
  configPort: number,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GatewayListenOpts {
  const override = env.OPENCLAUDE_GATEWAY_BIND?.trim() || ''
  const host = override || configBind
  const exclusive = platform === 'win32' || override.length > 0
  const port = parseGatewayPortOverride(env.OPENCLAUDE_GATEWAY_PORT) ?? configPort
  return { port, host, exclusive }
}
