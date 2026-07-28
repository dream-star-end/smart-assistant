import {
  MediaFileType,
  getMaxUploadSize,
} from '@tencent-connect/qqbot-nodejs'

import {
  makeWechatOutboundMediaResolver,
  type OutboundMediaResolverDeps,
  type ResolvedWechatOutboundMedia,
} from '../wechat/outboundMedia.js'
import type { IlinkMediaPart } from '../wechat/types.js'

const QQ_NATIVE_VOICE_EXTENSIONS = new Set(['wav', 'mp3', 'silk'])

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
