import { basename } from 'node:path'
import { MediaFileType, getMaxUploadSize } from '@tencent-connect/qqbot-nodejs'

import {
  type OutboundMediaResolverDeps,
  type ResolvedWechatOutboundMedia,
  classifyWechatMediaFilename,
  makeWechatOutboundMediaResolver,
} from '../wechat/outboundMedia.js'
import type { IlinkMediaPart } from '../wechat/types.js'

const QQ_NATIVE_VOICE_EXTENSIONS = new Set(['wav', 'mp3', 'silk'])
const QQ_CONTAINER_MEDIA_RE =
  /(?:`)?(\/home\/agent\/\.openclaude\/(?:uploads|generated)\/([^\s`"'<>/\\]{1,260}\.[A-Za-z0-9]+))(?:`)?(?=$|[\s`"'<>，。！？、；：,.!?;:)）\]}】])/gu

export type QqOutboundMediaPart = IlinkMediaPart
export type ResolvedQqOutboundMedia = ResolvedWechatOutboundMedia
export type ResolveQqOutboundMediaPartFn = (args: {
  bindingUserId: string
  part: QqOutboundMediaPart
}) => Promise<ResolvedQqOutboundMedia>

export class QqOutboundMediaTooLargeError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage)
    this.name = 'QqOutboundMediaTooLargeError'
  }
}

export class QqOutboundMediaFormatError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage)
    this.name = 'QqOutboundMediaFormatError'
  }
}

export function qqUnsupportedMediaFormat(filename: string): QqOutboundMediaFormatError {
  return new QqOutboundMediaFormatError(
    `QQ 不支持“${filename}”的当前媒体格式，请在 OpenClaude 网页会话中下载。`,
  )
}

export function expandTextWithQqMediaParts(text: string): {
  text: string
  media: QqOutboundMediaPart[]
} {
  const media: QqOutboundMediaPart[] = []
  let out = ''
  let last = 0
  for (const match of text.matchAll(QQ_CONTAINER_MEDIA_RE)) {
    const raw = match[0] ?? ''
    const containerPath = match[1] ?? ''
    const filename = basename(match[2] ?? '')
    const start = match.index ?? 0
    out += text.slice(last, start)
    last = start + raw.length
    if (!isSafeQqMediaBasename(filename)) {
      out += raw
      continue
    }
    const classified = classifyWechatMediaFilename(filename)
    const type = normalizeQqMediaKind(classified?.kind ?? 'file', filename)
    media.push({
      type,
      containerPath,
      filename,
      mimeType: classified?.mimeType ?? 'application/octet-stream',
    })
  }
  out += text.slice(last)
  return {
    text: compactTextAfterMediaRemoval(out),
    media,
  }
}

export function makeQqOutboundMediaResolver(
  deps: OutboundMediaResolverDeps,
): ResolveQqOutboundMediaPartFn {
  const resolveWechatMedia = makeWechatOutboundMediaResolver(deps)
  return async (args) => {
    let resolved: ResolvedWechatOutboundMedia
    try {
      resolved = await resolveWechatMedia(args)
    } catch (err) {
      if (err instanceof Error && err.message === 'outbound media exceeds size limit') {
        throw tooLarge(args.part.filename, normalizeQqMediaKind(args.part.type, args.part.filename))
      }
      throw err
    }
    const kind = normalizeQqMediaKind(resolved.kind, resolved.filename)
    const maxBytes = getMaxUploadSize(qqMediaFileType(kind))
    if (resolved.content.length > maxBytes) {
      throw tooLarge(resolved.filename, kind)
    }
    return { ...resolved, kind }
  }
}

export function normalizeQqMediaKind(
  kind: QqOutboundMediaPart['type'],
  filename: string,
): QqOutboundMediaPart['type'] {
  if (kind !== 'voice') return kind
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return QQ_NATIVE_VOICE_EXTENSIONS.has(extension) ? 'voice' : 'file'
}

export function qqMediaFileType(kind: QqOutboundMediaPart['type']): MediaFileType {
  switch (kind) {
    case 'image':
      return MediaFileType.IMAGE
    case 'video':
      return MediaFileType.VIDEO
    case 'voice':
      return MediaFileType.VOICE
    case 'file':
      return MediaFileType.FILE
  }
}

function tooLarge(
  filename: string,
  kind: QqOutboundMediaPart['type'],
): QqOutboundMediaTooLargeError {
  const maxMb = getMaxUploadSize(qqMediaFileType(kind)) / (1024 * 1024)
  return new QqOutboundMediaTooLargeError(
    `“${filename}”超过 QQ ${qqMediaLabel(kind)} ${maxMb} MB 上限，请在 OpenClaude 网页会话中下载。`,
  )
}

function qqMediaLabel(kind: QqOutboundMediaPart['type']): string {
  switch (kind) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'voice':
      return '语音'
    case 'file':
      return '文件'
  }
}

function isSafeQqMediaBasename(filename: string): boolean {
  if (filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\')) {
    return false
  }
  const points = Array.from(filename)
  return (
    points.length <= 180 &&
    points.every((char) => {
      const code = char.codePointAt(0) ?? 0
      return code > 31 && code !== 127
    })
  )
}

function compactTextAfterMediaRemoval(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
