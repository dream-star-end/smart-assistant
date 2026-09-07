import bike from '../../public/tutorials/cases/research-bike-demand/showcase/manifest.json'
import markets from '../../public/tutorials/cases/general-public-data-brief/showcase/manifest.json'
import { TUTORIAL_CASE_BY_ID, type TutorialCase, type TutorialCaseId } from './tutorialCaseCatalog'

export type ShowcaseEvidence = {
  schemaVersion: number
  caseId: string
  generatedAt: string
  summary: string
  metrics: { label: string; value: string }[]
  highlights: { title: string; body: string }[]
  inputs: { path: string; sha256: string; bytes: number }[]
  outputs: { path: string; sha256: string; bytes: number }[]
  checks: { name: string; passed: boolean }[]
  limitations: string[]
}
export type TutorialShowcase = {
  caseId: TutorialCaseId
  title: string
  category: string
  lead: string
  request: string
  prompt: string
  theme: 'mint' | 'blue'
  evidence: ShowcaseEvidence
}
// Presentation of existing case IDs, not a second case registry. Fresh public-data
// artifacts are not historical field reports or verified full-session replays.
export const TUTORIAL_SHOWCASES: readonly TutorialShowcase[] = [
  {
    caseId: 'research-bike-demand',
    title: '一堆出行数据，变成看得懂的需求规律。',
    category: '数据 → 交互看板',
    lead: '不止给你一段分析。按时段、工作日探索数据，把图表、报告和可复算的数据一起拿走。',
    request: '这份单车出行数据里，什么时候最忙？工作日和休息日有什么不同？做成我能自己探索的看板。',
    prompt: '我想把自己的数据做成一个可交互的分析看板，像案例展厅的单车需求分析一样。请先询问我要分析的问题、数据文件和字段含义；没有材料时，可以经我确认后使用展厅的公开样例。先检查缺失值、单位和统计口径，再分析时段与分组差异。交付可打开的交互看板、中文报告、可复算的数据和脚本，注明数据来源、时间范围和局限。不要把相关关系写成因果，不预先承诺任何结论。',
    theme: 'mint',
    evidence: bike,
  },
  {
    caseId: 'general-public-data-brief',
    title: '三个市场怎么选？先把证据摆在同一张桌上。',
    category: '公开资料 → 决策简报',
    lead: '人口、经济与联网率统一口径，切换指标看差异。结论旁边就有来源，不再来回翻资料。',
    request: '比较越南、印度尼西亚和菲律宾的人口、人均 GDP 与互联网使用率。我要一份有出处、能查看数据的简报。',
    prompt: '我想做一份有来源、能核对数据的市场比较简报，像案例展厅的公开数据简报一样。请先确认我要比较的地区、用途、指标和年份；需要最新数据时重新检索权威来源，不要沿用案例的历史数据冒充当前情况。统一年份、单位与缺失值口径，交付可交互的对比看板、中文简报、明细数据和来源清单。宏观指标仅作背景，不把人口或联网率直接当成市场规模，也不要凭这些指标替我做投资决策。',
    theme: 'blue',
    evidence: markets,
  },
]
export function showcaseById(id: TutorialCaseId | null): TutorialShowcase | undefined {
  return TUTORIAL_SHOWCASES.find((item) => item.caseId === id)
}
export function showcaseAsset(item: TutorialShowcase, filename: string): string {
  return '/tutorials/cases/' + item.caseId + '/showcase/' + filename
}
export function showcaseTask(item: TutorialShowcase): TutorialCase {
  return { ...TUTORIAL_CASE_BY_ID[item.caseId], starterPrompt: item.prompt }
}
