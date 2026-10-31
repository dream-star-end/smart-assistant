/** Provider availability is separate from a model's quality or capability on this request. */
export const PAUSE_PROVIDER_CODES = [
  'IMAGE_DAILY_LIMIT',
  'MUSE_BRIDGE_LOST',
  'MUSE_SOURCE_FETCH_FAILED',
  'MUSE_SOURCE_TOO_LARGE',
] as const

export function pausesProvider(code: string | null | undefined): boolean {
  return PAUSE_PROVIDER_CODES.some((value) => value === code)
}

export const waitsForProvider = (code: string) => code === 'IMAGE_REQUEST_IN_PROGRESS'

export function providerPauseMessage(code: string): string {
  if (code === 'IMAGE_DAILY_LIMIT') return '图片服务今天的额度已用完，制作已暂停，已有结果会保留。'
  if (code === 'MUSE_SOURCE_TOO_LARGE') return '视频服务无法接收这张首帧，制作已暂停，已有结果会保留。'
  return '视频服务暂时无法接收首帧，制作已暂停，已有结果会保留。'
}
