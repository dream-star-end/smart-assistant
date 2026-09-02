/**
 * 上传图片附件的 prompt 提示。纯函数,供 server.ts 注入、单测锁文案顺序。
 *
 * 只有「确定纯文本」才把 oc-vision CLI 排第 1;其余(含 catalog supportsVision=false
 * 但引擎可能经 Read 原生看图的 cursor 家族)先 Read,看不到再 CLI 兜底。
 * hasUnderstandImage=false 时保持历史文案(只提 Read,不提 CLI)。
 */

export type ImageAttachmentHintPath = {
  path: string
  mimeType: string
  sizeHint: string
  name: string
}

export type ImageAttachmentHintOpts = {
  paths: ImageAttachmentHintPath[]
  textOnlyDefinite: boolean
  hasUnderstandImage: boolean
}

const READ_NATIVE =
  '用 Read 工具读图片路径(原生多模态 provider 会直接看到图像)。'
const READ_FIRST =
  '用 Read 工具直接读图(原生多模态直接可见)。'
const CLI_FIRST =
  '优先用 Bash 调 `oc-vision understand <图片本地绝对路径> --prompt "<问题>"` 命令识图(纯文本模型看不到图时的兜底;细节见 `skill_view("oc-vision")`)。'
const CLI_FALLBACK =
  '若 Read 返回的不是图像内容/提示图片被省略/看不到图,再用 Bash 调 `oc-vision understand <图片本地绝对路径> --prompt "<问题>"` 兜底(细节见 `skill_view("oc-vision")`)。'
const UNAVAILABLE = '如果都不可用,告诉用户当前 provider 不支持图片识别。'

export function buildImageAttachmentHint(opts: ImageAttachmentHintOpts): string {
  const { paths, textOnlyDefinite, hasUnderstandImage } = opts
  const lines: string[] = ['用户附带了以下图片(已保存到服务器本地):']
  for (const ip of paths) {
    lines.push(`- \`${ip.path}\` (${ip.mimeType}, ${ip.sizeHint}, 原名: ${ip.name})`)
  }
  lines.push('')
  lines.push('如果需要看图片内容,按以下顺序尝试:')
  let step = 1
  if (hasUnderstandImage && textOnlyDefinite) {
    lines.push(`${step}. ${CLI_FIRST}`)
    step++
    lines.push(`${step}. ${READ_NATIVE}`)
    step++
    lines.push(`${step}. ${UNAVAILABLE}`)
  } else if (hasUnderstandImage) {
    lines.push(`${step}. ${READ_FIRST}`)
    step++
    lines.push(`${step}. ${CLI_FALLBACK}`)
    step++
    lines.push(`${step}. ${UNAVAILABLE}`)
  } else {
    lines.push(`${step}. ${READ_NATIVE}`)
    step++
    lines.push(`${step}. ${UNAVAILABLE}`)
  }
  return lines.join('\n')
}
