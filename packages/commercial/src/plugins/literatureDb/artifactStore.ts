/**
 * Process-local, owner-scoped in-memory PDF artifact store for Literature Plugin (OCV5-524).
 *
 * Enforces:
 * - Single-file limit: 25 MiB (26,214,400 bytes)
 * - Total reservation cap: 4 slots (100 MiB)
 * - Per-user cap: 2 slots (50 MiB)
 * - Absolute TTL: 10 minutes after synchronous post-CAS publication
 * - Shared producer/consumer permit (no unbounded queue)
 */
import crypto, { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import zlib from 'node:zlib'
import { LiteratureError, abortable } from './errors.js'

export const LITERATURE_ARTIFACT_MAX_BYTES = 26_214_400
export const LITERATURE_ARTIFACT_TTL_MS = 10 * 60 * 1000
export const LITERATURE_ARTIFACT_MAX_TOTAL_SLOTS = 4
export const LITERATURE_ARTIFACT_MAX_USER_SLOTS = 2

const OPAQUE_ID_RE = /^[A-Za-z0-9-]{16,128}$/

/**
 * Standard 32-byte PDF encryption padding string per ISO 32000-1 §7.6.3.3 Algorithm 2.
 */
const PDF_ENCRYPT_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

/**
 * Rejects dangerous executable/script/external-launch dictionary entries in PDF objects.
 */
const DANGEROUS_PDF_TOKEN_RE =
  /\/(?:JS|JavaScript|Launch|EmbeddedFiles|RichMedia|SubmitForm|ImportData|GoToE|GoToR)(?![A-Za-z])/

export interface LiteratureDownloadResult {
  readonly artifactId: string
  readonly filename: string
  readonly mimeType: 'application/pdf'
  readonly bytes: number
}

export interface StagedLiteratureArtifact {
  readonly artifactId: string
  readonly result: LiteratureDownloadResult
  publish(): void
  discard(): void
}

export interface PublishedLiteratureArtifact {
  readonly artifactId: string
  readonly userId: number
  readonly filename: string
  readonly mimeType: 'application/pdf'
  readonly bytes: number
  readonly data: Buffer
  readonly expiresAt: number
}

interface StoredReservation {
  readonly id: string
  readonly userId: number
  buffer: Buffer | null
  bytes: number
  filename: string
  published: boolean
  discarded: boolean
  expiresAt: number
  activeReaders: number
}

export function sanitizeLiteraturePdfFilename(raw: string): string {
  const cleaned = raw
    .replace(/[\p{Cc}/\\:*?"<>|]+/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const base = cleaned.replace(/\.pdf$/i, '').trim() || 'literature-document'
  const truncated = Array.from(base).slice(0, 200).join('')
  return `${truncated}.pdf`
}

function normalizePdfNames(text: string): string {
  return text.replace(/\/[^\s()<>\[\]{}/%]+/g, (nameToken) =>
    nameToken.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
  )
}

function rc4Transform(key: Buffer, input: Buffer): Buffer {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    const tmp = s[i]!
    s[i] = s[j]!
    s[j] = tmp
  }
  const out = Buffer.allocUnsafe(input.length)
  let i = 0
  j = 0
  for (let k = 0; k < input.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]!) & 0xff
    const tmp = s[i]!
    s[i] = s[j]!
    s[j] = tmp
    out[k] = input[k]! ^ s[(s[i]! + s[j]!) & 0xff]!
  }
  return out
}

function decodePdfLiteralBytes(strContent: string): Buffer {
  const out: number[] = []
  let i = 0
  while (i < strContent.length) {
    const ch = strContent.charCodeAt(i)
    if (ch === 92) {
      i++
      if (i >= strContent.length) break
      const esc = strContent.charCodeAt(i)
      if (esc === 110) {
        out.push(10)
        i++
      } else if (esc === 114) {
        out.push(13)
        i++
      } else if (esc === 116) {
        out.push(9)
        i++
      } else if (esc === 98) {
        out.push(8)
        i++
      } else if (esc === 102) {
        out.push(12)
        i++
      } else if (esc === 40 || esc === 41 || esc === 92) {
        out.push(esc)
        i++
      } else if (esc === 13) {
        i++
        if (i < strContent.length && strContent.charCodeAt(i) === 10) i++
      } else if (esc === 10) {
        i++
      } else if (esc >= 48 && esc <= 55) {
        let oct = strContent[i]!
        i++
        for (let k = 0; k < 2 && i < strContent.length; k++) {
          const c2 = strContent.charCodeAt(i)
          if (c2 >= 48 && c2 <= 55) {
            oct += strContent[i]!
            i++
          } else {
            break
          }
        }
        out.push(Number.parseInt(oct, 8) & 0xff)
      } else {
        out.push(esc & 0xff)
        i++
      }
    } else {
      out.push(ch & 0xff)
      i++
    }
  }
  return Buffer.from(out)
}

function parsePdfStringField(dictBody: string, key: string): Buffer | null {
  const keyRe = new RegExp(`\\/${key}(?![A-Za-z0-9_])\\s*`)
  const m = keyRe.exec(dictBody)
  if (!m) return null
  const pos = m.index + m[0].length
  if (pos >= dictBody.length) return null
  if (dictBody[pos] === '<' && dictBody[pos + 1] !== '<') {
    const end = dictBody.indexOf('>', pos + 1)
    if (end < 0) return null
    let hex = dictBody.slice(pos + 1, end).replace(/\s+/g, '')
    if (hex.length % 2 === 1) hex += '0'
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null
    return Buffer.from(hex, 'hex')
  }
  if (dictBody[pos] === '(') {
    let depth = 1
    let i = pos + 1
    while (i < dictBody.length && depth > 0) {
      const ch = dictBody.charCodeAt(i)
      if (ch === 92) {
        i += 2
        continue
      }
      if (ch === 40) depth++
      else if (ch === 41) depth--
      i++
    }
    if (depth !== 0) return null
    return decodePdfLiteralBytes(dictBody.slice(pos + 1, i - 1))
  }
  return null
}

function parseTrailerFirstId(text: string): Buffer | null {
  const m = /\/ID\s*\[\s*(<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\))/.exec(text)
  if (!m) return null
  if (m[2] !== undefined) {
    let hex = m[2].replace(/\s+/g, '')
    if (hex.length % 2 === 1) hex += '0'
    return Buffer.from(hex, 'hex')
  }
  if (m[3] !== undefined) {
    return decodePdfLiteralBytes(m[3])
  }
  return null
}

/**
 * Verifies whether a PDF /Encrypt dictionary uses the Standard security handler
 * with an EMPTY user password ("") — i.e. publisher permission restrictions only
 * (such as print/copy limits common in CNKI/Wanfang/VIP PDFs) where the file opens
 * without prompting for a user password.
 */
export function isPermittedEmptyPasswordEncryptDict(
  rawEncryptDict: string,
  fileId: Buffer | null,
): boolean {
  const encryptDict = normalizePdfNames(rawEncryptDict)
  if (!/\/Filter\s*\/Standard(?![A-Za-z])/.test(encryptDict)) return false
  if (/\/Filter\s*\/(?!Standard(?![A-Za-z]))[A-Za-z0-9_.+-]+/.test(encryptDict)) return false
  if (/\/SubFilter\s*\//.test(encryptDict)) return false
  const vMatch = /\/V\s+(\d+)\b/.exec(encryptDict)
  const rMatch = /\/R\s+(\d+)\b/.exec(encryptDict)
  const pMatch = /\/P\s+(-?\d+)\b/.exec(encryptDict)
  if (!rMatch?.[1] || !pMatch?.[1]) return false
  const v = vMatch?.[1] ? Number.parseInt(vMatch[1], 10) : 1
  const r = Number.parseInt(rMatch[1], 10)
  const pSigned = Number.parseInt(pMatch[1], 10)
  if (!Number.isSafeInteger(pSigned)) return false

  const oVal = parsePdfStringField(encryptDict, 'O')
  const uVal = parsePdfStringField(encryptDict, 'U')
  if (!oVal || !uVal) return false

  if (r === 2 || r === 3 || r === 4) {
    if (v !== 1 && v !== 2 && v !== 4) return false
    if (oVal.length < 32 || uVal.length < 32) return false
    const lenMatch = /\/Length\s+(\d+)\b/.exec(encryptDict)
    let keyByteLen = 5
    if (r >= 3) {
      const bitLen = lenMatch?.[1] ? Number.parseInt(lenMatch[1], 10) : 128
      if (bitLen < 40 || bitLen > 128 || bitLen % 8 !== 0) return false
      keyByteLen = bitLen / 8
    }
    const pBuf = Buffer.allocUnsafe(4)
    pBuf.writeInt32LE(pSigned | 0, 0)

    const md5 = crypto.createHash('md5')
    md5.update(PDF_ENCRYPT_PAD)
    md5.update(oVal.subarray(0, 32))
    md5.update(pBuf)
    if (fileId && fileId.length > 0) {
      md5.update(fileId)
    }
    if (r >= 4 && /\/EncryptMetadata\s+false\b/.test(encryptDict)) {
      md5.update(Buffer.from([0xff, 0xff, 0xff, 0xff]))
    }
    let digest = md5.digest()
    if (r >= 3) {
      for (let i = 0; i < 50; i++) {
        digest = crypto.createHash('md5').update(digest.subarray(0, keyByteLen)).digest()
      }
    }
    const encKey = digest.subarray(0, keyByteLen)
    if (r === 2) {
      const expectedU = rc4Transform(encKey, PDF_ENCRYPT_PAD)
      return expectedU.equals(uVal.subarray(0, 32))
    }
    if (!fileId || fileId.length === 0) return false
    const stepHash = crypto.createHash('md5').update(PDF_ENCRYPT_PAD).update(fileId).digest()
    let cur = rc4Transform(encKey, stepHash)
    const xorKey = Buffer.allocUnsafe(encKey.length)
    for (let i = 1; i <= 19; i++) {
      for (let j = 0; j < encKey.length; j++) {
        xorKey[j] = encKey[j]! ^ i
      }
      cur = rc4Transform(xorKey, cur)
    }
    return cur.equals(uVal.subarray(0, 16))
  }

  if (r === 5 && v === 5) {
    if (uVal.length < 48) return false
    const expectedU = crypto.createHash('sha256').update(uVal.subarray(32, 40)).digest()
    return expectedU.equals(uVal.subarray(0, 32))
  }

  return false
}

export function validatePdfStructureSync(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 64 || data.length > LITERATURE_ARTIFACT_MAX_BYTES)
    return false
  const head = data.subarray(0, Math.min(data.length, 1024)).toString('latin1')
  if (!/^%PDF-[12]\.\d[\r\n]/.test(head)) return false
  if (/<(?:!doctype|html|head|body|script|iframe)\b/i.test(head)) return false

  const fullStr = data.toString('latin1')

  const tailLen = Math.min(data.length, 65536)
  const tail = data.subarray(data.length - tailLen).toString('latin1')
  const startxrefMatches = Array.from(tail.matchAll(/\bstartxref[\r\n\s]+(\d+)[\r\n\s]+%%EOF/g))
  if (startxrefMatches.length === 0) return false
  const lastMatch = startxrefMatches[startxrefMatches.length - 1]!
  const startXrefOffset = Number.parseInt(lastMatch[1]!, 10)
  if (
    !Number.isSafeInteger(startXrefOffset) ||
    startXrefOffset <= 8 ||
    startXrefOffset >= data.length - 16
  ) {
    return false
  }

  const findPdfKeyword = (kw: string, fromIdx: number): number => {
    let pos = fromIdx
    while (pos < fullStr.length) {
      const idx = fullStr.indexOf(kw, pos)
      if (idx < 0) return -1
      const prev = idx > 0 ? fullStr.charCodeAt(idx - 1) : 32
      const next = idx + kw.length < fullStr.length ? fullStr.charCodeAt(idx + kw.length) : 32
      const prevIsToken =
        prev === 47 ||
        (prev >= 48 && prev <= 57) ||
        (prev >= 65 && prev <= 90) ||
        (prev >= 97 && prev <= 122) ||
        prev === 95
      const nextIsToken =
        (next >= 48 && next <= 57) ||
        (next >= 65 && next <= 90) ||
        (next >= 97 && next <= 122) ||
        next === 95
      if (!prevIsToken && !nextIsToken) return idx
      pos = idx + 1
    }
    return -1
  }

  const extractObjAtOffset = (
    offset: number,
    expectedNum?: number,
    expectedGen?: number,
  ): { num: number; gen: number; body: string } | null => {
    if (offset <= 0 || offset >= data.length - 16) return null
    const winStart = Math.max(0, offset - 64)
    const winEnd = Math.min(data.length, offset + 160)
    const windowStr = fullStr.slice(winStart, winEnd)
    let bodyStart = -1
    let num = expectedNum ?? -1
    let gen = expectedGen ?? -1

    if (expectedNum !== undefined && expectedGen !== undefined) {
      const exactHead = fullStr.slice(offset, Math.min(data.length, offset + 96))
      const exactMatch = /^[\r\n\s]*(\d+)\s+(\d+)\s+obj\b/.exec(exactHead)
      if (
        exactMatch?.[1] &&
        exactMatch[2] &&
        Number.parseInt(exactMatch[1], 10) === expectedNum &&
        Number.parseInt(exactMatch[2], 10) === expectedGen
      ) {
        bodyStart = offset + exactMatch[0].length
      } else {
        const driftRe = new RegExp(`(?:^|[^0-9])(${expectedNum})\\s+(${expectedGen})\\s+obj\\b`)
        const dm = driftRe.exec(windowStr)
        if (!dm) return null
        bodyStart = winStart + dm.index + dm[0].length
      }
    } else {
      const exactHead = fullStr.slice(offset, Math.min(data.length, offset + 96))
      const exactMatch = /^[\r\n\s]*(\d+)\s+(\d+)\s+obj\b/.exec(exactHead)
      if (exactMatch?.[1] && exactMatch[2]) {
        num = Number.parseInt(exactMatch[1], 10)
        gen = Number.parseInt(exactMatch[2], 10)
        bodyStart = offset + exactMatch[0].length
      } else {
        const driftMatch = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/.exec(windowStr)
        if (!driftMatch?.[1] || !driftMatch[2]) return null
        num = Number.parseInt(driftMatch[1], 10)
        gen = Number.parseInt(driftMatch[2], 10)
        bodyStart = winStart + driftMatch.index + driftMatch[0].length
      }
    }

    const firstEndobj = findPdfKeyword('endobj', bodyStart)
    if (firstEndobj < 0) return null
    const preEndobj = fullStr.slice(bodyStart, firstEndobj)
    const streamMatch = /(?:^|[^A-Za-z0-9_/])(stream[\r\n])/.exec(preEndobj)
    if (streamMatch?.[1]) {
      const streamRelIdx = streamMatch.index + streamMatch[0].length - streamMatch[1].length
      const dictBody = preEndobj.slice(0, streamRelIdx)
      const endstreamIdx = findPdfKeyword('endstream', bodyStart + streamRelIdx + 6)
      if (endstreamIdx < 0) return null
      const realEndobj = findPdfKeyword('endobj', endstreamIdx + 9)
      if (realEndobj < 0) return null
      return { num, gen, body: normalizePdfNames(dictBody) }
    }
    return { num, gen, body: normalizePdfNames(preEndobj) }
  }

  const objMap = new Map<string, string>()
  const scannedObjMap = new Map<string, string>()
  const scannedDicts: string[] = []
  const trailerTexts: string[] = []
  let rootObjKey: string | null = null

  // Scan all top-level obj..endobj dictionaries and /ObjStm streams across the file
  // so unreferenced or hybrid-xref objects cannot hide dangerous actions or /Encrypt
  const allObjRe = /\b(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g
  let om: RegExpExecArray | null
  while ((om = allObjRe.exec(fullStr)) !== null) {
    const id = Number.parseInt(om[1]!, 10)
    const gen = Number.parseInt(om[2]!, 10)
    const fullBody = om[3]!
    const streamMatch = /(?:^|[^A-Za-z0-9_/])(stream[\r\n])/.exec(fullBody)
    const dictOnly = normalizePdfNames(
      streamMatch?.[1]
        ? fullBody.slice(0, streamMatch.index + streamMatch[0].length - streamMatch[1].length)
        : fullBody,
    )
    scannedDicts.push(dictOnly)
    if (!scannedObjMap.has(`${id}:${gen}`)) {
      scannedObjMap.set(`${id}:${gen}`, dictOnly)
    }
    if (/\/Type\s*\/ObjStm(?![A-Za-z])/.test(dictOnly)) {
      const nMatch = /\/N\s+(\d+)\b/.exec(dictOnly)
      const firstMatch = /\/First\s+(\d+)\b/.exec(dictOnly)
      const streamIdx = fullBody.indexOf('stream')
      const endstreamIdx = fullBody.lastIndexOf('endstream')
      if (!nMatch?.[1] || !firstMatch?.[1] || streamIdx < 0 || endstreamIdx <= streamIdx) {
        return false
      }
      const n = Number.parseInt(nMatch[1], 10)
      const first = Number.parseInt(firstMatch[1], 10)
      let rawPos = om.index + om[0].indexOf('stream') + 6
      if (data[rawPos] === 13 && data[rawPos + 1] === 10) rawPos += 2
      else if (data[rawPos] === 10 || data[rawPos] === 13) rawPos += 1
      let rawEnd = om.index + om[0].lastIndexOf('endstream')
      while (rawEnd > rawPos && (data[rawEnd - 1] === 10 || data[rawEnd - 1] === 13)) {
        rawEnd--
      }
      if (rawEnd <= rawPos) return false
      try {
        const inflated = zlib.inflateSync(data.subarray(rawPos, rawEnd), {
          maxOutputLength: 8 * 1024 * 1024,
        })
        const headerStr = inflated.subarray(0, first).toString('latin1').trim()
        const pairs = headerStr.split(/\s+/)
        const offsets: Array<{ id: number; rel: number }> = []
        for (let p = 0; p + 1 < pairs.length && offsets.length < n; p += 2) {
          offsets.push({
            id: Number.parseInt(pairs[p]!, 10),
            rel: Number.parseInt(pairs[p + 1]!, 10),
          })
        }
        for (let j = 0; j < offsets.length; j++) {
          const startByte = first + offsets[j]!.rel
          const endByte =
            j + 1 < offsets.length ? first + offsets[j + 1]!.rel : inflated.length
          if (startByte >= first && endByte >= startByte && endByte <= inflated.length) {
            const innerDict = normalizePdfNames(
              inflated.subarray(startByte, endByte).toString('latin1'),
            )
            scannedDicts.push(innerDict)
            scannedObjMap.set(`${offsets[j]!.id}:0`, innerDict)
          }
        }
      } catch {
        // Un-inflatable /ObjStm (e.g. encrypted object stream hiding dictionaries) is rejected
        return false
      }
    }
  }

  const xrefSearchStart = Math.max(0, startXrefOffset - 64)
  const xrefSearchWindow = fullStr.slice(xrefSearchStart, Math.min(data.length, startXrefOffset + 128))
  const xrefKwMatch = /(?:^|[\r\n\s])(xref)(?=[\r\n\s])/.exec(xrefSearchWindow)

  if (xrefKwMatch?.[1]) {
    const firstXrefOff =
      xrefSearchStart + xrefKwMatch.index + xrefKwMatch[0].length - xrefKwMatch[1].length
    const visitedXref = new Set<number>()
    let curXrefOff: number | null = firstXrefOff
    while (curXrefOff !== null && !visitedXref.has(curXrefOff) && visitedXref.size < 8) {
      visitedXref.add(curXrefOff)
      if (curXrefOff <= 0 || curXrefOff >= data.length - 16) return false
      const winStart = Math.max(0, curXrefOff - 64)
      const winCheck = fullStr.slice(winStart, Math.min(data.length, curXrefOff + 128))
      const xm = /(?:^|[\r\n\s])(xref)(?=[\r\n\s])/.exec(winCheck)
      if (!xm?.[1]) return false
      const actualXrefOff = winStart + xm.index + xm[0].length - xm[1].length
      const xrefText = data
        .subarray(actualXrefOff, Math.min(data.length, actualXrefOff + 524288))
        .toString('latin1')
      const trailerIdx = xrefText.search(/\btrailer(?:\s|<<)/)
      if (trailerIdx < 0) return false
      const tablePart = xrefText.slice(0, trailerIdx).trim()
      const trailerPart = normalizePdfNames(xrefText.slice(trailerIdx))
      trailerTexts.push(trailerPart)
      if (/\/XRefStm\b/.test(trailerPart)) return false

      if (!/^xref(?:\s|$)/.test(tablePart)) return false
      const afterXref = tablePart.replace(/^xref\s*/, '')
      const lines = afterXref
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter(Boolean)
      let idx = 0
      let entriesParsed = 0
      while (idx < lines.length) {
        const subMatch = /^(\d+)\s+(\d+)$/.exec(lines[idx]!)
        if (!subMatch?.[1] || !subMatch[2]) return false
        const firstId = Number.parseInt(subMatch[1], 10)
        const count = Number.parseInt(subMatch[2], 10)
        idx++
        if (idx + count > lines.length) return false
        for (let k = 0; k < count; k++) {
          const entryLine = lines[idx + k]!
          const em = /^(\d{10})\s+(\d{5})\s+([nf])$/.exec(entryLine)
          if (!em?.[1] || !em[2] || !em[3]) return false
          if (em[3] === 'n') {
            const off = Number.parseInt(em[1], 10)
            const gen = Number.parseInt(em[2], 10)
            const objId = firstId + k
            if (objId === 0 || off === 0) continue
            const objKey = `${objId}:${gen}`
            if (!objMap.has(objKey)) {
              const parsed = extractObjAtOffset(off, objId, gen)
              if (!parsed) return false
              objMap.set(objKey, parsed.body)
              scannedDicts.push(parsed.body)
            }
            entriesParsed++
          }
        }
        idx += count
      }
      if (entriesParsed === 0 && visitedXref.size === 1) return false

      if (rootObjKey === null) {
        const rm = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(trailerPart)
        if (rm?.[1] && rm[2]) {
          rootObjKey = `${Number.parseInt(rm[1], 10)}:${Number.parseInt(rm[2], 10)}`
        }
      }
      const prevMatch = /\/Prev\s+(\d+)\b/.exec(trailerPart)
      curXrefOff = prevMatch?.[1] ? Number.parseInt(prevMatch[1], 10) : null
    }
  } else {
    for (const [k, v] of scannedObjMap) objMap.set(k, v)
    const xrefObj = extractObjAtOffset(startXrefOffset)
    if (!xrefObj || !/\/Type\s*\/XRef(?![A-Za-z])/.test(xrefObj.body)) return false
    trailerTexts.push(xrefObj.body)
    const normalizedTail = normalizePdfNames(tail)
    const rm =
      /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(xrefObj.body) ??
      /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(normalizedTail)
    if (!rm?.[1] || !rm[2]) return false
    rootObjKey = `${Number.parseInt(rm[1], 10)}:${Number.parseInt(rm[2], 10)}`
  }

  for (const tText of trailerTexts) {
    if (DANGEROUS_PDF_TOKEN_RE.test(tText)) return false
  }
  for (const dictText of scannedDicts) {
    if (DANGEROUS_PDF_TOKEN_RE.test(dictText)) return false
  }

  const combinedTrailers = trailerTexts.join('\n')
  const hasEncryptToken =
    /\/Encrypt(?![A-Za-z])/.test(combinedTrailers) ||
    scannedDicts.some((b) => /\/Encrypt(?![A-Za-z])/.test(b))

  if (hasEncryptToken) {
    const encRefs = Array.from(combinedTrailers.matchAll(/\/Encrypt\s+(\d+)\s+(\d+)\s+R\b/g))
    const inlineEncs = Array.from(combinedTrailers.matchAll(/\/Encrypt\s*<<([\s\S]*?)>>/g))
    if (encRefs.length === 0 && inlineEncs.length === 0) return false
    const fileId = parseTrailerFirstId(combinedTrailers) ?? parseTrailerFirstId(tail)
    for (const ref of encRefs) {
      const encKey = `${Number.parseInt(ref[1]!, 10)}:${Number.parseInt(ref[2]!, 10)}`
      const encryptDictBody = objMap.get(encKey) ?? null
      if (!encryptDictBody || !isPermittedEmptyPasswordEncryptDict(encryptDictBody, fileId)) {
        return false
      }
    }
    for (const inl of inlineEncs) {
      if (!inl[1] || !isPermittedEmptyPasswordEncryptDict(inl[1], fileId)) {
        return false
      }
    }
  }

  if (rootObjKey === null || !objMap.has(rootObjKey)) return false
  const catalogBody = objMap.get(rootObjKey)!
  if (!/\/Type\s*\/Catalog(?![A-Za-z])/.test(catalogBody)) return false
  const pagesRefMatch = /\/Pages\s+(\d+)\s+(\d+)\s+R\b/.exec(catalogBody)
  if (!pagesRefMatch?.[1] || !pagesRefMatch[2]) return false
  const rootPagesKey = `${Number.parseInt(pagesRefMatch[1], 10)}:${Number.parseInt(pagesRefMatch[2], 10)}`

  const visitedNodes = new Set<string>()
  const queue: string[] = [rootPagesKey]
  let pageCount = 0
  while (queue.length > 0 && visitedNodes.size < 500) {
    const curKey = queue.shift()!
    if (visitedNodes.has(curKey)) return false
    visitedNodes.add(curKey)
    const nodeBody = objMap.get(curKey)
    if (!nodeBody) return false
    if (/\/Type\s*\/Pages(?![A-Za-z])/.test(nodeBody)) {
      const countMatch = /\/Count\s+([1-9]\d*)\b/.exec(nodeBody)
      if (!countMatch?.[1]) return false
      let kidsSource = nodeBody
      const directKidsMatch = /\/Kids\s*\[([\s\S]*?)\]/.exec(nodeBody)
      if (directKidsMatch?.[1] !== undefined) {
        kidsSource = directKidsMatch[1]
      } else {
        const indirectKidsRef = /\/Kids\s+(\d+)\s+(\d+)\s+R\b/.exec(nodeBody)
        if (!indirectKidsRef?.[1] || !indirectKidsRef[2]) return false
        const kidsKey = `${Number.parseInt(indirectKidsRef[1], 10)}:${Number.parseInt(indirectKidsRef[2], 10)}`
        const kidsArrayBody = objMap.get(kidsKey)
        if (!kidsArrayBody) return false
        kidsSource = kidsArrayBody
      }
      const kidRefs = Array.from(kidsSource.matchAll(/(\d+)\s+(\d+)\s+R\b/g))
      if (kidRefs.length === 0) return false
      for (const kr of kidRefs) {
        queue.push(`${Number.parseInt(kr[1]!, 10)}:${Number.parseInt(kr[2]!, 10)}`)
      }
    } else if (/\/Type\s*\/Page(?![A-Za-z])/.test(nodeBody)) {
      pageCount++
    } else {
      return false
    }
  }
  return pageCount > 0
}

const WORKER_SCRIPT = "\nconst { parentPort, workerData } = require('node:worker_threads');\nconst crypto = require('node:crypto');\nconst zlib = require('node:zlib');\nconst LITERATURE_ARTIFACT_MAX_BYTES = 26214400;\nconst PDF_ENCRYPT_PAD = Buffer.from([\n  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,\n  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,\n]);\nconst DANGEROUS_PDF_TOKEN_RE =\n  /\\/(?:JS|JavaScript|Launch|EmbeddedFiles|RichMedia|SubmitForm|ImportData|GoToE|GoToR)(?![A-Za-z])/;\n\nfunction normalizePdfNames(text) {\n  return text.replace(/\\/[^\\s()<>[\\]{}/%]+/g, (nameToken) =>\n    nameToken.replace(/#([0-9A-Fa-f]{2})/g, (_, hex) =>\n      String.fromCharCode(Number.parseInt(hex, 16)),\n    ),\n  );\n}\n\nfunction rc4Transform(key, input) {\n  const s = new Uint8Array(256);\n  for (let i = 0; i < 256; i++) s[i] = i;\n  let j = 0;\n  for (let i = 0; i < 256; i++) {\n    j = (j + s[i] + key[i % key.length]) & 0xff;\n    const tmp = s[i];\n    s[i] = s[j];\n    s[j] = tmp;\n  }\n  const out = Buffer.allocUnsafe(input.length);\n  let i = 0;\n  j = 0;\n  for (let k = 0; k < input.length; k++) {\n    i = (i + 1) & 0xff;\n    j = (j + s[i]) & 0xff;\n    const tmp = s[i];\n    s[i] = s[j];\n    s[j] = tmp;\n    out[k] = input[k] ^ s[(s[i] + s[j]) & 0xff];\n  }\n  return out;\n}\n\nfunction decodePdfLiteralBytes(strContent) {\n  const out = [];\n  let i = 0;\n  while (i < strContent.length) {\n    const ch = strContent.charCodeAt(i);\n    if (ch === 92) {\n      i++;\n      if (i >= strContent.length) break;\n      const esc = strContent.charCodeAt(i);\n      if (esc === 110) { out.push(10); i++; }\n      else if (esc === 114) { out.push(13); i++; }\n      else if (esc === 116) { out.push(9); i++; }\n      else if (esc === 98) { out.push(8); i++; }\n      else if (esc === 102) { out.push(12); i++; }\n      else if (esc === 40 || esc === 41 || esc === 92) { out.push(esc); i++; }\n      else if (esc === 13) {\n        i++;\n        if (i < strContent.length && strContent.charCodeAt(i) === 10) i++;\n      } else if (esc === 10) {\n        i++;\n      } else if (esc >= 48 && esc <= 55) {\n        let oct = strContent[i];\n        i++;\n        for (let k = 0; k < 2 && i < strContent.length; k++) {\n          const c2 = strContent.charCodeAt(i);\n          if (c2 >= 48 && c2 <= 55) { oct += strContent[i]; i++; }\n          else break;\n        }\n        out.push(Number.parseInt(oct, 8) & 0xff);\n      } else {\n        out.push(esc & 0xff);\n        i++;\n      }\n    } else {\n      out.push(ch & 0xff);\n      i++;\n    }\n  }\n  return Buffer.from(out);\n}\n\nfunction parsePdfStringField(dictBody, key) {\n  const keyRe = new RegExp('\\\\/' + key + '(?![A-Za-z0-9_])\\\\s*');\n  const m = keyRe.exec(dictBody);\n  if (!m) return null;\n  const pos = m.index + m[0].length;\n  if (pos >= dictBody.length) return null;\n  if (dictBody[pos] === '<' && dictBody[pos + 1] !== '<') {\n    const end = dictBody.indexOf('>', pos + 1);\n    if (end < 0) return null;\n    let hex = dictBody.slice(pos + 1, end).replace(/\\s+/g, '');\n    if (hex.length % 2 === 1) hex += '0';\n    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;\n    return Buffer.from(hex, 'hex');\n  }\n  if (dictBody[pos] === '(') {\n    let depth = 1;\n    let i = pos + 1;\n    while (i < dictBody.length && depth > 0) {\n      const ch = dictBody.charCodeAt(i);\n      if (ch === 92) { i += 2; continue; }\n      if (ch === 40) depth++;\n      else if (ch === 41) depth--;\n      i++;\n    }\n    if (depth !== 0) return null;\n    return decodePdfLiteralBytes(dictBody.slice(pos + 1, i - 1));\n  }\n  return null;\n}\n\nfunction parseTrailerFirstId(text) {\n  const m = /\\/ID\\s*\\[\\s*(<([0-9a-fA-F\\s]*)>|\\(((?:\\\\.|[^\\\\)])*)\\))/.exec(text);\n  if (!m) return null;\n  if (m[2] !== undefined) {\n    let hex = m[2].replace(/\\s+/g, '');\n    if (hex.length % 2 === 1) hex += '0';\n    return Buffer.from(hex, 'hex');\n  }\n  if (m[3] !== undefined) {\n    return decodePdfLiteralBytes(m[3]);\n  }\n  return null;\n}\n\nfunction isPermittedEmptyPasswordEncryptDict(rawEncryptDict, fileId) {\n  const encryptDict = normalizePdfNames(rawEncryptDict);\n  if (!/\\/Filter\\s*\\/Standard(?![A-Za-z])/.test(encryptDict)) return false;\n  if (/\\/Filter\\s*\\/(?!Standard(?![A-Za-z]))[A-Za-z0-9_.+-]+/.test(encryptDict)) return false;\n  if (/\\/SubFilter\\s*\\//.test(encryptDict)) return false;\n  const vMatch = /\\/V\\s+(\\d+)\\b/.exec(encryptDict);\n  const rMatch = /\\/R\\s+(\\d+)\\b/.exec(encryptDict);\n  const pMatch = /\\/P\\s+(-?\\d+)\\b/.exec(encryptDict);\n  if (!rMatch || !rMatch[1] || !pMatch || !pMatch[1]) return false;\n  const v = vMatch && vMatch[1] ? Number.parseInt(vMatch[1], 10) : 1;\n  const r = Number.parseInt(rMatch[1], 10);\n  const pSigned = Number.parseInt(pMatch[1], 10);\n  if (!Number.isSafeInteger(pSigned)) return false;\n\n  const oVal = parsePdfStringField(encryptDict, 'O');\n  const uVal = parsePdfStringField(encryptDict, 'U');\n  if (!oVal || !uVal) return false;\n\n  if (r === 2 || r === 3 || r === 4) {\n    if (v !== 1 && v !== 2 && v !== 4) return false;\n    if (oVal.length < 32 || uVal.length < 32) return false;\n    const lenMatch = /\\/Length\\s+(\\d+)\\b/.exec(encryptDict);\n    let keyByteLen = 5;\n    if (r >= 3) {\n      const bitLen = lenMatch && lenMatch[1] ? Number.parseInt(lenMatch[1], 10) : 128;\n      if (bitLen < 40 || bitLen > 128 || bitLen % 8 !== 0) return false;\n      keyByteLen = bitLen / 8;\n    }\n    const pBuf = Buffer.allocUnsafe(4);\n    pBuf.writeInt32LE(pSigned | 0, 0);\n\n    const md5 = crypto.createHash('md5');\n    md5.update(PDF_ENCRYPT_PAD);\n    md5.update(oVal.subarray(0, 32));\n    md5.update(pBuf);\n    if (fileId && fileId.length > 0) md5.update(fileId);\n    if (r >= 4 && /\\/EncryptMetadata\\s+false\\b/.test(encryptDict)) {\n      md5.update(Buffer.from([0xff, 0xff, 0xff, 0xff]));\n    }\n    let digest = md5.digest();\n    if (r >= 3) {\n      for (let i = 0; i < 50; i++) {\n        digest = crypto.createHash('md5').update(digest.subarray(0, keyByteLen)).digest();\n      }\n    }\n    const encKey = digest.subarray(0, keyByteLen);\n    if (r === 2) {\n      const expectedU = rc4Transform(encKey, PDF_ENCRYPT_PAD);\n      return expectedU.equals(uVal.subarray(0, 32));\n    }\n    if (!fileId || fileId.length === 0) return false;\n    const stepHash = crypto.createHash('md5').update(PDF_ENCRYPT_PAD).update(fileId).digest();\n    let cur = rc4Transform(encKey, stepHash);\n    const xorKey = Buffer.allocUnsafe(encKey.length);\n    for (let i = 1; i <= 19; i++) {\n      for (let j = 0; j < encKey.length; j++) xorKey[j] = encKey[j] ^ i;\n      cur = rc4Transform(xorKey, cur);\n    }\n    return cur.equals(uVal.subarray(0, 16));\n  }\n\n  if (r === 5 && v === 5) {\n    if (uVal.length < 48) return false;\n    const expectedU = crypto.createHash('sha256').update(uVal.subarray(32, 40)).digest();\n    return expectedU.equals(uVal.subarray(0, 32));\n  }\n  return false;\n}\n\nfunction check(data) {\n  if (!Buffer.isBuffer(data) || data.length < 64 || data.length > LITERATURE_ARTIFACT_MAX_BYTES) return false;\n  const head = data.subarray(0, Math.min(data.length, 1024)).toString('latin1');\n  if (!/^%PDF-[12]\\.\\d[\\r\\n]/.test(head)) return false;\n  if (/<(?:!doctype|html|head|body|script|iframe)\\b/i.test(head)) return false;\n\n  const fullStr = data.toString('latin1');\n  const tailLen = Math.min(data.length, 65536);\n  const tail = data.subarray(data.length - tailLen).toString('latin1');\n  const startxrefMatches = Array.from(tail.matchAll(/\\bstartxref[\\r\\n\\s]+(\\d+)[\\r\\n\\s]+%%EOF/g));\n  if (startxrefMatches.length === 0) return false;\n  const lastMatch = startxrefMatches[startxrefMatches.length - 1];\n  const startXrefOffset = Number.parseInt(lastMatch[1], 10);\n  if (!Number.isSafeInteger(startXrefOffset) || startXrefOffset <= 8 || startXrefOffset >= data.length - 16) return false;\n\n  const findPdfKeyword = (kw, fromIdx) => {\n    let pos = fromIdx;\n    while (pos < fullStr.length) {\n      const idx = fullStr.indexOf(kw, pos);\n      if (idx < 0) return -1;\n      const prev = idx > 0 ? fullStr.charCodeAt(idx - 1) : 32;\n      const next = idx + kw.length < fullStr.length ? fullStr.charCodeAt(idx + kw.length) : 32;\n      const prevIsToken = prev === 47 || (prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 95;\n      const nextIsToken = (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95;\n      if (!prevIsToken && !nextIsToken) return idx;\n      pos = idx + 1;\n    }\n    return -1;\n  };\n\n  const extractObjAtOffset = (offset, expectedNum, expectedGen) => {\n    if (offset <= 0 || offset >= data.length - 16) return null;\n    const winStart = Math.max(0, offset - 64);\n    const winEnd = Math.min(data.length, offset + 160);\n    const windowStr = fullStr.slice(winStart, winEnd);\n    let bodyStart = -1;\n    let num = expectedNum !== undefined ? expectedNum : -1;\n    let gen = expectedGen !== undefined ? expectedGen : -1;\n\n    if (expectedNum !== undefined && expectedGen !== undefined) {\n      const exactHead = fullStr.slice(offset, Math.min(data.length, offset + 96));\n      const exactMatch = /^[\\r\\n\\s]*(\\d+)\\s+(\\d+)\\s+obj\\b/.exec(exactHead);\n      if (exactMatch && Number.parseInt(exactMatch[1], 10) === expectedNum && Number.parseInt(exactMatch[2], 10) === expectedGen) {\n        bodyStart = offset + exactMatch[0].length;\n      } else {\n        const driftRe = new RegExp('(?:^|[^0-9])(' + expectedNum + ')\\\\s+(' + expectedGen + ')\\\\s+obj\\\\b');\n        const dm = driftRe.exec(windowStr);\n        if (!dm) return null;\n        bodyStart = winStart + dm.index + dm[0].length;\n      }\n    } else {\n      const exactHead = fullStr.slice(offset, Math.min(data.length, offset + 96));\n      const exactMatch = /^[\\r\\n\\s]*(\\d+)\\s+(\\d+)\\s+obj\\b/.exec(exactHead);\n      if (exactMatch) {\n        num = Number.parseInt(exactMatch[1], 10);\n        gen = Number.parseInt(exactMatch[2], 10);\n        bodyStart = offset + exactMatch[0].length;\n      } else {\n        const driftMatch = /(?:^|[\\r\\n\\s])(\\d+)\\s+(\\d+)\\s+obj\\b/.exec(windowStr);\n        if (!driftMatch) return null;\n        num = Number.parseInt(driftMatch[1], 10);\n        gen = Number.parseInt(driftMatch[2], 10);\n        bodyStart = winStart + driftMatch.index + driftMatch[0].length;\n      }\n    }\n\n    const firstEndobj = findPdfKeyword('endobj', bodyStart);\n    if (firstEndobj < 0) return null;\n    const preEndobj = fullStr.slice(bodyStart, firstEndobj);\n    const streamMatch = /(?:^|[^A-Za-z0-9_/])(stream[\\r\\n])/.exec(preEndobj);\n    if (streamMatch && streamMatch[1]) {\n      const streamRelIdx = streamMatch.index + streamMatch[0].length - streamMatch[1].length;\n      const dictBody = preEndobj.slice(0, streamRelIdx);\n      const endstreamIdx = findPdfKeyword('endstream', bodyStart + streamRelIdx + 6);\n      if (endstreamIdx < 0) return null;\n      const realEndobj = findPdfKeyword('endobj', endstreamIdx + 9);\n      if (realEndobj < 0) return null;\n      return { num, gen, body: normalizePdfNames(dictBody) };\n    }\n    return { num, gen, body: normalizePdfNames(preEndobj) };\n  };\n\n  const objMap = new Map();\n  const scannedObjMap = new Map();\n  const scannedDicts = [];\n  const trailerTexts = [];\n  let rootObjKey = null;\n\n  const allObjRe = /\\b(\\d+)\\s+(\\d+)\\s+obj\\b([\\s\\S]*?)\\bendobj\\b/g;\n  let om;\n  while ((om = allObjRe.exec(fullStr)) !== null) {\n    const id = Number.parseInt(om[1], 10);\n    const gen = Number.parseInt(om[2], 10);\n    const fullBody = om[3];\n    const streamMatch = /(?:^|[^A-Za-z0-9_/])(stream[\\r\\n])/.exec(fullBody);\n    const dictOnly = normalizePdfNames(\n      streamMatch && streamMatch[1] ? fullBody.slice(0, streamMatch.index + streamMatch[0].length - streamMatch[1].length) : fullBody,\n    );\n    scannedDicts.push(dictOnly);\n    if (!scannedObjMap.has(String(id) + ':' + String(gen))) {\n      scannedObjMap.set(String(id) + ':' + String(gen), dictOnly);\n    }\n    if (/\\/Type\\s*\\/ObjStm(?![A-Za-z])/.test(dictOnly)) {\n      const nMatch = /\\/N\\s+(\\d+)\\b/.exec(dictOnly);\n      const firstMatch = /\\/First\\s+(\\d+)\\b/.exec(dictOnly);\n      const streamIdx = fullBody.indexOf('stream');\n      const endstreamIdx = fullBody.lastIndexOf('endstream');\n      if (!nMatch || !firstMatch || streamIdx < 0 || endstreamIdx <= streamIdx) return false;\n      const n = Number.parseInt(nMatch[1], 10);\n      const first = Number.parseInt(firstMatch[1], 10);\n      let rawPos = om.index + om[0].indexOf('stream') + 6;\n      if (data[rawPos] === 13 && data[rawPos + 1] === 10) rawPos += 2;\n      else if (data[rawPos] === 10 || data[rawPos] === 13) rawPos += 1;\n      let rawEnd = om.index + om[0].lastIndexOf('endstream');\n      while (rawEnd > rawPos && (data[rawEnd - 1] === 10 || data[rawEnd - 1] === 13)) rawEnd--;\n      if (rawEnd <= rawPos) return false;\n      try {\n        const inflated = zlib.inflateSync(data.subarray(rawPos, rawEnd), { maxOutputLength: 8 * 1024 * 1024 });\n        const headerStr = inflated.subarray(0, first).toString('latin1').trim();\n        const pairs = headerStr.split(/\\s+/);\n        const offsets = [];\n        for (let p = 0; p + 1 < pairs.length && offsets.length < n; p += 2) {\n          offsets.push({ id: Number.parseInt(pairs[p], 10), rel: Number.parseInt(pairs[p + 1], 10) });\n        }\n        for (let j = 0; j < offsets.length; j++) {\n          const startByte = first + offsets[j].rel;\n          const endByte = j + 1 < offsets.length ? first + offsets[j + 1].rel : inflated.length;\n          if (startByte >= first && endByte >= startByte && endByte <= inflated.length) {\n            const innerDict = normalizePdfNames(inflated.subarray(startByte, endByte).toString('latin1'));\n            scannedDicts.push(innerDict);\n            scannedObjMap.set(String(offsets[j].id) + ':0', innerDict);\n          }\n        }\n      } catch {\n        return false;\n      }\n    }\n  }\n\n  const xrefSearchStart = Math.max(0, startXrefOffset - 64);\n  const xrefSearchWindow = fullStr.slice(xrefSearchStart, Math.min(data.length, startXrefOffset + 128));\n  const xrefKwMatch = /(?:^|[\\r\\n\\s])(xref)(?=[\\r\\n\\s])/.exec(xrefSearchWindow);\n\n  if (xrefKwMatch && xrefKwMatch[1]) {\n    const firstXrefOff = xrefSearchStart + xrefKwMatch.index + xrefKwMatch[0].length - xrefKwMatch[1].length;\n    const visitedXref = new Set();\n    let curXrefOff = firstXrefOff;\n    while (curXrefOff !== null && !visitedXref.has(curXrefOff) && visitedXref.size < 8) {\n      visitedXref.add(curXrefOff);\n      if (curXrefOff <= 0 || curXrefOff >= data.length - 16) return false;\n      const winStart = Math.max(0, curXrefOff - 64);\n      const winCheck = fullStr.slice(winStart, Math.min(data.length, curXrefOff + 128));\n      const xm = /(?:^|[\\r\\n\\s])(xref)(?=[\\r\\n\\s])/.exec(winCheck);\n      if (!xm || !xm[1]) return false;\n      const actualXrefOff = winStart + xm.index + xm[0].length - xm[1].length;\n      const xrefText = data.subarray(actualXrefOff, Math.min(data.length, actualXrefOff + 524288)).toString('latin1');\n      const trailerIdx = xrefText.search(/\\btrailer(?:\\s|<<)/);\n      if (trailerIdx < 0) return false;\n      const tablePart = xrefText.slice(0, trailerIdx).trim();\n      const trailerPart = normalizePdfNames(xrefText.slice(trailerIdx));\n      trailerTexts.push(trailerPart);\n      if (/\\/XRefStm\\b/.test(trailerPart)) return false;\n\n      if (!/^xref(?:\\s|$)/.test(tablePart)) return false;\n      const afterXref = tablePart.replace(/^xref\\s*/, '');\n      const lines = afterXref.split(/[\\r\\n]+/).map((l) => l.trim()).filter(Boolean);\n      let idx = 0;\n      let entriesParsed = 0;\n      while (idx < lines.length) {\n        const subMatch = /^(\\d+)\\s+(\\d+)$/.exec(lines[idx]);\n        if (!subMatch) return false;\n        const firstId = Number.parseInt(subMatch[1], 10);\n        const count = Number.parseInt(subMatch[2], 10);\n        idx++;\n        if (idx + count > lines.length) return false;\n        for (let k = 0; k < count; k++) {\n          const entryLine = lines[idx + k];\n          const em = /^(\\d{10})\\s+(\\d{5})\\s+([nf])$/.exec(entryLine);\n          if (!em) return false;\n          if (em[3] === 'n') {\n            const off = Number.parseInt(em[1], 10);\n            const gen = Number.parseInt(em[2], 10);\n            const objId = firstId + k;\n            if (objId === 0 || off === 0) continue;\n            const objKey = String(objId) + ':' + String(gen);\n            if (!objMap.has(objKey)) {\n              const parsed = extractObjAtOffset(off, objId, gen);\n              if (!parsed) return false;\n              objMap.set(objKey, parsed.body);\n              scannedDicts.push(parsed.body);\n            }\n            entriesParsed++;\n          }\n        }\n        idx += count;\n      }\n      if (entriesParsed === 0 && visitedXref.size === 1) return false;\n\n      if (rootObjKey === null) {\n        const rm = /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(trailerPart);\n        if (rm) rootObjKey = String(Number.parseInt(rm[1], 10)) + ':' + String(Number.parseInt(rm[2], 10));\n      }\n      const prevMatch = /\\/Prev\\s+(\\d+)\\b/.exec(trailerPart);\n      curXrefOff = prevMatch ? Number.parseInt(prevMatch[1], 10) : null;\n    }\n  } else {\n    for (const [k, v] of scannedObjMap) objMap.set(k, v);\n    const xrefObj = extractObjAtOffset(startXrefOffset);\n    if (!xrefObj || !/\\/Type\\s*\\/XRef(?![A-Za-z])/.test(xrefObj.body)) return false;\n    trailerTexts.push(xrefObj.body);\n    const normalizedTail = normalizePdfNames(tail);\n    const rm = /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(xrefObj.body) || /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(normalizedTail);\n    if (!rm) return false;\n    rootObjKey = String(Number.parseInt(rm[1], 10)) + ':' + String(Number.parseInt(rm[2], 10));\n  }\n\n  for (const tText of trailerTexts) {\n    if (DANGEROUS_PDF_TOKEN_RE.test(tText)) return false;\n  }\n  for (const dictText of scannedDicts) {\n    if (DANGEROUS_PDF_TOKEN_RE.test(dictText)) return false;\n  }\n\n  const combinedTrailers = trailerTexts.join('\\n');\n  const hasEncryptToken =\n    /\\/Encrypt(?![A-Za-z])/.test(combinedTrailers) ||\n    scannedDicts.some((b) => /\\/Encrypt(?![A-Za-z])/.test(b));\n\n  if (hasEncryptToken) {\n    const encRefs = Array.from(combinedTrailers.matchAll(/\\/Encrypt\\s+(\\d+)\\s+(\\d+)\\s+R\\b/g));\n    const inlineEncs = Array.from(combinedTrailers.matchAll(/\\/Encrypt\\s*<<([\\s\\S]*?)>>/g));\n    if (encRefs.length === 0 && inlineEncs.length === 0) return false;\n    const fileId = parseTrailerFirstId(combinedTrailers) || parseTrailerFirstId(tail);\n    for (const ref of encRefs) {\n      const encKey = String(Number.parseInt(ref[1], 10)) + ':' + String(Number.parseInt(ref[2], 10));\n      const encryptDictBody = objMap.get(encKey) || null;\n      if (!encryptDictBody || !isPermittedEmptyPasswordEncryptDict(encryptDictBody, fileId)) {\n        return false;\n      }\n    }\n    for (const inl of inlineEncs) {\n      if (!inl[1] || !isPermittedEmptyPasswordEncryptDict(inl[1], fileId)) {\n        return false;\n      }\n    }\n  }\n\n  if (rootObjKey === null || !objMap.has(rootObjKey)) return false;\n  const catalogBody = objMap.get(rootObjKey);\n  if (!/\\/Type\\s*\\/Catalog(?![A-Za-z])/.test(catalogBody)) return false;\n  const pagesRefMatch = /\\/Pages\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(catalogBody);\n  if (!pagesRefMatch) return false;\n  const rootPagesKey = String(Number.parseInt(pagesRefMatch[1], 10)) + ':' + String(Number.parseInt(pagesRefMatch[2], 10));\n\n  const visitedNodes = new Set();\n  const queue = [rootPagesKey];\n  let pageCount = 0;\n  while (queue.length > 0 && visitedNodes.size < 500) {\n    const curKey = queue.shift();\n    if (visitedNodes.has(curKey)) return false;\n    visitedNodes.add(curKey);\n    const nodeBody = objMap.get(curKey);\n    if (!nodeBody) return false;\n    if (/\\/Type\\s*\\/Pages(?![A-Za-z])/.test(nodeBody)) {\n      const countMatch = /\\/Count\\s+([1-9]\\d*)\\b/.exec(nodeBody);\n      if (!countMatch) return false;\n      let kidsSource = nodeBody;\n      const directKidsMatch = /\\/Kids\\s*\\[([\\s\\S]*?)\\]/.exec(nodeBody);\n      if (directKidsMatch && directKidsMatch[1] !== undefined) {\n        kidsSource = directKidsMatch[1];\n      } else {\n        const indirectKidsRef = /\\/Kids\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(nodeBody);\n        if (!indirectKidsRef) return false;\n        const kidsKey = String(Number.parseInt(indirectKidsRef[1], 10)) + ':' + String(Number.parseInt(indirectKidsRef[2], 10));\n        const kidsArrayBody = objMap.get(kidsKey);\n        if (!kidsArrayBody) return false;\n        kidsSource = kidsArrayBody;\n      }\n      const kidRefs = Array.from(kidsSource.matchAll(/(\\d+)\\s+(\\d+)\\s+R\\b/g));\n      if (kidRefs.length === 0) return false;\n      for (const kr of kidRefs) {\n        queue.push(String(Number.parseInt(kr[1], 10)) + ':' + String(Number.parseInt(kr[2], 10)));\n      }\n    } else if (/\\/Type\\s*\\/Page(?![A-Za-z])/.test(nodeBody)) {\n      pageCount++;\n    } else {\n      return false;\n    }\n  }\n  return pageCount > 0;\n}\nconst data = Buffer.from(workerData);\nparentPort.postMessage({ ok: check(data) });\n"

export async function validatePdfInIsolatedWorker(
  data: Buffer,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (signal.aborted) throw new LiteratureError('CANCELLED')
  if (!validatePdfStructureSync(data)) return false
  const copy = new Uint8Array(data.length)
  copy.set(data)
  const worker = new Worker(WORKER_SCRIPT, {
    eval: true,
    env: {},
    workerData: copy.buffer,
    transferList: [copy.buffer],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const onAbort = () => {
    void worker.terminate()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const exitPromise = new Promise<void>((resolve) => {
    worker.once('exit', () => resolve())
  })
  try {
    const verdict = await abortable(
      new Promise<boolean>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          void worker.terminate()
          reject(new LiteratureError('TIMEOUT'))
        }, timeoutMs)
        worker.once('message', (msg: { ok?: boolean }) => {
          resolve(msg?.ok === true)
        })
        worker.once('error', () => resolve(false))
        worker.once('exit', (code) => {
          if (code !== 0) resolve(false)
        })
      }),
      signal,
    )
    await worker.terminate()
    await exitPromise
    return verdict
  } catch (error) {
    await worker.terminate().catch(() => {})
    await exitPromise
    if (signal.aborted) throw new LiteratureError('CANCELLED')
    if (timedOut) throw new LiteratureError('TIMEOUT')
    if (error instanceof LiteratureError) throw error
    return false
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export class LiteratureArtifactStore {
  private readonly reservations = new Map<string, StoredReservation>()
  private permitBusy = false
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxTotalSlots: number
  private readonly maxUserSlots: number

  constructor(
    options: {
      now?: () => number
      ttlMs?: number
      maxTotalSlots?: number
      maxUserSlots?: number
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? LITERATURE_ARTIFACT_TTL_MS
    this.maxTotalSlots = options.maxTotalSlots ?? LITERATURE_ARTIFACT_MAX_TOTAL_SLOTS
    this.maxUserSlots = options.maxUserSlots ?? LITERATURE_ARTIFACT_MAX_USER_SLOTS
  }

  close(): void {
    for (const entry of this.reservations.values()) {
      entry.discarded = true
      entry.buffer = null
    }
    this.reservations.clear()
  }

  private sweep(now = this.now()): void {
    for (const [id, entry] of this.reservations) {
      if (entry.discarded || (entry.published && entry.expiresAt <= now)) {
        if (entry.activeReaders === 0) {
          entry.buffer = null
          this.reservations.delete(id)
        }
      }
    }
  }

  /**
   * Stages a PDF buffer under a reservation slot before DB Cookie CAS.
   * Only calling publish() after CAS makes the artifact visible to owner GET.
   */
  async stagePdf(input: {
    userId: number
    filename: string
    data: Buffer
    signal: AbortSignal
    skipWorker?: boolean
  }): Promise<StagedLiteratureArtifact> {
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0)
      throw new LiteratureError('INVALID_INPUT')
    if (input.signal.aborted) throw new LiteratureError('CANCELLED')
    if (
      !Buffer.isBuffer(input.data) ||
      input.data.length < 1 ||
      input.data.length > LITERATURE_ARTIFACT_MAX_BYTES
    )
      throw new LiteratureError('RESPONSE_INVALID')
    if (this.permitBusy) throw new LiteratureError('CAPACITY')
    this.permitBusy = true
    let reservation: StoredReservation | undefined
    try {
      this.sweep()
      if (this.reservations.size >= this.maxTotalSlots) throw new LiteratureError('CAPACITY')
      let userCount = 0
      for (const item of this.reservations.values()) {
        if (item.userId === input.userId) userCount++
      }
      if (userCount >= this.maxUserSlots) throw new LiteratureError('CAPACITY')

      const artifactId = randomUUID()
      const safeFilename = sanitizeLiteraturePdfFilename(input.filename)
      const ownedBuffer = Buffer.allocUnsafe(input.data.length)
      input.data.copy(ownedBuffer, 0, 0, input.data.length)

      reservation = {
        id: artifactId,
        userId: input.userId,
        buffer: ownedBuffer,
        bytes: ownedBuffer.length,
        filename: safeFilename,
        published: false,
        discarded: false,
        expiresAt: 0,
        activeReaders: 0,
      }
      this.reservations.set(artifactId, reservation)

      const valid = input.skipWorker
        ? validatePdfStructureSync(ownedBuffer)
        : await validatePdfInIsolatedWorker(ownedBuffer, input.signal)
      if (!valid) {
        reservation.discarded = true
        reservation.buffer = null
        this.reservations.delete(artifactId)
        throw new LiteratureError('RESPONSE_INVALID')
      }

      const result: LiteratureDownloadResult = Object.freeze({
        artifactId,
        filename: safeFilename,
        mimeType: 'application/pdf',
        bytes: ownedBuffer.length,
      })

      const staged = reservation
      return {
        artifactId,
        result,
        publish: () => {
          if (staged.discarded || staged.published || !staged.buffer) return
          staged.published = true
          staged.expiresAt = this.now() + this.ttlMs
        },
        discard: () => {
          staged.discarded = true
          staged.buffer = null
          this.reservations.delete(artifactId)
        },
      }
    } catch (error) {
      if (reservation) {
        reservation.discarded = true
        reservation.buffer = null
        this.reservations.delete(reservation.id)
      }
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('RESPONSE_INVALID')
    } finally {
      this.permitBusy = false
    }
  }

  /**
   * Synchronous owner-scoped read for GET /api/plugins/literature-db/artifacts/:artifactId.
   */
  read(userId: number, artifactId: string): PublishedLiteratureArtifact | null {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !OPAQUE_ID_RE.test(artifactId)) return null
    if (this.permitBusy) throw new LiteratureError('CAPACITY')
    const now = this.now()
    this.sweep(now)
    const entry = this.reservations.get(artifactId)
    if (
      !entry ||
      !entry.published ||
      entry.discarded ||
      entry.userId !== userId ||
      entry.expiresAt <= now ||
      !entry.buffer
    ) {
      return null
    }
    return {
      artifactId: entry.id,
      userId: entry.userId,
      filename: entry.filename,
      mimeType: 'application/pdf',
      bytes: entry.bytes,
      data: entry.buffer.subarray(0, entry.bytes),
      expiresAt: entry.expiresAt,
    }
  }
}
