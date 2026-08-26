/**
 * promptInput — text-only 底座(grok/cursor/zcode)的多模态输入降级(P0-2)。
 *
 * 这些底座把 TurnParams.input 拍平成纯文本 prompt。图片等携带 base64 数据的
 * 二进制 block 绝不允许 JSON.stringify 进 prompt:那会静默塞进几 MB 的乱码
 * (烧 token、常直接超 maxPromptBytes),用户还以为模型"看到了"图片。
 * 统一替换为占位文本;各 adapter 另行决定是否向前端发可见提示。
 */
import type { TurnParams } from './engineAdapter.js'

export const BINARY_BLOCK_OMITTED_NOTICE =
  '[图片附件已省略:当前模型底座不支持图片输入,请改用支持视觉的模型或让平台以 understand_image 工具处理]'

type InputBlock = { type: string; [k: string]: unknown }

/** image block,或其它携带 base64 数据源的二进制 block(document 等)。 */
export function isBinaryInputBlock(block: InputBlock): boolean {
  if (block.type === 'image') return true
  const source = block.source
  return (
    source !== null &&
    typeof source === 'object' &&
    (source as Record<string, unknown>).type === 'base64' &&
    typeof (source as Record<string, unknown>).data === 'string'
  )
}

/** 本 turn 输入里将被占位替换的二进制 block 数(0 = 无需提示)。 */
export function countBinaryInputBlocks(input: TurnParams['input']): number {
  if (typeof input === 'string') return 0
  return input.filter((block) => isBinaryInputBlock(block)).length
}
