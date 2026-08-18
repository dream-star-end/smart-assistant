// openclaude-memory MCP server 对模型暴露的工具「完整定义」纯数据模块。
//
// 为什么单独成文件:index.ts 是带顶层 await + stdio server.connect 的入口模块,单测直接
// import 会真的去连 stdio transport(见 delegateFanout.ts 同款理由)。把 TOOLS /
// SKILL_PROPOSE_TOOL 抽成零副作用纯数据后,`__tests__/toolNames.test.ts` 能直接 import
// 断言「TOOLS 的 name 序列 === toolNames.ts 的 MEMORY_MCP_TOOL_NAMES」,把两处名单锁步——
// 新增工具漏登记任一侧都会红(前端漏登记会把工具卡渲染成「记忆: <英文>」兜底标签)。
//
// NOTE: recall/archival 工具(session_search / archival_*)有意不在此表——它们已迁到
// 一次性 `oc-memory` CLI(持久 stdio 传输脆弱,崩溃会挂死 codex);Core `memory` 工具
// 已彻底退役(memdir — Core 记忆改为直接文件编辑)。切勿在此回加。

export const TOOLS = [
  {
    name: 'skill_list',
    description: [
      'List all skills you have accumulated. Returns name + description for each.',
      'Always check this first when starting a new task — you may already have a skill for it.',
      'Token-cheap: returns metadata only. Use `skill_view` to load full instructions.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_search',
    description: [
      'Search available skills by name, description, tags, and related_skills.',
      'Use this before `skill_view` when you need a relevant skill but do not know its exact name.',
      'Also use this before `skill_save` to avoid creating duplicate skills.',
      'Returns metadata only; call `skill_view(name)` for full instructions.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query, e.g. "deploy", "定时任务", "skill search"',
        },
        limit: {
          type: 'number',
          default: 5,
          description: 'Max results to return (clamped to 1..25)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_view',
    description: [
      'Load the full instructions of a named skill (tier-2 progressive disclosure).',
      'Optionally pass `subfile` to load a referenced file inside the skill directory.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        subfile: {
          type: 'string',
          description: 'Optional path inside the skill dir, e.g. references/api.md',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'skill_save',
    description: [
      'Distill a successful task resolution into a reusable skill for future use.',
      'Call this AFTER completing a complex multi-step task that could reasonably come up again.',
      '',
      'Provide:',
      '  name        — lowercase, hyphenated, unique (a-z 0-9 -, max 64 chars)',
      '  description — 1-2 sentence summary of when to use it (max 1024 chars)',
      '  body        — full markdown instructions: overview, prerequisites, steps, examples',
      '  tags        — optional array of topical tags',
      '  force       — optional; set true to skip the near-duplicate check',
      '',
      'Before creating a NEW skill, this checks whether a semantically similar',
      'skill already exists. If one does, the save is declined with a pointer to',
      'it — prefer updating that skill (skill_save with its name) over adding a',
      'near-duplicate. Pass force:true to create anyway.',
      '',
      'The skill is stored under your agent home and will appear in `skill_list` next session.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        force: { type: 'boolean' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  {
    name: 'skill_delete',
    description:
      'Delete a skill by name. Use sparingly — only when the skill is clearly wrong or obsolete.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  // ── Reminder / scheduled task ──
  // 定时任务的唯一权威 = gateway cron(与网页「管理中心 → 定时任务」同一数据),
  // 本工具族(create/list/update/delete)全部经 gateway /api/cron* 读写。
  {
    name: 'create_reminder',
    description: [
      '创建一个定时提醒或定时任务。用户说"5分钟后提醒我吃饭"或"每天9点晨练"时使用此工具。',
      '',
      'schedule 格式为 5 字段 crontab: 分 时 日 月 周 (用户本地时区)。',
      '- 相对时间:"5分钟后" → 计算出具体的分和时,构造一次性 cron',
      '- 绝对时间:"15:30" → "30 15 <今日> <本月> *"',
      '- 重复:"每天9点" → "0 9 * * *"',
      '',
      'oneshot=true 表示只执行一次,false 表示重复执行。',
      '',
      'kind="reminder"(默认): message 作为提醒内容原样播报给用户。',
      'kind="task": message 作为到点要执行的任务指令(如"汇总本周进展并推送"),届时会真的执行。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        schedule: { type: 'string', description: '5字段 crontab 表达式 (用户本地时区)' },
        message: { type: 'string', description: '提醒内容或任务指令' },
        oneshot: { type: 'boolean', description: '是否一次性 (默认 true)', default: true },
        kind: {
          type: 'string',
          enum: ['reminder', 'task'],
          description: 'reminder=到点播报内容(默认); task=到点执行 message 里的任务指令',
        },
        deliver: {
          type: 'string',
          enum: ['webchat', 'local'],
          description: '结果送达方式: webchat=推送到网页对话(默认); local=仅记录不打扰',
        },
      },
      required: ['schedule', 'message'],
    },
  },
  {
    name: 'list_reminders',
    description:
      '列出当前所有定时提醒/定时任务(与网页管理中心「定时任务」同一份数据)。用户问"我有哪些定时任务/提醒"时使用。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_reminder',
    description: [
      '修改一个已存在的定时提醒/任务(id 来自 list_reminders)。只传要改的字段:',
      'schedule(5字段 crontab)/ message(内容或指令,按原任务语义)/ label(标题,空串=清空)/',
      'enabled(启停)/ oneshot(一次性↔重复)/ deliver(webchat|local)。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID (来自 list_reminders)' },
        schedule: { type: 'string', description: '新的 5 字段 crontab' },
        message: { type: 'string', description: '新的提醒内容/任务指令(整体替换)' },
        label: { type: 'string', description: '新标题;空串=清空' },
        enabled: { type: 'boolean', description: '启用/停用' },
        oneshot: { type: 'boolean', description: '一次性(true)或重复(false)' },
        deliver: { type: 'string', enum: ['webchat', 'local'], description: '送达方式' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_reminder',
    description: '删除一个定时提醒/任务(id 来自 list_reminders)。用户说"取消/删掉那个提醒"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 ID (来自 list_reminders)' },
      },
      required: ['id'],
    },
  },
  // ── Inter-agent communication ──
  {
    name: 'send_to_agent',
    description: [
      '向另一个 agent 发送消息。目标 agent 会在后台处理,结果推送给用户。',
      '用于多 agent 协作: 让专业 agent 处理特定子任务。',
      '',
      '示例: send_to_agent(agentId="research", message="帮我查一下 React 19 新特性")',
      '',
      '注意: 这是异步操作,你不会收到目标 agent 的回复。回复会直接推送给用户。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '目标 agent ID (必须已存在)' },
        message: { type: 'string', description: '发送给目标 agent 的消息/任务' },
      },
      required: ['agentId', 'message'],
    },
  },
  // ── Synchronous task delegation ──
  {
    name: 'delegate_task',
    description: [
      '将单个任务委派给另一个 agent 并等待结果返回。与 send_to_agent 不同,这是同步操作 — 你会直接收到子 agent 的执行结果。',
      '',
      '适用场景:',
      '- 需要专业 agent 处理后你还要继续用结果的场景',
      '- 需要隔离上下文的子任务',
      '(多个互相独立的子任务请改用 `delegate_tasks` 一次并行派发,不要连续多次单独调用本工具。)',
      '',
      '产物纪律(重要):你和子 agent 在同一台容器、共享文件系统。子 agent 的大产物',
      '(完整代码/长文档/数据文件/报告)应写入 `/home/agent/.openclaude/generated/<描述性文件名>`,',
      '回传只给「文件路径 + ≤1500 字的蒸馏摘要」;小结果(结论/短答案)直接回传即可。',
      '因此本工具的返回是「摘要/路径」,不是完整产物 —— 需要完整内容时用 Read 读回传路径。',
      '',
      '限制: 最大递归深度 3 层,最大并发 5 个,单个队长每 turn 委派次数有上限(超限会返回可读错误,请先整合已有结果再决定是否继续)。',
      '',
      '默认每次新开会话。工具结果会回传 sessionKey;下一轮要对同一成员续跑时传入 resumeSessionKey。',
      '进行中不要重复 resume,改用 oc-memory delegate-wait。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description:
            '目标平台成员 id(可选,不填则派给 main)。只能是 coding-assistant / explorer 这类成员,不要填型号。',
        },
        model: {
          type: 'string',
          description:
            '可选:本次子任务使用的 catalog 型号(如 cursor-grok-4.6-high-fast、gpt-5.6-sol)。覆盖该成员默认模型;不填则用成员绑定。',
        },
        goal: { type: 'string', description: '委派任务的目标描述' },
        context: { type: 'string', description: '传递给子 agent 的上下文信息 (可选)' },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            '可选:子 agent 本次任务的思考量级 —— 机械/简单子任务用 "low",常规用 "medium",攻坚/高难度用 "high";不填则用该成员的默认档位。',
        },
        toolsets: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选:为子 agent 额外授予的平台工具集名(目前仅 "browser";网页提取/论文下载已是常驻 CLI——oc-web / scansci-pdf,无需工具集)。通常无需手动指定 —— 系统会按任务目标自动挂载;只能授予平台已配置的工具集,无法越权,填错或填不存在的名字会被忽略而非报错。',
        },
        resumeSessionKey: {
          type: 'string',
          description:
            '可选:续跑上一轮同成员委派。值必须是该工具上次返回的 sessionKey;缺省仍新开会话。',
        },
      },
      required: ['goal'],
    },
  },
  // ── 并行 fan-out 委派 ──
  {
    name: 'delegate_tasks',
    description: [
      '一次把多个**互相独立**的子任务并行委派给成员并等待全部返回(fan-out)。',
      '各子任务并发执行、互不依赖,单个失败不影响其余(每项独立标注 ✅/❌)。',
      '',
      '仅用于「彼此独立、可同时进行」的子任务;有先后依赖(B 需要 A 的产出)时,',
      '请分步用 `delegate_task` 串行委派,不要塞进本工具。单次最多 4 个并行子任务。',
      '',
      '产物纪律同 `delegate_task`:大产物落 `/home/agent/.openclaude/generated/<文件名>`,',
      '回传给路径 + ≤1500 字摘要;拿到聚合结果后由你综合成给用户的最终答案。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: '并行委派的子任务列表(1-4 项,彼此独立)。',
          items: {
            type: 'object',
            properties: {
              agentId: {
                type: 'string',
                description: '目标平台成员 id(可选,不填则派给 main)。不要填型号。',
              },
              model: {
                type: 'string',
                description:
                  '可选:该子任务的 catalog 型号,覆盖成员默认模型(同 delegate_task)。',
              },
              goal: { type: 'string', description: '该子任务的目标描述' },
              context: { type: 'string', description: '传递给子 agent 的上下文信息 (可选)' },
              effort: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: '可选:该子任务的思考量级 low/medium/high,不填则用成员默认档位。',
              },
              toolsets: {
                type: 'array',
                items: { type: 'string' },
                description: '可选:为该子 agent 额外授予的平台工具集名(同 delegate_task)。',
              },
              resumeSessionKey: {
                type: 'string',
                description: '可选:续跑该子任务上一轮 sessionKey(同 delegate_task)。',
              },
            },
            required: ['goal'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  // ── 团队质量审查(队长自主送审,2026-07-07) ──
  {
    name: 'request_review',
    description: [
      '【仅团队模式】把你准备提交给用户的**完整答复草稿**送独立质量审查员审查,',
      '返回审查意见与结构化裁决(`VERDICT: PASS` / `VERDICT: NEEDS_FIX`)。',
      '',
      '使用纪律:除非任务明显简单(单一事实问答/寒暄/无实质交付物),组队完成的任务',
      '在写最终答复**之前**都应送审;草稿只放本工具参数,不要先写进给用户的正文。',
      'NEEDS_FIX → 修订草稿后可再送审一次(对误报可在 revisionNote 据理反驳);',
      'PASS → 直接输出最终答复。审查有每轮次数上限,达到上限就输出当前最优终稿。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        draft: {
          type: 'string',
          description: '准备提交给用户的完整答复草稿(全文,不是摘要)。',
        },
        revisionNote: {
          type: 'string',
          description: '可选:二次送审时说明你针对上轮审查意见做了什么修订/反驳了哪些误报。',
        },
        resumeSessionKey: {
          type: 'string',
          description:
            '可选:续跑上一轮 hidden-reviewer。值必须是上次 request_review 返回的 sessionKey。',
        },
      },
      required: ['draft'],
    },
  },
  // ── 任务面板(与网页 /board、oc-task CLI 同一份 /api/board)──
  // identifier 服务端生成,工具参数禁止收 identifier/userId/originSessionKey。
  // originSessionKey 由 handler 从 OPENCLAUDE_SESSION_KEY 注入,卡片才能点回原对话。
  {
    name: 'task_create',
    description: [
      '在任务面板建一张单据。用户说「把这个记成单 / 开一张问题单 / 记到任务面板」时使用。',
      '',
      '不要传 identifier(服务端生成,返回后再用)。不要传 userId。',
      '当前对话会自动挂到单据上,卡片可点回本会话。',
      '新建单默认 backlog(未批准),AI 不许认领;等人在面板点开工。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: '项目 uuid 或 key(如 OCV5)。先 task_list / oc-task project list 确认',
        },
        type: {
          type: 'string',
          enum: ['bug', 'feature', 'spike', 'chore'],
          description: 'bug 问题单 / feature 需求单 / spike 调研 / chore 杂务',
        },
        title: { type: 'string', description: '标题' },
        body: { type: 'string', description: 'Markdown 正文(复现步骤/需求说明)' },
        priority: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3'],
          description: '优先级,默认 P2',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'major', 'minor', 'trivial'],
          description: '仅 bug 有意义',
        },
        labels: { type: 'array', items: { type: 'string' }, description: '标签' },
        assignee: { type: 'string', description: 'user:<id> 或 agent:<agentId>' },
      },
      required: ['projectId', 'type', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_update',
    description: [
      '更新任务单字段(标题/正文/优先级等),不走路状态机。',
      'id 必须是面板返回的 identifier 或 uuid,禁止自己拼 OCV5-<n>。',
      'expectedVersion 必填;409 时 task_get 重读后只重试一次,禁止抢别人的 lease。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '面板返回的 identifier 或 uuid' },
        expectedVersion: { type: 'number', description: '乐观锁,来自最近一次 get/create' },
        title: { type: 'string' },
        body: { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        severity: { type: 'string', enum: ['critical', 'major', 'minor', 'trivial'] },
        labels: { type: 'array', items: { type: 'string' } },
        assignee: { type: 'string' },
        blockedReason: { type: 'string' },
      },
      required: ['id', 'expectedVersion'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_comment',
    description: [
      '给任务单写一条评论。做完必须写:改了什么 / 怎么验的 / 有什么风险,再 advance。',
      'id 只用面板返回值。评论不升 version。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '面板返回的 identifier 或 uuid' },
        body: { type: 'string', description: 'Markdown 评论' },
        runId: { type: 'string', description: '可选,关联某次 run' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_list',
    description: [
      '列出任务单。对话里要找「待确认 / 某项目的卡」时用。',
      '返回 identifier+status+version,后续操作只用返回值,不要自己推导编号。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 uuid 或 key' },
        status: {
          type: 'string',
          description: '单个或逗号分隔: backlog,ready,running,waiting_human,blocked,done,canceled',
        },
        type: { type: 'string', description: 'bug/feature/spike/chore,可逗号分隔' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        assignee: { type: 'string' },
        q: { type: 'string', description: '模糊搜 title / identifier / body' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task_get',
    description: [
      '读取一张任务单及其评论。动手前必须先 get + 看评论(可能有返工要求)。',
      'id 只用面板返回的 identifier 或 uuid。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '面板返回的 identifier 或 uuid' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  // (v5 ccb-only:ask_gpt55_codex direct bridge 已移除 —— 无 codex agent。)
  // ── 引擎交互提问桥(cursor 等无原生交互工具的引擎,2026-08-17) ──
  {
    name: 'ask_user',
    description: [
      '向当前会话的网页用户提出选择题。调用后立即返回(不阻塞、不等待)。',
      '返回后必须立刻结束本回合;用户的选择会作为下一条普通用户消息到达。',
      '不要轮询,也不要对同一问题再次调用 ask_user。一次最多 4 个问题,每个 2-4 个选项。',
      '必须在当前会话有活跃 turn 时调用;子 agent 环境会直接返回 skipped,',
      '此时自行决策或在最终答复里列编号选项让用户文字作答。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: '问题列表;question 为题面,options 为可点选的选项。',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '题面(必填)' },
              header: { type: 'string', description: '可选短标签(≤12 字符)' },
              multiSelect: { type: 'boolean', description: '可选,是否允许多选' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项文案(必填)' },
                    description: { type: 'string', description: '选项补充说明' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
]

/**
 * ask_user 的 questions 收敛器:宽松接受模型输入,严格产出产品
 * AskUserQuestion 形态(question/header≤12/multiSelect 仅 true/options 白名单)。
 * 返回 null = 输入结构不可用(调用方报工具错误,不发起网关请求)。
 * 与网关侧 sanitizeEngineAskUserQuestions 语义对齐 —— 两份实现分属不同
 * 包与不同信任域,不共享依赖,修改时必须同步。
 */
export function normalizeAskUserQuestions(raw: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null
  const questions: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const question = (item as { question?: unknown }).question
    if (typeof question !== 'string' || question.trim().length === 0 || question.length > 2000) {
      return null
    }
    const optionsRaw = (item as { options?: unknown }).options
    if (!Array.isArray(optionsRaw) || optionsRaw.length < 2 || optionsRaw.length > 4) return null
    const options: Array<Record<string, unknown>> = []
    for (const opt of optionsRaw) {
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null
      const label = (opt as { label?: unknown }).label
      if (typeof label !== 'string' || label.trim().length === 0 || label.length > 300) {
        return null
      }
      const description = (opt as { description?: unknown }).description
      options.push({
        label,
        ...(typeof description === 'string' && description.length > 0 && description.length <= 1000
          ? { description }
          : {}),
      })
    }
    const header = (item as { header?: unknown }).header
    const multiSelect = (item as { multiSelect?: unknown }).multiSelect
    questions.push({
      question,
      ...(typeof header === 'string' && header.length > 0 ? { header: header.slice(0, 12) } : {}),
      ...(multiSelect === true ? { multiSelect: true } : {}),
      options,
    })
  }
  return questions
}

// Draft-only skill proposal tool. Exposed ONLY inside a skill-training session
// (OPENCLAUDE_SKILL_TRAIN_RUN_ID set). Stages a candidate change into the run's draft
// area; it never touches the authoritative library. The user reviews each draft as a
// diff and confirms the merge afterward.
export const SKILL_PROPOSE_TOOL = {
  name: 'skill_propose',
  description: [
    'Stage a candidate skill change for the current training run (draft only — NOT applied).',
    'The user reviews your proposals as a diff and confirms the merge afterward.',
    '',
    'Provide:',
    '  name        — target skill name (lowercase a-z 0-9 -, max 64 chars)',
    '  op          — "create" (new skill), "update" (revise existing), or "delete" (propose removal)',
    '  description — when-to-use summary (required for create/update, max 1024 chars)',
    '  body        — full SKILL.md instructions (required for create/update)',
    '  tags        — optional topical tags',
    '  rationale   — one paragraph citing the evidence sessions for this change',
    '  evals       — optional eval cases ({version:1, cases:[{id,prompt,assertions[]}]}).',
    '                REQUIRED when the target skill has no evals yet (2-3 realistic cases,',
    '                3-5 decidable assertions each) — they become its acceptance baseline.',
    '',
    'Only USER-AUTHORED skills can be proposed against; platform baseline/agent-seed skills are rejected.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      op: { type: 'string', enum: ['create', 'update', 'delete'] },
      description: { type: 'string' },
      body: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
      evals: { type: 'object' },
    },
    required: ['name', 'op', 'rationale'],
  },
}
