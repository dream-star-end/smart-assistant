/** Shared whole-turn read-only detector for advisor mode (node-free for gateway, master & web). */

import { unwrapMessageReplyCurrentText } from './messageReply.js'
import { normalizeServiceTierForModel, type ServiceTier } from './serviceTiers.js'

export const ADVISOR_NO_WRITE_CONSTRAINT =
  '【本轮禁止写文件】用户要求本轮只读、只给建议或仅回复。主模型只能用只读工具验证，交付只写回复；不得写入、修改、新建或删除文件，不得通过命令、MCP 或委派绕过。顾问不要建议主模型改文件、执行写命令或把建议落实到文件。'

const ZH_WRITE_BAN = String.raw`(?:不要|不用|无需|不必|不需要|不许|禁止|不得|不能|别|勿|请勿|不)`
const ZH_WRITE_VERB = String.raw`(?:改(?:动|写)?|更改|修改|编辑|写入?|创建|新建|删除|保存|更新|覆盖|触碰|动)`
const ZH_WRITE_VERBS = String.raw`${ZH_WRITE_VERB}(?:\s*(?:或者|或|和|与|及|以及|并且|并|、)\s*${ZH_WRITE_VERB})*`
const ZH_ALL_FILES = String.raw`(?:(?:任何|所有|任意|全部)(?:一个|一份)?(?:的)?\s*)?(?:文件|代码|文档|仓库|工作区|源码|磁盘)(?:的内容)?`
// Reject explicit target/subdirectory qualifiers, rather than requiring a
// particular ending: coordination, purposes and polite particles remain global.
const ZH_GLOBAL_END = String.raw`(?!\s*(?:里|中|内|下|外|名为|叫作|路径为|(?:的)?(?:名(?:称)?|编码|权限|属性|格式|大小|类型|后缀|扩展名|元数据|路径|目录|子目录)|(?:in|under|inside|within|outside|from|named|matching)\b|[\w./-]+\.[a-zA-Z0-9]{1,16}\b))`
const EN_WRITE_BAN = String.raw`\b(?:do\s+not|don't|never|must\s+not|cannot|can't|no)\s+(?:(?:actually|directly|ever)\s+)*`
const EN_WRITE_VERB = String.raw`(?:modify|edit|change|write|create|delete|remove|save|update|overwrite|touch|patch)`
const EN_ALL_FILES = String.raw`(?:(?:any|all)(?:\s+of)?\s+)?(?:(?:the|this|current|entire|whole)\s+)?(?:files?|code|documents?|repo(?:sitory)?|workspace|disk|anything)\b`
const EN_GLOBAL_END = String.raw`(?!\s+(?:in|under|inside|within|outside|named|called|matching|from|[\w/-]+\.[a-z]{1,16})\b)`
const ADVISOR_WHOLE_TURN_REPLY_ONLY = [
  /^\s*(?:(?:请|帮我|本轮|这轮|这一轮|全程|主模型|以)\s*)*(?:禁写|只读|(?:只|仅)(?:允许|需要|需|用|做)?\s*(?:查看|检查|分析|审查|给(?:出)?(?:意见|(?:修改)?建议|方案)|提供(?:意见|建议|方案)|提建议|回复|回答|输出建议|告诉我|说))/,
  /^\s*(?:(?:请|帮我|本轮|这轮|这一轮|主模型)\s*)*(?:只|仅)(?:需要|需|允许)?\s*(?:给出?|提供)[^。！？!?\n，,；;]{0,120}(?:建议|意见|方案)/,
  /^\s*(?:please\s+)?(?:read[\s-]?only|(?:advice|suggestions?|response|reply)\s+only|(?:only|just)\s+(?:(?:give|provide)\s+(?:me\s+)?(?:advice|suggestions?|recommendations?)|advise|answer|respond|reply|explain|review|analy[sz]e))\b/i,
]
const ADVISOR_WHOLE_TURN_NO_WRITE = [
  new RegExp(String.raw`${ZH_WRITE_BAN}\s*(?:(?:再|去|实际|直接|自动|擅自|执行|进行)\s*)*${ZH_WRITE_VERBS}\s*${ZH_ALL_FILES}${ZH_GLOBAL_END}`),
  new RegExp(String.raw`${ZH_WRITE_BAN}\s*(?:对)?${ZH_ALL_FILES}\s*(?:做|进行|作)?\s*(?:任何)?${ZH_WRITE_VERBS}${ZH_GLOBAL_END}`),
  new RegExp(String.raw`^\s*${ZH_ALL_FILES}\s*(?:都|也|先|暂时)?\s*${ZH_WRITE_BAN}\s*${ZH_WRITE_VERBS}${ZH_GLOBAL_END}`),
  new RegExp(String.raw`${EN_WRITE_BAN}(?:${EN_WRITE_VERB}(?:\s+(?:or|and)\s+${EN_WRITE_VERB})*|(?:make|apply)\s+(?:any\s+)?(?:changes?|edits?|patches?))\s+(?:(?:to|on|into)\s+)?${EN_ALL_FILES}${EN_GLOBAL_END}`, 'i'),
  new RegExp(String.raw`\bwithout\s+(?:modifying|editing|changing|writing|creating|deleting|saving|updating|touching)\s+${EN_ALL_FILES}${EN_GLOBAL_END}`, 'i'),
  new RegExp(String.raw`\bwithout\s+(?:making|applying)\s+(?:any\s+)?(?:changes?|edits?|modifications?)\s+(?:to|in|on)\s+${EN_ALL_FILES}${EN_GLOBAL_END}`, 'i'),
  new RegExp(String.raw`\bno\s+(?:changes?|edits?|modifications?|writes?)\s+(?:to|of|in)\s+${EN_ALL_FILES}${EN_GLOBAL_END}`, 'i'),
  /\bno\s+(?:file|code|document|workspace)\s+(?:writes?|changes?|edits?|modifications?)\b(?!\s+(?:to|in|under|inside|within|outside|for|from)\b)/i,
  new RegExp(String.raw`\b(?:keep|leave)\s+${EN_ALL_FILES}\s+(?:unchanged|untouched|unmodified)\b`, 'i'),
]
const ADVISOR_EXPLICIT_WRITE = [
  new RegExp(String.raw`^(?:(?:请|现在|本轮|这轮|直接|先|帮我|务必|允许|可以)\s*)*${ZH_WRITE_VERB}`),
  new RegExp(String.raw`^(?:(?:please|now|then|you may|you can|go ahead and)\s+)*${EN_WRITE_VERB}\b`, 'i'),
]

function advisorNamedTargets(text: string): string[] {
  // Chinese operation words can touch a filename without a separating space.
  const targetText = text.replace(ADVISOR_EXPLICIT_WRITE[0]!, '').replace(
    /^(?:(?:请|帮我|本轮|这轮|这一轮|全程|主模型|以)\s*)*(?:(?:禁写|只读)\s*(?:查看|检查|分析|审查|阅读|看)?|(?:只|仅)(?:允许|需要|需|用|做)?\s*(?:查看|检查|分析|审查|给出?|提供))\s*/,
    '',
  )
  const names = targetText.match(/[\p{L}\p{N}_@+~./\\-]+\.[a-zA-Z0-9]{1,16}\b|(?:[\p{L}\p{N}_@+~.-]+[\\/])+/gu) ?? []
  return names.map(name => name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
}

function advisorHasTargetException(clause: string): boolean {
  const exception = clause.match(/(?:除(?!非)了?|\b(?:except(?:\s+for)?|excluding|apart from|other than)\b)\s*(\S+)/i)
  if (!exception) return false
  const operand = exception[1]!
  // An exception for reading a file does not authorize writing it.
  if (/^(?:读取?|阅读|查看|检查|分析|审查|讨论|咨询|建议|解释|说明)(?!\.)/.test(operand)) return false
  return advisorNamedTargetOperand(operand)
}

function advisorNamedTargetOperand(text: string): boolean {
  return /^(?:[\p{L}\p{N}_@+~./\\-]+\.[a-zA-Z0-9]{1,16}|(?:[\p{L}\p{N}_@+~.-]+[\\/])+)(?=\s|$|以外|之外|外)/u.test(text)
}

function advisorHasExplicitWrite(clause: string): boolean {
  return ADVISOR_EXPLICIT_WRITE.some(pattern => {
    const match = pattern.exec(clause)
    if (!match) return false
    const object = clause.slice(match[0].length).trimStart()
    // "修改建议" / "change suggestions" are nouns, not editing permission.
    // A literal filename such as 建议.md remains an editable target.
    return !/^(?:建议|意见|方案|计划|说明|方法|步骤|策略|advice\b|suggestions?\b|recommendations?\b|proposals?\b|plans?\b)/i.test(object) || advisorNamedTargetOperand(object)
  })
}

/** Only whole-turn intent disables all writes; target-specific restrictions remain in the task. */
export function detectAdvisorNoWrite(userText: string): boolean {
  const currentText = unwrapMessageReplyCurrentText(userText)
  const text = currentText.normalize('NFKC').replace(/[’‘]/g, "'").replace(/[`“”「」『』"]/g, ' ')
  const clauses = text.split(/[。！？!?\n；;]+|\.(?=\s|$)/).flatMap(sentence => {
    const parts = sentence.split(/[，,]+/).map(clause => clause.trim()).filter(Boolean)
    const result: string[] = []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      // Keep comma-separated exceptions attached to the restriction they scope.
      if (/^(?:除了?|except\b|excluding\b|apart from\b|other than\b)/i.test(part)) {
        if (result.length) result[result.length - 1] += ` ${part}`
        else result.push(`${part} ${parts[++index] ?? ''}`.trim())
      } else result.push(part)
    }
    return result
  })
  // A generic file ban is authoritative even beside an otherwise authorized edit.
  if (clauses.some(clause => (
      !advisorHasTargetException(clause) &&
      ADVISOR_WHOLE_TURN_NO_WRITE.some(pattern => pattern.test(clause))
  ))) return true
  const edits = clauses.filter(advisorHasExplicitWrite)
  return clauses.some(clause => {
    if (!ADVISOR_WHOLE_TURN_REPLY_ONLY.some(pattern => pattern.test(clause))) return false
    const targets = advisorNamedTargets(clause)
    // A standalone read-only request still protects the turn. Beside an explicit
    // edit of another target, the named read-only/advice clause is only local.
    return targets.length === 0 || !edits.some(edit => edit !== clause && (
      advisorNamedTargets(edit).length === 0 || advisorNamedTargets(edit).some(target => !targets.includes(target))
    ))
  })
}
/** True when the turn itself runs under read-only advisor protection (so gateway drops speed tiers). */
export function isAdvisorReadOnlyMainTurn(args: {
  agentId?: string | null
  collabMode?: unknown
  advisorModel?: unknown
  text?: string | null
  readOnly?: boolean
}): boolean {
  if (args.readOnly === true) return true
  if ((args.agentId ?? 'main') !== 'main') return false
  if (args.collabMode !== 'advisor') return false
  if (typeof args.advisorModel !== 'string' || !args.advisorModel.trim()) return false
  return typeof args.text === 'string' && detectAdvisorNoWrite(args.text)
}

/** Single cross-layer authority for a turn's effective billing & execution speed tier. */
export function resolveEffectiveTurnServiceTier(args: {
  model: string | null | undefined
  serviceTier: unknown
  agentId?: string | null
  collabMode?: unknown
  advisorModel?: unknown
  text?: string | null
  readOnly?: boolean
}): ServiceTier | null {
  if (isAdvisorReadOnlyMainTurn(args)) return null
  return normalizeServiceTierForModel(args.model, args.serviceTier)
}
