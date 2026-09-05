export type GatewayListenOpts = {
  port: number
  host: string
  exclusive: boolean
}

/**
 * Resolve gateway listen host/port/exclusive.
 *
 * OPENCLAUDE_GATEWAY_BIND overrides config.bind when set (desktop passes 127.0.0.1).
 * Default host is the current config value (unchanged on Linux containers).
 * exclusive:true on win32, or whenever the override env is set.
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
  return { port: configPort, host, exclusive }
}
