/**
 * 上传图片附件的 prompt 提示。纯函数,供 inboundDispatch 注入、单测锁文案。
 *
 * 非原生多模态模型已从目录下线;这里只提示用引擎原生图像能力读图,
 * oc-vision CLI 已下线。
 */

export type ImageAttachmentHintPath = {
  path: string
  mimeType: string
  sizeHint: string
  name: string
}

export type ImageAttachmentHintOpts = {
  paths: ImageAttachmentHintPath[]
}

const READ_NATIVE =
  '用 Read 工具读图片路径(原生多模态 provider 会直接看到图像)。'
const UNAVAILABLE = '如果当前 provider 不支持图片识别,告诉用户。'

export function buildImageAttachmentHint(opts: ImageAttachmentHintOpts): string {
  const lines: string[] = ['用户附带了以下图片(已保存到服务器本地):']
  for (const ip of opts.paths) {
    lines.push(`- \`${ip.path}\` (${ip.mimeType}, ${ip.sizeHint}, 原名: ${ip.name})`)
  }
  lines.push('')
  lines.push('如果需要看图片内容:')
  lines.push(`1. ${READ_NATIVE}`)
  lines.push(`2. ${UNAVAILABLE}`)
  return lines.join('\n')
}
