// OCV5-591 — Muse failures caused by the source image a job carries (a shot's first frame, an
// image to edit). Older Muse bridges receive sources inline in the poll response, and large ones
// do not get through (MUSE_BRIDGE_LOST); the hub now refuses them up front (MUSE_SOURCE_TOO_LARGE),
// and bridges >= 0.5 download them after the ack (MUSE_SOURCE_FETCH_FAILED when that fails).
// The studio names this cause instead of the generic "every service was tried".

const SOURCE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'MUSE_BRIDGE_LOST',
  'MUSE_SOURCE_TOO_LARGE',
  'MUSE_SOURCE_FETCH_FAILED',
])

const SOURCE_OPS: ReadonlySet<string> = new Set(['video.from_image', 'image.edit'])

/** A Muse take that failed because of the source image it carried. */
export function isMuseSourceFailure(provider: string, op: string, code: string | null): boolean {
  return (
    provider.startsWith('muse-') &&
    SOURCE_OPS.has(op) &&
    code !== null &&
    SOURCE_FAILURE_CODES.has(code)
  )
}

export const MUSE_SOURCE_FAILED_TEXT = 'Muse 暂时领不到带首帧的任务'
