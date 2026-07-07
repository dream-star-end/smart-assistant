/**
 * oc-vision — 容器内识图 CLI(纯文本模型/需要看图时的兜底)。
 *
 * 用法(baseline skill oc-vision 文档化):
 *   oc-vision understand <image_file> [--prompt "问题"]
 *
 * 复用 mcpVisionServer 的 resolveVisionInput + runVision 核心(与旧 openclaude-vision
 * MCP 同一后端:默认 MiniMax-M3,经容器 internal anthropic proxy;OPENCLAUDE_VISION_BACKEND=codex
 * 时走 gpt-5.5)。**一次性进程,无常驻 stdio 传输** —— 取代旧的常驻 MCP stdio server
 * (被 console 污染 / 崩溃即整条传输死掉、codex 死等 turn 被掐的脆弱点)。
 *
 * 只支持容器内本地图片路径(gateway 保存在 uploads 目录下的),不支持 URL(防 SSRF,
 * 由 resolveVisionInput 强制)。输出:识图文本直接写 stdout(非 JSON);错误 → stderr + exit 1。
 */
import { resolveVisionInput, runVision } from './mcpVisionServer.js'
import { fail, parseFlags } from './ocResearchClient.js'

const TOOL = 'oc-vision'

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd !== 'understand') {
    fail(TOOL, 'usage: oc-vision understand <image_file> [--prompt "..."]')
  }
  const { positional, flags } = parseFlags(rest)
  const imageFile = positional[0]
  if (!imageFile) fail(TOOL, 'understand <image_file> [--prompt "..."]')
  // 字段名对齐 VisionToolArgs(image_file / prompt);prompt 缺省时为 undefined,
  // resolveVisionInput 自会回落到"描述图片并含可见文字"的默认提问。
  const input = resolveVisionInput({ image_file: imageFile, prompt: flags.prompt })
  const text = await runVision(input)
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)))
