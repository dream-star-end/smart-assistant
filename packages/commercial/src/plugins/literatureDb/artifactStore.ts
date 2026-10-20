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
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import zlib from 'node:zlib'
import { LiteratureError, abortable } from './errors.js'

export const LITERATURE_ARTIFACT_MAX_BYTES = 26_214_400
export const LITERATURE_ARTIFACT_TTL_MS = 10 * 60 * 1000
export const LITERATURE_ARTIFACT_MAX_TOTAL_SLOTS = 4
export const LITERATURE_ARTIFACT_MAX_USER_SLOTS = 2

const OPAQUE_ID_RE = /^[A-Za-z0-9-]{16,128}$/

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

/**
 * Fast synchronous structural check before isolated worker metadata check:
 * must start with %PDF-1.x or %PDF-2.x, contain %%EOF, have at least one /Page or /Pages object,
 * and not declare /Encrypt.
 */
export function validatePdfStructureSync(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 64 || data.length > LITERATURE_ARTIFACT_MAX_BYTES)
    return false
  const head = data.subarray(0, Math.min(data.length, 1024)).toString('latin1')
  if (!/^%PDF-[12]\.\d[\r\n]/.test(head)) return false
  if (/<(?:!doctype|html|head|body|script|iframe)\b/i.test(head)) return false

  const fullStr = data.toString('latin1')
  if (/\/Encrypt(?![A-Za-z])/.test(fullStr)) return false

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
      pos = idx + kw.length
    }
    return -1
  }

  const extractObjAtOffset = (
    offset: number,
    expectedNum?: number,
    expectedGen?: number,
  ): { num: number; gen: number; body: string } | null => {
    if (offset <= 0 || offset >= data.length - 10) return null
    const headSlice = fullStr.slice(offset, Math.min(fullStr.length, offset + 128))
    const hm = /^[\r\n\s]*(\d+)\s+(\d+)\s+obj\b/.exec(headSlice)
    if (!hm?.[1] || !hm[2]) return null
    const num = Number.parseInt(hm[1], 10)
    const gen = Number.parseInt(hm[2], 10)
    if (expectedNum !== undefined && num !== expectedNum) return null
    if (expectedGen !== undefined && gen !== expectedGen) return null
    const bodyStart = offset + hm[0].length
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
      return { num, gen, body: dictBody }
    }
    return { num, gen, body: preEndobj }
  }

  const objMap = new Map<string, string>()
  let rootObjKey: string | null = null

  const probeAtStartXref = data
    .subarray(startXrefOffset, Math.min(data.length, startXrefOffset + 128))
    .toString('latin1')
  if (/^[\r\n\s]*xref[\r\n\s]/.test(probeAtStartXref)) {
    const visitedXref = new Set<number>()
    let curXrefOff: number | null = startXrefOffset
    while (curXrefOff !== null && !visitedXref.has(curXrefOff) && visitedXref.size < 8) {
      visitedXref.add(curXrefOff)
      if (curXrefOff <= 0 || curXrefOff >= data.length - 16) return false
      const xrefText = data
        .subarray(curXrefOff, Math.min(data.length, curXrefOff + 524288))
        .toString('latin1')
      const trailerIdx = xrefText.search(/\btrailer(?:\s|<<)/)
      if (trailerIdx < 0) return false
      const tablePart = xrefText.slice(0, trailerIdx)
      const trailerPart = xrefText.slice(trailerIdx)

      const lines = tablePart
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter(Boolean)
      if (lines[0] !== 'xref') return false
      let idx = 1
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
            const objKey = `${objId}:${gen}`
            if (!objMap.has(objKey)) {
              const parsed = extractObjAtOffset(off, objId, gen)
              if (!parsed) return false
              objMap.set(objKey, parsed.body)
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
    const xrefObj = extractObjAtOffset(startXrefOffset)
    if (!xrefObj || !/\/Type\s*\/XRef(?![A-Za-z])/.test(xrefObj.body)) return false
    const rm =
      /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(xrefObj.body) ?? /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(tail)
    if (!rm?.[1] || !rm[2]) return false
    rootObjKey = `${Number.parseInt(rm[1], 10)}:${Number.parseInt(rm[2], 10)}`

    const objRe = /\b(\d+)\s+(\d+)\s+obj\b([\s\S]*?)\bendobj\b/g
    let m: RegExpExecArray | null
    while ((m = objRe.exec(fullStr)) !== null) {
      const id = Number.parseInt(m[1]!, 10)
      const gen = Number.parseInt(m[2]!, 10)
      const body = m[3]!
      objMap.set(`${id}:${gen}`, body)
      if (/\/Type\s*\/ObjStm(?![A-Za-z])/.test(body)) {
        const nMatch = /\/N\s+(\d+)\b/.exec(body)
        const firstMatch = /\/First\s+(\d+)\b/.exec(body)
        const streamIdx = body.indexOf('stream')
        const endstreamIdx = body.lastIndexOf('endstream')
        if (nMatch?.[1] && firstMatch?.[1] && streamIdx >= 0 && endstreamIdx > streamIdx) {
          const n = Number.parseInt(nMatch[1], 10)
          const first = Number.parseInt(firstMatch[1], 10)
          let rawPos = m.index + m[0].indexOf('stream') + 6
          if (data[rawPos] === 13 && data[rawPos + 1] === 10) rawPos += 2
          else if (data[rawPos] === 10 || data[rawPos] === 13) rawPos += 1
          let rawEnd = m.index + m[0].lastIndexOf('endstream')
          while (rawEnd > rawPos && (data[rawEnd - 1] === 10 || data[rawEnd - 1] === 13)) {
            rawEnd--
          }
          if (rawEnd > rawPos) {
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
                  objMap.set(
                    `${offsets[j]!.id}:0`,
                    inflated.subarray(startByte, endByte).toString('latin1'),
                  )
                }
              }
            } catch {
              // ignore individual compressed stream failure
            }
          }
        }
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

const WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const zlib = require('node:zlib');
const data = Buffer.from(workerData);
function check(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64 || buf.length > 26214400) return false;
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('latin1');
  if (!/^%PDF-[12]\\.\\d[\\r\\n]/.test(head)) return false;
  if (/<(?:!doctype|html|head|body|script|iframe)\\b/i.test(head)) return false;

  const fullStr = buf.toString('latin1');
  if (/\\/Encrypt(?![A-Za-z])/.test(fullStr)) return false;

  const tailLen = Math.min(buf.length, 65536);
  const tail = buf.subarray(buf.length - tailLen).toString('latin1');
  const startxrefMatches = Array.from(tail.matchAll(/\\bstartxref[\\r\\n\\s]+(\\d+)[\\r\\n\\s]+%%EOF/g));
  if (startxrefMatches.length === 0) return false;
  const lastMatch = startxrefMatches[startxrefMatches.length - 1];
  const startXrefOffset = Number.parseInt(lastMatch[1], 10);
  if (!Number.isSafeInteger(startXrefOffset) || startXrefOffset <= 8 || startXrefOffset >= buf.length - 16) return false;

  const findPdfKeyword = (kw, fromIdx) => {
    let pos = fromIdx;
    while (pos < fullStr.length) {
      const idx = fullStr.indexOf(kw, pos);
      if (idx < 0) return -1;
      const prev = idx > 0 ? fullStr.charCodeAt(idx - 1) : 32;
      const next = idx + kw.length < fullStr.length ? fullStr.charCodeAt(idx + kw.length) : 32;
      const prevIsToken = prev === 47 || (prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || prev === 95;
      const nextIsToken = (next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95;
      if (!prevIsToken && !nextIsToken) return idx;
      pos = idx + kw.length;
    }
    return -1;
  };

  const extractObjAtOffset = (offset, expectedNum, expectedGen) => {
    if (offset <= 0 || offset >= buf.length - 10) return null;
    const headSlice = fullStr.slice(offset, Math.min(fullStr.length, offset + 128));
    const hm = /^[\\r\\n\\s]*(\\d+)\\s+(\\d+)\\s+obj\\b/.exec(headSlice);
    if (!hm || !hm[1] || !hm[2]) return null;
    const num = Number.parseInt(hm[1], 10);
    const gen = Number.parseInt(hm[2], 10);
    if (expectedNum !== undefined && num !== expectedNum) return null;
    if (expectedGen !== undefined && gen !== expectedGen) return null;
    const bodyStart = offset + hm[0].length;
    const firstEndobj = findPdfKeyword('endobj', bodyStart);
    if (firstEndobj < 0) return null;
    const preEndobj = fullStr.slice(bodyStart, firstEndobj);
    const streamMatch = /(?:^|[^A-Za-z0-9_/])(stream[\\r\\n])/.exec(preEndobj);
    if (streamMatch && streamMatch[1]) {
      const streamRelIdx = streamMatch.index + streamMatch[0].length - streamMatch[1].length;
      const dictBody = preEndobj.slice(0, streamRelIdx);
      const endstreamIdx = findPdfKeyword('endstream', bodyStart + streamRelIdx + 6);
      if (endstreamIdx < 0) return null;
      const realEndobj = findPdfKeyword('endobj', endstreamIdx + 9);
      if (realEndobj < 0) return null;
      return { num, gen, body: dictBody };
    }
    return { num, gen, body: preEndobj };
  };

  const objMap = new Map();
  let rootObjKey = null;

  const probeAtStartXref = buf.subarray(startXrefOffset, Math.min(buf.length, startXrefOffset + 128)).toString('latin1');
  if (/^[\\r\\n\\s]*xref[\\r\\n\\s]/.test(probeAtStartXref)) {
    const visitedXref = new Set();
    let curXrefOff = startXrefOffset;
    while (curXrefOff !== null && !visitedXref.has(curXrefOff) && visitedXref.size < 8) {
      visitedXref.add(curXrefOff);
      if (curXrefOff <= 0 || curXrefOff >= buf.length - 16) return false;
      const xrefText = buf.subarray(curXrefOff, Math.min(buf.length, curXrefOff + 524288)).toString('latin1');
      const trailerIdx = xrefText.search(/\\btrailer(?:\\s|<<)/);
      if (trailerIdx < 0) return false;
      const tablePart = xrefText.slice(0, trailerIdx);
      const trailerPart = xrefText.slice(trailerIdx);

      const lines = tablePart.split(/[\\r\\n]+/).map((l) => l.trim()).filter(Boolean);
      if (lines[0] !== 'xref') return false;
      let idx = 1;
      let entriesParsed = 0;
      while (idx < lines.length) {
        const subMatch = /^(\\d+)\\s+(\\d+)$/.exec(lines[idx]);
        if (!subMatch) return false;
        const firstId = Number.parseInt(subMatch[1], 10);
        const count = Number.parseInt(subMatch[2], 10);
        idx++;
        if (idx + count > lines.length) return false;
        for (let k = 0; k < count; k++) {
          const entryLine = lines[idx + k];
          const em = /^(\\d{10})\\s+(\\d{5})\\s+([nf])$/.exec(entryLine);
          if (!em) return false;
          if (em[3] === 'n') {
            const off = Number.parseInt(em[1], 10);
            const gen = Number.parseInt(em[2], 10);
            const objId = firstId + k;
            const objKey = String(objId) + ':' + String(gen);
            if (!objMap.has(objKey)) {
              const parsed = extractObjAtOffset(off, objId, gen);
              if (!parsed) return false;
              objMap.set(objKey, parsed.body);
            }
            entriesParsed++;
          }
        }
        idx += count;
      }
      if (entriesParsed === 0 && visitedXref.size === 1) return false;

      if (rootObjKey === null) {
        const rm = /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(trailerPart);
        if (rm) rootObjKey = String(Number.parseInt(rm[1], 10)) + ':' + String(Number.parseInt(rm[2], 10));
      }
      const prevMatch = /\\/Prev\\s+(\\d+)\\b/.exec(trailerPart);
      curXrefOff = prevMatch ? Number.parseInt(prevMatch[1], 10) : null;
    }
  } else {
    const xrefObj = extractObjAtOffset(startXrefOffset);
    if (!xrefObj || !/\\/Type\\s*\\/XRef(?![A-Za-z])/.test(xrefObj.body)) return false;
    const rm = /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(xrefObj.body) || /\\/Root\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(tail);
    if (!rm) return false;
    rootObjKey = String(Number.parseInt(rm[1], 10)) + ':' + String(Number.parseInt(rm[2], 10));

    const objRe = /\\b(\\d+)\\s+(\\d+)\\s+obj\\b([\\s\\S]*?)\\bendobj\\b/g;
    let m;
    while ((m = objRe.exec(fullStr)) !== null) {
      const id = Number.parseInt(m[1], 10);
      const gen = Number.parseInt(m[2], 10);
      const body = m[3];
      objMap.set(String(id) + ':' + String(gen), body);
      if (/\\/Type\\s*\\/ObjStm(?![A-Za-z])/.test(body)) {
        const nMatch = /\\/N\\s+(\\d+)\\b/.exec(body);
        const firstMatch = /\\/First\\s+(\\d+)\\b/.exec(body);
        const streamIdx = body.indexOf('stream');
        const endstreamIdx = body.lastIndexOf('endstream');
        if (nMatch && firstMatch && streamIdx >= 0 && endstreamIdx > streamIdx) {
          const n = Number.parseInt(nMatch[1], 10);
          const first = Number.parseInt(firstMatch[1], 10);
          let rawPos = m.index + m[0].indexOf('stream') + 6;
          if (buf[rawPos] === 13 && buf[rawPos + 1] === 10) rawPos += 2;
          else if (buf[rawPos] === 10 || buf[rawPos] === 13) rawPos += 1;
          let rawEnd = m.index + m[0].lastIndexOf('endstream');
          while (rawEnd > rawPos && (buf[rawEnd - 1] === 10 || buf[rawEnd - 1] === 13)) rawEnd--;
          if (rawEnd > rawPos) {
            try {
              const inflated = zlib.inflateSync(buf.subarray(rawPos, rawEnd), { maxOutputLength: 8 * 1024 * 1024 });
              const headerStr = inflated.subarray(0, first).toString('latin1').trim();
              const pairs = headerStr.split(/\\s+/);
              const offsets = [];
              for (let p = 0; p + 1 < pairs.length && offsets.length < n; p += 2) {
                offsets.push({ id: Number.parseInt(pairs[p], 10), rel: Number.parseInt(pairs[p + 1], 10) });
              }
              for (let j = 0; j < offsets.length; j++) {
                const startByte = first + offsets[j].rel;
                const endByte = j + 1 < offsets.length ? first + offsets[j + 1].rel : inflated.length;
                if (startByte >= first && endByte >= startByte && endByte <= inflated.length) {
                  objMap.set(String(offsets[j].id) + ':0', inflated.subarray(startByte, endByte).toString('latin1'));
                }
              }
            } catch {}
          }
        }
      }
    }
  }

  if (rootObjKey === null || !objMap.has(rootObjKey)) return false;
  const catalogBody = objMap.get(rootObjKey);
  if (!/\\/Type\\s*\\/Catalog(?![A-Za-z])/.test(catalogBody)) return false;
  const pagesRefMatch = /\\/Pages\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(catalogBody);
  if (!pagesRefMatch) return false;
  const rootPagesKey = String(Number.parseInt(pagesRefMatch[1], 10)) + ':' + String(Number.parseInt(pagesRefMatch[2], 10));

  const visitedNodes = new Set();
  const queue = [rootPagesKey];
  let pageCount = 0;
  while (queue.length > 0 && visitedNodes.size < 500) {
    const curKey = queue.shift();
    if (visitedNodes.has(curKey)) return false;
    visitedNodes.add(curKey);
    const nodeBody = objMap.get(curKey);
    if (!nodeBody) return false;
    if (/\\/Type\\s*\\/Pages(?![A-Za-z])/.test(nodeBody)) {
      const countMatch = /\\/Count\\s+([1-9]\\d*)\\b/.exec(nodeBody);
      if (!countMatch) return false;
      let kidsSource = nodeBody;
      const directKidsMatch = /\\/Kids\\s*\\[([\\s\\S]*?)\\]/.exec(nodeBody);
      if (directKidsMatch && directKidsMatch[1] !== undefined) {
        kidsSource = directKidsMatch[1];
      } else {
        const indirectKidsRef = /\\/Kids\\s+(\\d+)\\s+(\\d+)\\s+R\\b/.exec(nodeBody);
        if (!indirectKidsRef) return false;
        const kidsKey = String(Number.parseInt(indirectKidsRef[1], 10)) + ':' + String(Number.parseInt(indirectKidsRef[2], 10));
        const kidsArrayBody = objMap.get(kidsKey);
        if (!kidsArrayBody) return false;
        kidsSource = kidsArrayBody;
      }
      const kidRefs = Array.from(kidsSource.matchAll(/(\\d+)\\s+(\\d+)\\s+R\\b/g));
      if (kidRefs.length === 0) return false;
      for (const kr of kidRefs) {
        queue.push(String(Number.parseInt(kr[1], 10)) + ':' + String(Number.parseInt(kr[2], 10)));
      }
    } else if (/\\/Type\\s*\\/Page(?![A-Za-z])/.test(nodeBody)) {
      pageCount++;
    } else {
      return false;
    }
  }
  return pageCount > 0;
}
parentPort.postMessage({ ok: check(data) });
`

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
