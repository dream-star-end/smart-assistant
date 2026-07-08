/**
 * oc-figcheck — 出图质量门 + vision 回看闭环(容器内一次性 CLI)。
 *
 * 科研出图长期是"开环盲画":agent 一次性写 matplotlib/渲染代码出图,看不到渲染结果,
 * 于是子图重叠、标签被画布裁切、图例遮数据、取景过空(主体飘在大片空白里)、背景色
 * 异常(整张绿/黄)这类**肉眼一看就知道**的翻车,agent 全然不知,只能靠用户反复"再改
 * 一版"(实测有用户为一张 CAD 装置图手动迭代 7 版)。本工具把出图变成**闭环**:
 *
 *   出图 → oc-figcheck → 确定性质量门 + vision 审图 → 拿到 PASS/WARN/FAIL + 问题清单
 *        → agent 据此改代码重画 → 再 figcheck,直到 PASS。
 *
 * 两层检查:
 *   1) 确定性(不靠模型,Node 读 PNG 字节 + 可选 Pillow 像素统计):分辨率/DPI、
 *      主背景占比(取景过空)、背景主色是否异常(非中性)、画布边缘内容比例(元素被裁)。
 *      这些低级翻车确定性一抓一个准,不消耗模型额度。
 *   2) vision 审图(复用 mcpVisionServer.runVision,默认 MiniMax-M3 后端;实测其对
 *      科研图版式缺陷识别准确):按图类型给"顶刊审稿人"prompt,逐条找会被审稿挑剔或
 *      影响理解的问题。
 *
 * 用法(baseline skill scientific-figures 文档化):
 *   oc-figcheck <image.png> [--kind figure|schematic|network|3d|composite] [--focus "..."]
 * 输出:JSON(确定性检查 + vision 审图 + 汇总 verdict),末行单独打印 verdict 供程序判读。
 *
 * 图片路径必须落在 agent 可信产物区(uploads/generated/research;见 mcpVisionServer
 * 的 VISION_IMAGE_ROOTS),与 oc-vision 同一 SSRF 边界。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolveVisionInput, runVision } from './mcpVisionServer.js'
import { fail, parseFlags } from './ocResearchClient.js'

const TOOL = 'oc-figcheck'

type FigKind = 'figure' | 'schematic' | 'network' | '3d' | 'composite'
const KINDS: readonly FigKind[] = ['figure', 'schematic', 'network', '3d', 'composite']

// 确定性阈值(印刷/报告级下限;偏保守,只对明显不达标的报警,不误伤)
const MIN_W = 1000 // 像素宽下限:再小放进 A4 报告会糊
const MIN_H = 700
const MIN_DPI = 200 // savefig 没设 dpi(默认 100)会被抓
const TARGET_DPI = 300
const MONO_BG_MAX = 0.92 // 单一背景色占比上限:超过=主体太小/取景过空/物体飘散
const EDGE_INK_MAX = 0.14 // 画布最外圈"内容像素"比例上限:超过=元素贴边/被裁切风险
// 中性背景:白/浅灰/深灰(论文图常见)。主背景落在灰阶附近才算正常,否则疑似渲染异常
// (整张绿/黄之类)。用 RGB 通道极差判断"是否接近灰阶"。
const BG_CHROMA_MAX = 42 // 主背景色 max(R,G,B)-min(R,G,B) 上限;超过=明显偏色

type PngMeta = { width: number; height: number; dpi: number | null }

/** 读 PNG 的 IHDR(宽高)+ pHYs(DPI)。非 PNG(如 jpg)返回 null,跳过尺寸类检查。 */
function readPngMeta(buf: Buffer): PngMeta | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) return null
  // IHDR 紧跟签名:len(4)+"IHDR"(4)+data(13)。宽/高是 data 前 8 字节(大端 u32)。
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  let dpi: number | null = null
  // 扫描 chunk 找 pHYs(每米像素数 + 单位)。单位=1 表示米 → DPI = ppu * 0.0254。
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('ascii')
    if (type === 'pHYs' && off + 8 + 9 <= buf.length) {
      const ppuX = buf.readUInt32BE(off + 8)
      const unit = buf[off + 8 + 8]
      if (unit === 1 && ppuX > 0) dpi = Math.round(ppuX * 0.0254)
      break
    }
    if (type === 'IDAT' || type === 'IEND') break // 图像数据开始,pHYs 必在此前
    off += 12 + len // len + type(4) + data(len) + crc(4)
  }
  return { width, height, dpi }
}

type PixelStats = {
  dominantFrac: number
  dominantColor: [number, number, number]
  edgeInkFrac: number
}

/**
 * 用 Pillow 做像素统计(容器内 matplotlib 依赖 Pillow,恒可用;不可用则优雅跳过)。
 *  - dominantFrac:量化后最高频颜色占比 → 主背景占比,过高=取景空/物体飘散。
 *  - dominantColor:主背景 RGB → 判断是否偏离中性灰阶(渲染异常/背景色错)。
 *  - edgeInkFrac:画布最外 2% 一圈里,与主背景差异大的"内容像素"比例 → 元素贴边/被裁。
 */
function pixelStats(imagePath: string): PixelStats | null {
  const py = `
import sys, json
from PIL import Image
from collections import Counter
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
sm = im.resize((200, 200))
px = list(sm.getdata())
q = [(r // 24, g // 24, b // 24) for (r, g, b) in px]
c = Counter(q)
(dq, dn) = c.most_common(1)[0]
dom = [dq[0] * 24, dq[1] * 24, dq[2] * 24]
domfrac = dn / len(q)
# 边缘一圈内容像素比例:最外 4px(200x200 缩略图上约 2%)
def is_ink(p):
    return abs(p[0]-dom[0]) + abs(p[1]-dom[1]) + abs(p[2]-dom[2]) > 60
b = 4
edge = 0; edge_ink = 0
for y in range(200):
    for x in range(200):
        if x < b or x >= 200-b or y < b or y >= 200-b:
            edge += 1
            r = sm.getpixel((x, y))
            if is_ink(r): edge_ink += 1
print(json.dumps({
    "dominantFrac": round(domfrac, 4),
    "dominantColor": dom,
    "edgeInkFrac": round(edge_ink / max(edge, 1), 4),
}))
`
  try {
    const outBuf = execFileSync('python3', ['-c', py, imagePath], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 1 << 20,
    })
    const o = JSON.parse(outBuf.toString('utf8')) as PixelStats
    return o
  } catch {
    return null // Pillow 缺失/解码失败 → 跳过像素类检查,不阻断 vision 审图
  }
}

function auditPrompt(kind: FigKind, focus: string | undefined): string {
  const common = [
    '你是顶刊科研配图审稿专家。这是一张 agent 刚生成、准备放进论文/报告的图。',
    '只依据图像本身,严格找出所有会被审稿人挑剔、或影响读者理解的问题。逐条列出',
    '(每条写清:问题 + 大致位置)。必须重点检查:',
    '1) 文字/标签是否被画布边缘裁切、是否有内容超出可视区;',
    '2) 元素是否重叠遮挡(图例压数据、标注互相压、引线/连线交叉成团);',
    '3) 取景是否得当:主体是否居中充满画面,还是孤零零飘在大片空白里;',
    '4) 背景与配色是否正常:有无异常纯色背景(整张绿/黄之类)、刺眼配色、对比度不足;',
    '5) 文字字号是否过小难以辨认;',
    '6) 有无低级错误:物体悬空、比例失调、明显渲染异常。',
  ]
  const perKind: Record<FigKind, string> = {
    figure:
      '7) 数据图必检:坐标轴标签+单位、刻度、图例、必要标题是否齐全清晰;曲线/柱是否可区分。',
    schematic:
      '7) 示意图必检:每个部件/模块是否有清晰文字标注;框线是否对齐工整;是否够精密而非草图感。',
    network:
      '7) 网络/关系图必检:节点标签是否可读不重叠;边是否糊成一团(布局是否合理、关键结构是否看得出);箭头方向是否清楚。',
    '3d':
      '7) 3D/装置图必检:是否有坐标或比例参照;各部件是否有标注/图例;取景是否框住全部主体;是否所有物体都落在地面而非悬空。',
    composite:
      '7) 组合/多面板图必检:各子图 (a)(b)(c) 是否有面板编号;子图间是否对齐、间距是否合理、有无互相压盖;共享图例/色标是否清楚。',
  }
  const tail = [
    focus ? `额外关注:${focus}` : '',
    '若图已达出版级、无重大问题,请只回复以「PASS:」开头的一句结论;',
    '否则先逐条列问题,最后用一句总体结论说明最该先修的 1-2 个问题。',
  ]
  return [...common, perKind[kind], ...tail].filter(Boolean).join('\n')
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2))
  const imageFile = positional[0]
  if (!imageFile) fail(TOOL, 'usage: oc-figcheck <image.png> [--kind figure|schematic|network|3d|composite] [--focus "..."]')
  const kind: FigKind = (KINDS as readonly string[]).includes(flags.kind ?? '')
    ? (flags.kind as FigKind)
    : 'figure'

  // 复用 oc-vision 的路径白名单 + 大小 + 光栅魔数校验(泛化后含 research 目录)。
  const resolved = resolveVisionInput({ image_file: imageFile, prompt: auditPrompt(kind, flags.focus) })

  const issues: string[] = []
  const det: Record<string, unknown> = {}

  // ── 确定性检查 ─────────────────────────────────────────────
  const buf = readFileSync(resolved.imagePath)
  const meta = readPngMeta(buf)
  if (meta) {
    det.width = meta.width
    det.height = meta.height
    det.dpi = meta.dpi
    if (meta.width < MIN_W || meta.height < MIN_H)
      issues.push(`分辨率偏低(${meta.width}×${meta.height}px):放进报告会糊,建议 figsize 更大且 savefig(dpi>=300)。`)
    if (meta.dpi != null && meta.dpi < MIN_DPI)
      issues.push(`DPI 仅 ${meta.dpi}:savefig 未设或过低,投稿/印刷建议 dpi=${TARGET_DPI}。`)
    if (meta.dpi == null)
      issues.push('PNG 无 DPI 元数据:savefig 请显式传 dpi=300,保证印刷清晰度。')
  }
  const stats = pixelStats(resolved.imagePath)
  if (stats) {
    det.dominantFrac = stats.dominantFrac
    det.dominantColor = stats.dominantColor
    det.edgeInkFrac = stats.edgeInkFrac
    if (stats.dominantFrac > MONO_BG_MAX)
      issues.push(`主体占比过小(单一背景色占 ${(stats.dominantFrac * 100).toFixed(0)}%):取景过空/物体飘散,请收紧视野让主体充满画面。`)
    const [r, g, b] = stats.dominantColor
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    if (chroma > BG_CHROMA_MAX)
      issues.push(`背景主色异常偏色(RGB ${r},${g},${b}):疑似渲染背景配置错误(如整张绿/黄),科研图背景应为白/浅灰。`)
    if (stats.edgeInkFrac > EDGE_INK_MAX)
      issues.push(`画布边缘内容密集(边缘墨占 ${(stats.edgeInkFrac * 100).toFixed(0)}%):元素可能贴边或被裁切,savefig 请加 bbox_inches='tight' 并留白边。`)
  }

  // ── vision 审图 ───────────────────────────────────────────
  let visionText = ''
  let visionOk = true
  try {
    visionText = (await runVision(resolved)).trim()
  } catch (e) {
    visionOk = false
    visionText = `(vision 审图失败:${e instanceof Error ? e.message : String(e)})`
  }
  const visionPass = visionOk && /^\s*PASS[:：]/i.test(visionText)

  // ── 汇总 verdict ──────────────────────────────────────────
  // 确定性硬伤(取景空/偏色/裁切/分辨率) → FAIL;vision 未 PASS 但确定性干净 → WARN;
  // 两者都干净/PASS → PASS。verdict 单独成行,供 agent 程序化判断是否需要重画。
  const verdict = issues.length > 0 ? 'FAIL' : visionPass ? 'PASS' : visionOk ? 'WARN' : 'WARN'

  process.stdout.write(
    `${JSON.stringify(
      {
        image: resolved.imagePath,
        kind,
        deterministic: { checks: det, issues },
        vision: { backend: process.env.OPENCLAUDE_VISION_BACKEND === 'codex' ? 'codex(gpt-5.5)' : 'minimax-m3', pass: visionPass, review: visionText },
        verdict,
        hint:
          verdict === 'PASS'
            ? '通过。可作为最终产物。'
            : '未通过:请按 deterministic.issues 与 vision.review 修改绘图代码后重画,再次 oc-figcheck,直至 PASS。',
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(`VERDICT: ${verdict}\n`)
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)))
