export interface QqBotConfig {
  appId: string
  appSecret: string
  entryUrl: string
  bindingHmacSecret: string
}

export function readQqBotConfig(env: NodeJS.ProcessEnv = process.env): QqBotConfig | null {
  const appId = env.QQBOT_APP_ID?.trim()
  const appSecret = env.QQBOT_APP_SECRET?.trim()
  const entryUrl = env.QQBOT_ENTRY_URL?.trim()
  const bindingHmacSecret = env.QQBOT_BINDING_HMAC_SECRET?.trim()
  const values = [appId, appSecret, entryUrl, bindingHmacSecret]
  if (values.every((value) => !value)) return null
  if (values.some((value) => !value)) {
    throw new Error(
      'QQ Bot configuration is partial; QQBOT_APP_ID, QQBOT_APP_SECRET, QQBOT_ENTRY_URL and QQBOT_BINDING_HMAC_SECRET must be set together',
    )
  }
  if (!/^[A-Za-z0-9_-]{2,128}$/.test(appId!)) {
    throw new Error('QQBOT_APP_ID has invalid shape')
  }
  if (appSecret!.length < 16 || appSecret!.length > 512) {
    throw new Error('QQBOT_APP_SECRET must be 16..512 characters')
  }
  if (bindingHmacSecret!.length < 32 || bindingHmacSecret!.length > 512) {
    throw new Error('QQBOT_BINDING_HMAC_SECRET must be 32..512 characters')
  }
  let parsed: URL
  try {
    parsed = new URL(entryUrl!)
  } catch {
    throw new Error('QQBOT_ENTRY_URL must be an absolute HTTPS URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('QQBOT_ENTRY_URL must use HTTPS')
  }
  return {
    appId: appId!,
    appSecret: appSecret!,
    entryUrl: parsed.toString(),
    bindingHmacSecret: bindingHmacSecret!,
  }
}
