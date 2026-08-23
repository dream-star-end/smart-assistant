// 默认流水线种子 — 四种单据类型各一条,幂等可重入。
//
// agentId 来自本实例 $OPENCLAUDE_HOME/agents.yaml(2026-08-16 核实):
//   main / codex / hidden-reviewer / auditor / coding-assistant /
//   explorer / general-assistant / office-assistant
// hidden-reviewer 禁止绑到用户可见 stage(recon E16 / agentVisibility)。
// 分工:定位根因与调研 → explorer;写代码 → coding-assistant;
// 自验审查 → auditor;需求澄清 / 明确问题 / 结论汇总 → general-assistant。
//
// 幂等:pipeline / stage 使用确定性 id(`${projectId}::${type}` /
// `${projectId}::${type}::${ordinal}`),已存在则跳过,不覆盖用户改过的提示词。
//
// 坑:
//   - human 阶段必须 patrolEnabled=false 且 patrolCron=null,否则 tick 会
//     对着「待我确认」空转烧配额。
//   - kind=ai 的 stage 必须有真实 agentId + promptTemplate + exitChecklist。
//   - entryCondition 必须是 entryCondition.ts 的谓词 DSL
//     (no_open_blockers / has_body_section / …),不要写中文散文,解析会失败。
//   - 本函数不创建项目;调用方先 createProject 再 seed。

import type { TicketType } from '../domain.js'
import { GUARDRAIL_DEFAULTS } from '../domain.js'
import { createPipeline, createStage, getPipeline, getStage } from './pipelines.js'
import type { TaskboardDb } from './schema.js'
import { TaskboardNotFound } from './schema.js'

export const DEFAULT_PATROL_CRON = '*/30 9-19 * * 1-5'

/**
 * 种子实际绑定的 agent。来源:$OPENCLAUDE_HOME/agents.yaml。
 *
 * 这些是阶段专用 agent,人设按「无人值守、禁止反问、固定移交结构」写。
 * 它们在 agents.yaml 里**不带 source**:带 source 的市场 agent 每次同步都会
 * 被打回默认模型绑定,阶段配置留不住。
 */
export const SEED_AGENT_IDS = {
  triage: 'stage-triage',
  diagnose: 'stage-diagnose',
  design: 'stage-design',
  implement: 'stage-implement',
  research: 'stage-research',
  verify: 'stage-verify',
  report: 'stage-report',
} as const

const PLACEHOLDERS =
  '{{ticket.identifier}} {{ticket.title}} {{ticket.body}} ' +
  '{{last_run.summary}} {{last_run.output}} {{comments}} {{stage.exit_checklist}}'

export interface StageSeed {
  name: string
  kind: 'ai' | 'human'
  agentId: string | null
  promptTemplate: string | null
  exitChecklist: string | null
  entryCondition: string | null
  onSuccess: 'advance' | 'wait_human'
  requireHumanAck: boolean
  effort: string | null
}

interface PipelineSeed {
  type: TicketType
  name: string
  stages: StageSeed[]
}

function aiPrompt(goal: string, output: string): string {
  return (
    `${goal}可用占位符(系统已填好,直接引用):${PLACEHOLDERS}。` +
    `${output}结束前必须对照 {{stage.exit_checklist}} 逐条自检,未完成的项要明确写出缺口。`
  )
}

const PIPELINES: PipelineSeed[] = [
  {
    type: 'bug',
    name: '问题单默认流水线',
    stages: [
      {
        name: '复现确认',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.triage,
        effort: 'medium',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'no_open_blockers',
        exitChecklist:
          '复现结论明确;最小步骤可被他人照做;期望与实际已对照;无法复现时列出缺失信息。',
        promptTemplate: aiPrompt(
          '你负责问题单的复现确认。根据描述独立把缺陷跑出来,确认它稳定可触发,并写清最小复现步骤与环境,不要改任何代码。',
          '产出用 Markdown,依次写:是否复现成功、逐步操作、期望与实际、环境版本;复现失败则写清缺什么信息。',
        ),
      },
      {
        name: '定位根因',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.diagnose,
        effort: 'high',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'has_body_section("复现步骤") && no_open_blockers',
        exitChecklist: '根因定位到具体模块或提交;给出证据链;列出拟修复方向与风险。',
        promptTemplate: aiPrompt(
          '你负责问题单的根因定位。在已能复现的前提下沿调用链与近期改动追查,把根因钉到具体模块、函数或提交,不要急着改代码。',
          '产出用 Markdown,写清:根因判断、证据(日志/堆栈/代码位置)、排除过的假说、建议修复点与回归风险。',
        ),
      },
      {
        name: '修复',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.implement,
        effort: 'high',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'last_run_succeeded && no_open_blockers',
        exitChecklist: '代码已改且范围收敛;说明改了什么;本地相关测试或复现步骤已跑过。',
        promptTemplate: aiPrompt(
          '你负责按已确认的根因修复问题单。只改与根因相关的最小范围,补必要测试,不要顺手重构无关代码。',
          '产出用 Markdown,写清:改动文件与要点、如何验证、残留风险。验证命令与结果必须写进正文,未跑通不得声称已修。',
        ),
      },
      {
        name: '自验',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.verify,
        effort: 'medium',
        onSuccess: 'wait_human',
        requireHumanAck: true,
        entryCondition: 'no_open_blockers',
        exitChecklist: '复现路径已再走一遍;回归面已评估;结论为通过或打回并写明理由。',
        promptTemplate: aiPrompt(
          '你负责问题单修复后的自验审查。独立按复现步骤再走一遍,核对修复是否真正消除缺陷、有无回归,不要自己再改一版代码。',
          '产出用 Markdown,写清:验证步骤与结果、是否通过、发现的问题、给确认人的一句话建议(通过/打回)。',
        ),
      },
      {
        name: '待我确认',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
      {
        name: '完成',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
    ],
  },
  {
    type: 'feature',
    name: '需求单默认流水线',
    stages: [
      {
        name: '需求澄清',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.triage,
        effort: 'medium',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'no_open_blockers',
        exitChecklist: '目标用户与场景清楚;验收标准可测;开放问题已列出。',
        promptTemplate: aiPrompt(
          '你负责需求单的澄清。把模糊描述收成可执行的问题定义:谁、在什么场景、要达成什么、怎样算完成。不要开始写代码。',
          '产出用 Markdown,写清:问题陈述、目标用户、范围内外、可测验收标准、待确认问题。有歧义必须提问,禁止臆造需求。',
        ),
      },
      {
        name: '方案设计',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.design,
        effort: 'high',
        onSuccess: 'wait_human',
        requireHumanAck: true,
        entryCondition: 'no_open_blockers',
        exitChecklist: '方案可落地;关键接口与数据流已画清;风险与备选已写。',
        promptTemplate: aiPrompt(
          '你负责需求单的方案设计。基于已澄清的需求调研现有代码与约束,给出可落地的实现方案,供人确认后再开工。不要直接改仓库。',
          '产出用 Markdown,写清:推荐方案、关键模块与数据流、接口或表结构、风险与备选、工作量粗估。方案必须能被实现阶段直接执行。',
        ),
      },
      {
        name: '我确认方案',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
      {
        name: '实现',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.implement,
        effort: 'high',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'has_comment_from(human) && no_open_blockers',
        exitChecklist: '按确认方案落地;测试已跑;偏离方案之处已标明。',
        promptTemplate: aiPrompt(
          '你负责按已确认方案实现需求单。严格沿方案改代码,偏离必须先写进评论说明原因,不要偷偷扩范围。',
          '产出用 Markdown,写清:落地了哪些点、文件清单、验证命令与结果、已知限制。未跑通测试不得声称实现完成。',
        ),
      },
      {
        name: '自验+审查',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.verify,
        effort: 'medium',
        onSuccess: 'wait_human',
        requireHumanAck: true,
        entryCondition: 'no_open_blockers',
        exitChecklist: '对照验收标准逐条核对;给出通过或打回;风险已披露。',
        promptTemplate: aiPrompt(
          '你负责需求实现后的自验与审查。对照验收标准独立核对行为、边界和回归,指出缺口,不要在审查阶段继续堆功能。',
          '产出用 Markdown,按验收标准逐条写通过/失败、缺陷与风险、给确认人的建议。审查意见必须具体到文件或步骤。',
        ),
      },
      {
        name: '待我确认',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
      {
        name: '完成',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
    ],
  },
  {
    type: 'spike',
    name: '调研单默认流水线',
    stages: [
      {
        name: '明确问题',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.triage,
        effort: 'medium',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'no_open_blockers',
        exitChecklist: '调研问题一句话可复述;成功标准清楚;范围已收束。',
        promptTemplate: aiPrompt(
          '你负责调研单的问题定义。把开放式好奇收成一个可回答的问题,明确成功标准、范围和不做项,为后续检索划界。不要开始长篇检索。',
          '产出用 Markdown,写清:核心问题、为何现在要答、范围内外、成功标准、已知线索。问题必须具体到能被检索阶段执行。',
        ),
      },
      {
        name: '检索调研',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.research,
        effort: 'high',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'no_open_blockers',
        exitChecklist: '关键来源已列出;事实与观点已分开;矛盾处已标明。',
        promptTemplate: aiPrompt(
          '你负责调研单的检索。围绕已明确的问题查代码、文档与外部资料,收集证据,不要急着给最终决策。',
          '产出用 Markdown,写清:检索路径、关键发现(带来源)、被排除的说法、仍不确定的点。禁止无来源的断言。',
        ),
      },
      {
        name: '结论汇总',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.report,
        effort: 'medium',
        onSuccess: 'wait_human',
        requireHumanAck: true,
        entryCondition: 'no_open_blockers',
        exitChecklist: '结论可执行;依据已引用;建议的下一步明确。',
        promptTemplate: aiPrompt(
          '你负责把调研发现收成结论。综合检索结果给出可执行判断与建议,供人确认,不要再开一轮无边界搜索。',
          '产出用 Markdown,写清:结论(先写答案)、依据摘要、备选与取舍、建议的下一步。结论必须直接回答「明确问题」阶段的那一句。',
        ),
      },
      {
        name: '待我确认',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
    ],
  },
  {
    type: 'chore',
    name: '杂务单默认流水线',
    stages: [
      {
        name: '执行',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.implement,
        effort: 'medium',
        onSuccess: 'advance',
        requireHumanAck: false,
        entryCondition: 'no_open_blockers',
        exitChecklist: '要求的动作已做完;产物或命令结果已留下;未做项已说明。',
        promptTemplate: aiPrompt(
          '你负责把杂务单执行完。按描述做完指定动作(改配置、跑脚本、整理文件等),范围外的事不要顺手做。',
          '产出用 Markdown,写清:做了什么、命令或文件产物、结果是否符合预期、需要人接手的残留。没有证据不要声称已完成。',
        ),
      },
      {
        name: '自验',
        kind: 'ai',
        agentId: SEED_AGENT_IDS.verify,
        effort: 'low',
        onSuccess: 'wait_human',
        requireHumanAck: true,
        entryCondition: 'no_open_blockers',
        exitChecklist: '对照原要求核对产物;通过或打回理由清楚。',
        promptTemplate: aiPrompt(
          '你负责杂务执行后的自验。对照原要求核对产物和副作用,确认做完且没弄坏周边,不要在这一步继续改需求。',
          '产出用 Markdown,写清:核对项与结果、是否通过、发现的问题。给确认人一句明确建议。',
        ),
      },
      {
        name: '待我确认',
        kind: 'human',
        agentId: null,
        effort: null,
        onSuccess: 'advance',
        requireHumanAck: true,
        entryCondition: null,
        exitChecklist: null,
        promptTemplate: null,
      },
    ],
  },
]

// 分隔符用 `.` 而不是 `::`:stageId 会被拼进巡检 sessionKey
// (`agent:<agentId>:taskboard:<ticketId>:<stageId>:<runId>`),而现网多处按冒号切段
// 解析 sessionKey。id 里带冒号会让段数漂移、解析静默错位,也让日志难读。
// 这两个 id 从不被反向解析,只要确定性且唯一即可。
export function pipelineSeedId(projectId: string, type: TicketType): string {
  return `${projectId}.pipeline.${type}`
}

export function stageSeedId(projectId: string, type: TicketType, ordinal: number): string {
  return `${projectId}.stage.${type}.${ordinal}`
}

export interface SeedResult {
  projectId: string
  createdPipelines: number
  createdStages: number
  skippedPipelines: number
  skippedStages: number
}

export function builtinTemplateId(type: TicketType): string {
  return `builtin:${type}`
}

export function parseBuiltinTemplateId(id: string): TicketType | null {
  const m = /^builtin:(bug|feature|spike|chore)$/.exec(id.trim())
  return m ? (m[1] as TicketType) : null
}

export interface BuiltinPipelineTemplate {
  id: string
  ticketType: TicketType
  name: string
  stages: StageSeed[]
  patrolCron: string
  quietHoursStart: number
  quietHoursEnd: number
  timeoutSec: number
  circuitBreakerThreshold: number
}

/** 内置模板 = 种子流水线,同一份定义。id 形如 builtin:bug。 */
export function listBuiltinPipelineTemplates(): BuiltinPipelineTemplate[] {
  return PIPELINES.map((pipe) => ({
    id: builtinTemplateId(pipe.type),
    ticketType: pipe.type,
    name: pipe.name,
    stages: pipe.stages,
    patrolCron: DEFAULT_PATROL_CRON,
    quietHoursStart: GUARDRAIL_DEFAULTS.quietHoursStart,
    quietHoursEnd: GUARDRAIL_DEFAULTS.quietHoursEnd,
    timeoutSec: GUARDRAIL_DEFAULTS.defaultTimeoutSec,
    circuitBreakerThreshold: GUARDRAIL_DEFAULTS.circuitBreakerThreshold,
  }))
}

export function getBuiltinPipelineTemplate(idOrType: string): BuiltinPipelineTemplate | null {
  const type = parseBuiltinTemplateId(idOrType) ?? (idOrType as TicketType)
  return listBuiltinPipelineTemplates().find((t) => t.ticketType === type) ?? null
}

/**
 * 给项目种默认流水线。types 缺省 = 四种全种;传入子集则只种那些类型。
 * 幂等:已有确定性 id 的 pipeline/stage 跳过,不覆盖用户改过的提示词。
 */
export function seedDefaultPipelines(
  db: TaskboardDb,
  projectId: string,
  types?: TicketType[],
): SeedResult {
  const project = db.prepare('SELECT id FROM tb_project WHERE id = ?').get(projectId) as
    | { id: string }
    | undefined
  if (!project) throw new TaskboardNotFound('project', projectId)

  const selected = types?.length ? PIPELINES.filter((p) => types.includes(p.type)) : PIPELINES

  const result: SeedResult = {
    projectId,
    createdPipelines: 0,
    createdStages: 0,
    skippedPipelines: 0,
    skippedStages: 0,
  }

  const seed = db.transaction(() => {
    for (const pipe of selected) {
      const pid = pipelineSeedId(projectId, pipe.type)
      if (getPipeline(db, pid)) {
        result.skippedPipelines += 1
      } else {
        createPipeline(db, {
          id: pid,
          projectId,
          name: pipe.name,
          ticketType: pipe.type,
          isDefault: true,
        })
        result.createdPipelines += 1
      }

      pipe.stages.forEach((stage, ordinal) => {
        const sid = stageSeedId(projectId, pipe.type, ordinal)
        if (getStage(db, sid)) {
          result.skippedStages += 1
          return
        }
        const isAi = stage.kind === 'ai'
        createStage(db, {
          id: sid,
          pipelineId: pid,
          ordinal,
          name: stage.name,
          kind: stage.kind,
          agentId: stage.agentId,
          promptTemplate: stage.promptTemplate,
          exitChecklist: stage.exitChecklist,
          entryCondition: stage.entryCondition,
          onSuccess: stage.onSuccess,
          onFailure: isAi ? 'retry' : 'wait_human',
          requireHumanAck: stage.requireHumanAck,
          effort: stage.effort,
          patrolCron: isAi ? DEFAULT_PATROL_CRON : null,
          patrolEnabled: isAi,
          patrolTimezone: 'Asia/Shanghai',
          quietHoursStart: GUARDRAIL_DEFAULTS.quietHoursStart,
          quietHoursEnd: GUARDRAIL_DEFAULTS.quietHoursEnd,
          maxRunsPerDay: isAi ? 8 : 0,
          timeoutSec: GUARDRAIL_DEFAULTS.defaultTimeoutSec,
          maxRetries: isAi ? 2 : 0,
          circuitBreakerThreshold: GUARDRAIL_DEFAULTS.circuitBreakerThreshold,
        })
        result.createdStages += 1
      })
    }
  })
  seed.immediate()
  return result
}

/** 测试与文档用:导出种子定义的阶段名,避免测试手抄一份。 */
export function listSeedStageNames(type: TicketType): string[] {
  const pipe = PIPELINES.find((p) => p.type === type)
  return pipe ? pipe.stages.map((s) => s.name) : []
}
