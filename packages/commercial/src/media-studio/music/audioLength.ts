// OCV5-591 M1 follow-up — the real length of an uploaded track (My Music), read from the bytes
// already in memory: WAV from its header, MP3 by walking its frames (exact for CBR and VBR). The
// length feeds the music search filters, the editor and compose; BPM needs audio analysis and
// stays unknown for uploads.

/** Longest length the 0325 CHECK accepts (30 min); anything else is stored as unknown. */
const MAX_MS = 1_800_000

export function audioDurationMs(mime: string, b: Buffer): number | null {
  const ms = mime === 'audio/wav' ? wavMs(b) : mime === 'audio/mpeg' ? mp3Ms(b) : null
  if (ms === null || !Number.isFinite(ms)) return null
  const rounded = Math.round(ms)
  return rounded >= 1 && rounded <= MAX_MS ? rounded : null
}

function wavMs(b: Buffer): number | null {
  if (
    b.length < 12 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null
  let byteRate = 0
  let pos = 12
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4)
    const size = b.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ' && body + 12 <= b.length) byteRate = b.readUInt32LE(body + 8)
    if (id === 'data') {
      if (!byteRate) return null
      // A streamed WAV leaves the size at 0xFFFFFFFF: count what is there. A size of 0 is an empty
      // data chunk (whatever follows is other chunks, not audio), so 0 ms → unknown (code r1 P1).
      const bytes = size === 0xffffffff ? b.length - body : Math.min(size, b.length - body)
      return (bytes / byteRate) * 1000
    }
    pos = body + size + (size % 2)
  }
  return null
}

const BITRATES: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
}

interface Frame {
  length: number
  seconds: number
}

/** One MPEG audio frame header at `p`, or null. */
export function mp3Frame(b: Buffer, p: number): Frame | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) return null
  const version = (b[p + 1]! >> 3) & 3
  const layerBits = (b[p + 1]! >> 1) & 3
  const brIdx = b[p + 2]! >> 4
  const srIdx = (b[p + 2]! >> 2) & 3
  const pad = (b[p + 2]! >> 1) & 1
  if (version === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null
  const layer = 4 - layerBits // 1, 2, 3
  const kbps = BITRATES[`${version === 3 ? 1 : 2}-${layer}`]![brIdx]!
  const rate = RATES[version]![srIdx]!
  const mpeg1 = version === 3
  const samples = layer === 1 ? 384 : layer === 2 || mpeg1 ? 1152 : 576
  const length =
    layer === 1
      ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4
      : Math.floor(((layer === 3 && !mpeg1 ? 72 : 144) * kbps * 1000) / rate) + pad
  return length > 4 ? { length, seconds: samples / rate } : null
}

function mp3Ms(b: Buffer): number | null {
  let start = 0
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f)
    start = 10 + size + (b[5]! & 0x10 ? 10 : 0)
  }
  // The first frame: a header whose next frame is a header too (no false sync in tag padding).
  const limit = Math.min(b.length, start + 64 * 1024)
  let pos = -1
  for (let p = start; p < limit; p++) {
    const f = mp3Frame(b, p)
    if (f && (p + f.length === b.length || mp3Frame(b, p + f.length))) {
      pos = p
      break
    }
  }
  if (pos < 0) return null
  let seconds = 0
  let frames = 0
  let last = 0
  for (;;) {
    const f = mp3Frame(b, pos)
    if (!f || pos + f.length > b.length) break
    seconds += f.seconds
    frames += 1
    last = f.length
    pos += f.length
  }
  // The walk must reach the end (code r1 P1): what may follow the last frame is an ID3v1 / APE tag
  // or a cut-off final frame. Anything longer means lost sync mid-file, and the prefix is not the
  // track's length: unknown.
  const rest = b.length - pos
  const tag = rest >= 128 && b.toString('ascii', b.length - 128, b.length - 125) === 'TAG' ? 128 : 0
  const ape = b.indexOf('APETAGEX', pos, 'ascii')
  const tail = ape >= 0 ? ape - pos : rest - tag
  if (tail > last) return null
  // A Xing / Info (VBR header) frame is counted as one silent frame (~26 ms): close enough here.
  return frames >= 2 ? seconds * 1000 : null
}
