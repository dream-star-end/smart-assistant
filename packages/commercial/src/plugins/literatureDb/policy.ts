/** OCV5-524: user-approved exception belongs only to this site adapter. */
import type { DnsResolver, PinnedAddress } from '../../connectors/outboundPolicy.js'
import { resolvePinnedAddress } from '../../connectors/outboundPolicy.js'
import { LiteratureError } from './errors.js'

export const LITERATURE_SITE = 'http://www.jieyoutsg.com' as const
export const LITERATURE_HOST = 'www.jieyoutsg.com' as const
export const LITERATURE_HTTP_EXCEPTION = 'jieyoutsg-http-v1' as const
export type LiteratureMethod = 'GET' | 'HEAD' | 'POST'

export function literatureUrl(raw: string, base?: string): URL {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length > 4096 ||
      raw.includes('\\') ||
      Array.from(raw).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
    )
      throw new Error()
    // A caller cannot use an external base to expand this adapter's authority.
    const url = new URL(raw, base === undefined ? undefined : literatureUrl(base).href)
    if (
      url.hostname !== LITERATURE_HOST ||
      url.username ||
      url.password ||
      url.hash ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.port !== ''
    )
      throw new Error()
    return url
  } catch {
    throw new LiteratureError('OUTBOUND_BLOCKED')
  }
}

export async function pinLiteratureRequest(
  raw: string,
  resolver?: DnsResolver,
): Promise<{
  url: URL
  pin: PinnedAddress
}> {
  const url = literatureUrl(raw)
  try {
    return { url, pin: await resolvePinnedAddress(url.hostname, resolver) }
  } catch {
    throw new LiteratureError('OUTBOUND_BLOCKED')
  }
}

export function literatureMethod(value: string): LiteratureMethod {
  if (value !== 'GET' && value !== 'HEAD' && value !== 'POST')
    throw new LiteratureError('OUTBOUND_BLOCKED')
  return value
}
