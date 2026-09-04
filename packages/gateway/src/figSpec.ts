/**
 * FigureSpec — 示意图物理一致性声明与确定性校验(oc-figcheck --spec 的核心)。
 *
 * 背景:示意图的物理正确性(天线悬空、倒扣、波束指向错、连线进基线不进波束、误差
 * 量级混轴)此前完全靠 LLM 逐轮心算坐标,oc-figcheck 只看渲染像素,零覆盖。领域模板
 * (scientific-figures references/templates)渲染时伴生 FigureSpec:对象/连线/量级/
 * 标签的**结构化声明**,本模块用纯函数做规则化校验——确定性、可证、不耗模型。
 *
 * 规则一览(全部确定性,违规=确定性 issue → verdict FAIL):
 *   R1 grounding-chain   scene.grounding=required 时,实体支撑链必须沿 supports 到 ground
 *   R2 link-endpoints    连线端点必须命中声明对象;must_be_in_beam_of 用锥几何点积判定
 *   R3 magnitude-unit    同组量纲必须一致;同组跨度>10² 时条长必须按 log10 归一
 *   R4 label-bbox        每个非辅助对象必须有标签;标签 bbox 两两相交>20% 违规
 *   R4b legend-overlap   图例 bbox 与标题相交、与标签相交>20%、覆盖对象锚点 → 违规
 *   R5 structure         objects 非空、id 唯一、数值 finite
 *
 * 本文件为纯函数(不读图、不 IO),单测见 __tests__/ocFigCheckSpec.test.ts;
 * 无 --spec 时 ocFigCheckCli 完全不经过这里(现网行为字节不变)。
 */

export type FigSpecVec = [number, number]
export type FigSpecBox = [FigSpecVec, FigSpecVec]

export interface FigSpecBeam {
  boresight_deg: number
  half_angle_deg: number
}

export interface FigSpecObject {
  id: string
  type?: string
  anchor?: FigSpecVec
  /** 支撑对象 id,或字面量 "ground" */
  supports?: string
  orientation_deg?: number
  beam?: FigSpecBeam
}

export interface FigSpecLink {
  id?: string
  from: string
  to: string
  kind?: string
  /** to 端必须落在该对象的波束锥内(面板 id) */
  must_be_in_beam_of?: string
}

export interface FigSpecMagnitude {
  id?: string
  label?: string
  value: number
  unit?: string
  /** 同组必须同量纲;组内跨度>10² 时条长按 log10 归一 */
  group?: string
  /** 画成条形时的条长(cm);纯文本标注可不提供 */
  rendered_length?: number
}

export interface FigSpecLabel {
  id?: string
  for: string
  text?: string
  bbox?: FigSpecBox
}

/** 图例包围盒声明(模板伴生;声明了才做遮挡检查,不声明=向后兼容不校验) */
export interface FigSpecLegend {
  bbox?: FigSpecBox
}

/** 标题包围盒声明 */
export interface FigSpecTitle {
  text?: string
  bbox?: FigSpecBox
}

export interface FigSpec {
  template?: string
  kind?: string
  units?: string | null
  scene?: { grounding?: string }
  objects?: FigSpecObject[]
  links?: FigSpecLink[]
  magnitudes?: FigSpecMagnitude[]
  labels?: FigSpecLabel[]
  legend?: FigSpecLegend
  title?: FigSpecTitle
}

export type SpecIssueSeverity = 'fail' | 'warn'

export interface SpecIssue {
  rule: string
  severity: SpecIssueSeverity
  message: string
}

/** 天空中的物体不要求落地(卫星/目标/飞行器/天体源等) */
const AIRBORNE_TYPES = new Set(['satellite', 'target', 'spacecraft', 'aircraft', 'star', 'celestial', 'sky', 'source'])
/** 上下文元素不强制独立标签(地面/基座) */
const LABEL_EXEMPT_TYPES = new Set(['ground', 'mount'])
/** 同组量级跨度超过该值时,条长必须按 log10 量级归一(否则线性/任意画都会严重失真) */
const LOG_SCALE_SPAN = 100
/** 条长与期望(log 归一)比例偏差超过 2× 判违规 */
const LENGTH_RATIO_TOLERANCE = 2
/** 标签 bbox 相交面积/较小者面积 超过该值判遮挡 */
const LABEL_OVERLAP_FRAC = 0.2

function issue(rule: string, message: string, severity: SpecIssueSeverity = 'fail'): SpecIssue {
  return { rule, severity, message }
}

/** 解析 spec JSON;结构性错误(非 JSON/非对象)返回 error,字段级问题走 checkSpec。 */
export function parseFigSpec(raw: string): { spec?: FigSpec; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { error: `spec 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'spec 顶层必须是 JSON 对象' }
  }
  return { spec: parsed as FigSpec }
}

function bboxArea(b: FigSpecBox): number {
  return Math.max(0, b[1][0] - b[0][0]) * Math.max(0, b[1][1] - b[0][1])
}

function bboxOverlapFrac(a: FigSpecBox, b: FigSpecBox): number {
  const ix = Math.min(a[1][0], b[1][0]) - Math.max(a[0][0], b[0][0])
  const iy = Math.min(a[1][1], b[1][1]) - Math.max(a[0][1], b[0][1])
  if (ix <= 0 || iy <= 0) return 0
  const inter = ix * iy
  return inter / Math.max(Math.min(bboxArea(a), bboxArea(b)), 1e-12)
}

/** box 结构与数值合法性(spec 里的 bbox 都是可选声明,先验后用)。 */
function isFiniteBox(box: FigSpecBox | undefined): box is FigSpecBox {
  if (!Array.isArray(box) || box.length !== 2) return false
  for (const corner of box) {
    if (!Array.isArray(corner) || corner.length !== 2 || corner.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false
  }
  return true
}

/** R1:支撑链接地检查。 */
function checkGrounding(spec: FigSpec, byId: Map<string, FigSpecObject>): SpecIssue[] {
  const issues: SpecIssue[] = []
  if (spec.scene?.grounding !== 'required') return issues
  for (const obj of spec.objects ?? []) {
    const type = obj.type ?? ''
    if (type === 'ground' || AIRBORNE_TYPES.has(type)) continue
    if (!obj.supports) {
      issues.push(issue('grounding-chain', `对象 '${obj.id}' 声明为需要落地场景但无 supports(悬空)。`))
      continue
    }
    // 沿支撑链走到 ground;防环用步数上限
    let cur: string | undefined = obj.supports
    let steps = 0
    let ok = false
    let broken = false
    while (cur !== undefined && steps <= (spec.objects?.length ?? 0) + 1) {
      if (cur === 'ground') {
        ok = true
        break
      }
      const next = byId.get(cur)
      if (!next) {
        broken = true
        break
      }
      cur = next.supports
      steps++
    }
    if (!ok) {
      if (broken) {
        issues.push(issue('grounding-chain', `对象 '${obj.id}' 的支撑链断裂:supports '${cur}' 未在 objects 中声明(也无法到达 ground)。`))
      } else {
        issues.push(issue('grounding-chain', `对象 '${obj.id}' 的支撑链未到达 ground(疑似成环或悬空)。`))
      }
    }
  }
  return issues
}

/** R2:连线端点与波束锥覆盖。 */
function checkLinks(spec: FigSpec, byId: Map<string, FigSpecObject>): SpecIssue[] {
  const issues: SpecIssue[] = []
  for (const link of spec.links ?? []) {
    const lid = link.id ?? `${link.from}->${link.to}`
    for (const [side, ref] of [['from', link.from], ['to', link.to]] as const) {
      if (typeof ref !== 'string' || !byId.has(ref)) {
        issues.push(issue('link-endpoints', `连线 '${lid}' 的 ${side} 端 '${String(ref)}' 不是声明的对象 id。`))
      }
    }
    if (link.must_be_in_beam_of !== undefined) {
      const panel = byId.get(link.must_be_in_beam_of)
      if (!panel || !panel.beam || typeof panel.beam.boresight_deg !== 'number' || typeof panel.beam.half_angle_deg !== 'number') {
        issues.push(
          issue(
            'link-endpoints',
            `连线 '${lid}' 声明 must_be_in_beam_of='${link.must_be_in_beam_of}',但该对象不存在或缺少完整 beam{boresight_deg,half_angle_deg}。`,
          ),
        )
        continue
      }
      const tgt = byId.get(link.to)
      if (!tgt || !Array.isArray(tgt.anchor) || !Array.isArray(panel.anchor)) {
        issues.push(issue('link-endpoints', `连线 '${lid}' 波束覆盖判定缺少锚点坐标(panel '${panel.id}' 或目标 '${link.to}' 无 anchor)。`))
        continue
      }
      const vx = tgt.anchor[0] - panel.anchor[0]
      const vy = tgt.anchor[1] - panel.anchor[1]
      const norm = Math.hypot(vx, vy)
      if (norm > 1e-9) {
        const b = (panel.beam.boresight_deg * Math.PI) / 180
        const cosAng = (vx * Math.cos(b) + vy * Math.sin(b)) / norm
        const angDeg = (Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180) / Math.PI
        if (angDeg > panel.beam.half_angle_deg + 1e-6) {
          issues.push(
            issue(
              'link-endpoints',
              `连线 '${lid}' 的目标 '${link.to}' 偏离面板 '${panel.id}' 波束轴 ${angDeg.toFixed(1)}°(半张角 ${panel.beam.half_angle_deg}°):连线落在波束覆盖外(典型错误:信号线画进基线而没进波束)。`,
            ),
          )
        }
      }
    }
  }
  return issues
}

/** R3:量级单位一致性与 log 归一。 */
function checkMagnitudes(spec: FigSpec): SpecIssue[] {
  const issues: SpecIssue[] = []
  const magnitudes = spec.magnitudes ?? []
  for (const m of magnitudes) {
    const mid = m.id ?? m.label ?? '?'
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) {
      issues.push(issue('magnitude-unit', `量级 '${mid}' 的 value 不是有限数值。`))
    }
    if (!m.unit || typeof m.unit !== 'string') {
      issues.push(issue('magnitude-unit', `量级 '${mid}' 缺少单位(误差条/坐标值必须带单位)。`))
    }
  }
  const groups = new Map<string, FigSpecMagnitude[]>()
  for (const m of magnitudes) {
    if (m.group === undefined) continue
    const list = groups.get(m.group) ?? []
    list.push(m)
    groups.set(m.group, list)
  }
  for (const [group, members] of groups) {
    const units = new Set(members.map((m) => m.unit ?? ''))
    if (units.size > 1) {
      issues.push(
        issue('magnitude-unit', `量级组 '${group}' 混用不同单位(${[...units].join(' / ')}):同类分量不同量纲禁止混轴,先换算成一致单位或拆组。`),
      )
    }
    const values = members.map((m) => m.value).filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    if (values.length < 2) continue
    const vmin = Math.min(...values)
    const vmax = Math.max(...values)
    if (vmax / vmin <= LOG_SCALE_SPAN) continue
    const withLen = members.filter((m) => typeof m.rendered_length === 'number' && Number.isFinite(m.rendered_length))
    if (withLen.length === 0) continue // 纯文本标注组不校验条长
    if (withLen.length < members.length) {
      const missing = members.filter((m) => m !== undefined && typeof m.rendered_length !== 'number').map((m) => m.id ?? m.label ?? '?')
      issues.push(issue('magnitude-unit', `量级组 '${group}' 跨度>${LOG_SCALE_SPAN}(条形图),但 [${missing.join(',')}] 未声明 rendered_length,无法核对量级归一。`))
      continue
    }
    const lengths = withLen.map((m) => m.rendered_length as number)
    const lmin = Math.min(...lengths)
    const lmax = Math.max(...lengths)
    const logMin = Math.log10(vmin)
    const logMax = Math.log10(vmax)
    if (lmax - lmin < 1e-9) {
      issues.push(issue('magnitude-unit', `量级组 '${group}' 跨度>${LOG_SCALE_SPAN} 但所有条长相同:条长未按 log10 量级归一。`))
      continue
    }
    for (const m of withLen) {
      const expected = lmin + ((Math.log10(m.value) - logMin) / (logMax - logMin)) * (lmax - lmin)
      const actual = m.rendered_length as number
      const ratio = actual / Math.max(expected, 1e-6)
      if (ratio > LENGTH_RATIO_TOLERANCE || ratio < 1 / LENGTH_RATIO_TOLERANCE) {
        issues.push(
          issue(
            'magnitude-unit',
            `量级 '${m.id ?? m.label ?? '?'}'(组 '${group}',值 ${m.value} ${m.unit})条长 ${actual.toFixed(2)} 与 log10 归一期望 ${expected.toFixed(2)} 偏差>${LENGTH_RATIO_TOLERANCE}×:大跨度量级必须按对数归一画条长。`,
          ),
        )
      }
    }
  }
  return issues
}

/** R4:标签完整性与遮挡。 */
function checkLabels(spec: FigSpec, byId: Map<string, FigSpecObject>): SpecIssue[] {
  const issues: SpecIssue[] = []
  const labels = spec.labels ?? []
  const labeled = new Set<string>()
  const boxes: Array<{ forId: string; box: FigSpecBox; text: string }> = []
  for (const lbl of labels) {
    if (!byId.has(lbl.for)) {
      issues.push(issue('label-bbox', `标签 '${lbl.id ?? lbl.text ?? '?'}' 的 for='${lbl.for}' 不是声明的对象 id。`))
      continue
    }
    labeled.add(lbl.for)
    if (Array.isArray(lbl.bbox) && Array.isArray(lbl.bbox[0]) && Array.isArray(lbl.bbox[1])) {
      boxes.push({ forId: lbl.for, box: lbl.bbox, text: lbl.text ?? '' })
    } else {
      issues.push(issue('label-bbox', `对象 '${lbl.for}' 的标签缺少 bbox(无法做遮挡检查)。`))
    }
  }
  for (const obj of spec.objects ?? []) {
    if (obj.type && LABEL_EXEMPT_TYPES.has(obj.type)) continue
    if (!labeled.has(obj.id)) {
      issues.push(issue('label-bbox', `对象 '${obj.id}' 没有对应标签(spec 与图面可能不一致:每个部件都应有文字标注)。`))
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const frac = bboxOverlapFrac(boxes[i].box, boxes[j].box)
      if (frac > LABEL_OVERLAP_FRAC) {
        issues.push(
          issue(
            'label-bbox',
            `标签 '${boxes[i].forId}' 与 '${boxes[j].forId}' 包围盒交叠 ${(frac * 100).toFixed(0)}%(>${LABEL_OVERLAP_FRAC * 100}%):标注互相遮挡。`,
          ),
        )
      }
    }
  }
  return issues
}

/** R4b:图例包围盒遮挡(legend↔title / legend↔labels / legend↔对象锚点)。 */
function checkLegend(spec: FigSpec): SpecIssue[] {
  const issues: SpecIssue[] = []
  const legend = spec.legend?.bbox
  if (!isFiniteBox(legend)) return issues // 未声明图例 bbox:不校验(向后兼容)
  const title = spec.title?.bbox
  if (isFiniteBox(title) && bboxOverlapFrac(legend, title) > 0) {
    issues.push(issue('legend-overlap', `图例包围盒与标题相交:图例必须让开标题(锚到空白区或图外)。`))
  }
  for (const lbl of spec.labels ?? []) {
    if (!isFiniteBox(lbl.bbox)) continue
    const frac = bboxOverlapFrac(legend, lbl.bbox)
    if (frac > LABEL_OVERLAP_FRAC) {
      issues.push(issue('legend-overlap', `图例与 '${lbl.for}' 的标签交叠 ${(frac * 100).toFixed(0)}%(>${LABEL_OVERLAP_FRAC * 100}%):图例遮挡标注。`))
    }
  }
  for (const obj of spec.objects ?? []) {
    if (obj.type && LABEL_EXEMPT_TYPES.has(obj.type)) continue // 地面/基座是背景元素,锚点落在图例下属正常
    const a = obj.anchor
    if (!Array.isArray(a) || typeof a[0] !== 'number' || typeof a[1] !== 'number') continue
    if (a[0] > legend[0][0] && a[0] < legend[1][0] && a[1] > legend[0][1] && a[1] < legend[1][1]) {
      issues.push(issue('legend-overlap', `图例覆盖对象 '${obj.id}' 的锚点:图例压在对象上,请移到空白区。`))
    }
  }
  return issues
}

/** 入口:对一个 FigureSpec 做全部确定性检查。 */
export function checkSpec(spec: FigSpec): SpecIssue[] {
  const issues: SpecIssue[] = []
  if (!Array.isArray(spec.objects) || spec.objects.length === 0) {
    return [issue('structure', 'spec.objects 为空:没有可校验的对象声明。')]
  }
  const byId = new Map<string, FigSpecObject>()
  for (const obj of spec.objects) {
    if (!obj || typeof obj.id !== 'string' || !obj.id) {
      issues.push(issue('structure', `存在 id 缺失的对象:${JSON.stringify(obj).slice(0, 80)}`))
      continue
    }
    if (byId.has(obj.id)) issues.push(issue('structure', `对象 id '${obj.id}' 重复声明。`))
    byId.set(obj.id, obj)
  }
  issues.push(...checkGrounding(spec, byId))
  issues.push(...checkLinks(spec, byId))
  issues.push(...checkMagnitudes(spec))
  issues.push(...checkLabels(spec, byId))
  issues.push(...checkLegend(spec))
  return issues
}

/**
 * spec 派生的 VLM 定向核对问句:把通用"有无低级错误"换成领域可核对的具体问句,
 * 降低 VLM 漏检率(确定性规则为主、VLM 兜底)。
 */
export function specFollowUpQuestions(spec: FigSpec): string[] {
  const qs: string[] = []
  const n = spec.objects?.length ?? 0
  const m = spec.links?.length ?? 0
  qs.push(`请先核对图与规格一致性:图中应有 ${n} 个声明对象、${m} 条连线,数量与角色是否对得上?`)
  const perTemplate: Record<string, string> = {
    'phased-array-obs':
      '请核对:每个面板的波束锥是否从相位中心指向目标?信号连线是否落在波束覆盖内(而非两站基线中段)?基线连线与信号线是否用了不同线型并在图例区分?',
    'antenna-station':
      '请核对:每个天线是否坐落在支撑结构(塔架/基墩)顶端而非悬空?抛物面开口是否朝向波束方向(无"倒扣的锅盖")?馈源是否在焦点处且有支撑腿?',
    'radar-system': '请核对:信号流箭头是否单向无环?每条链路两端是否都是标注的器件?',
    'optical-link': '请核对:光路是否从发射望远镜经信道连续到接收望远镜(无悬空断口)?波长/功率/发散角标注与数值是否一致?',
    'coord-error-budget': '请核对:每条误差条是否带数值+单位?同组条长是否按量级(对数)而非线性比例?不同量纲是否分开了面板?',
  }
  const q = spec.template ? perTemplate[spec.template] : undefined
  if (q) qs.push(q)
  return qs
}
