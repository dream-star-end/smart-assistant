import type { ProductFeatureId } from './productCapabilities'

export const TUTORIAL_CASE_IDS = [
  'research-evidence-map',
  'research-bike-demand',
  'research-systematic-screening',
  'research-open-peer-review',
  'research-replication-audit',
  'coding-swe-bench-fix',
  'coding-feature-delivery',
  'coding-regression-rescue',
  'coding-frontend-quality',
  'coding-dependency-upgrade',
  'general-meeting-actions',
  'general-public-data-brief',
] as const

export type TutorialCaseId = (typeof TUTORIAL_CASE_IDS)[number]
export type TutorialCaseCategory = 'research' | 'coding' | 'general'
export type TutorialCaseDifficulty = '入门' | '进阶' | '挑战'

export type TutorialCaseSource = {
  title: string
  url: string
  role: 'need-evidence' | 'input' | 'method' | 'license'
  license: string
  usageNote: string
}

export type TutorialCaseInput = {
  title: string
  description: string
  sourceUrl?: string
  assetPath?: string
  /** Immutable upstream revision, capture date, or inline template version. */
  revision: string
  /** SHA-256 of the exact downloaded bytes or inlineContent UTF-8 bytes. */
  sha256: string
  bytes: number
  inlineContent?: string
  preparation: string
}

export type TutorialCaseStage = {
  id: string
  title: string
  input: string
  operation: string
  visibleProcess: readonly string[]
  output: string
  acceptance: readonly string[]
}

export type TutorialCaseArtifact = {
  title: string
  format: string
  description: string
}

export type TutorialCaseCheck = {
  title: string
  method: string
  passCriterion: string
}

export type TutorialCaseFieldReport = {
  /** A real product run was observed, but it has not passed the public replay gate. */
  status: 'observed_not_verified'
  sourceLabel: string
  sourceUrl: string
  userScene: string
  obstacle: string
  input: string
  duration: string
  journey: readonly {
    title: string
    evidence: string
  }[]
  metrics: readonly {
    label: string
    value: string
    detail: string
  }[]
  result: string
  limitations: readonly string[]
  visual: 'bike-model-comparison' | 'astropy-patch'
}

export type TutorialCaseSuggestion = {
  agentId: 'research-assistant' | 'coding-assistant' | 'office-assistant'
  agentName: '科研助手' | '编程助手' | '办公助手'
  modelId: 'deepseek-v4-flash' | 'glm-5.3-zai' | 'MiniMax-M3'
  modelGuidance: string
  why: string
}

export type TutorialCaseActualArtifact = {
  title: string
  path: string
  sha256: string
  bytes: number
  mimeType: string
}

export type TutorialCaseReplayManifestPage = {
  path: string
  sha256: string
  bytes: number
  messageCount: number
  startOrdinal: number
}

export type TutorialCaseReplayManifest = {
  schemaVersion: 1
  caseId: TutorialCaseId
  messageCount: number
  pages: readonly TutorialCaseReplayManifestPage[]
}

export type TutorialCaseReplayProvenance = {
  capturedAt: string
  release: string
  runIds: readonly string[]
  inputSha256: string
  messagesSha256: string
  messageCount: number
  bytes: number
  repeatRuns: number
  agentId: string
  modelId: string
  engine: 'ccb' | 'codex'
}

export type TutorialCaseReplay =
  | {
      status: 'pending_capture'
      disclosure: string
      messagesPath?: undefined
      provenance?: undefined
      poster?: undefined
      video?: undefined
      checkReport?: undefined
      actualArtifacts?: undefined
    }
  | {
      status: 'verified'
      disclosure: string
      messagesPath: string
      provenance: TutorialCaseReplayProvenance
      poster?: string
      video?: string
      checkReport: string
      actualArtifacts: readonly TutorialCaseActualArtifact[]
    }

export type TutorialCase = {
  id: TutorialCaseId
  contentVersion: number
  category: TutorialCaseCategory
  title: string
  summary: string
  audience: string
  difficulty: TutorialCaseDifficulty
  outcome: string
  capabilityIds: readonly ProductFeatureId[]
  requirements: readonly string[]
  sources: readonly TutorialCaseSource[]
  inputMaterials: readonly TutorialCaseInput[]
  starterPrompt: string
  stages: readonly TutorialCaseStage[]
  artifacts: readonly TutorialCaseArtifact[]
  checks: readonly TutorialCaseCheck[]
  suggestion: TutorialCaseSuggestion
  fieldReport?: TutorialCaseFieldReport
  replay: TutorialCaseReplay
}

const PENDING_REPLAY: TutorialCaseReplay = {
  status: 'pending_capture',
  disclosure:
    '本案例脚本已公开，但尚未完成三次独立运行与脱敏重放采集；页面不得把步骤说明展示成真实运行结果。',
}

export const TUTORIAL_CASES = [
  {
    id: 'research-evidence-map',
    contentVersion: 3,
    category: 'research',
    title: '从 30 篇论文到可追溯证据图谱',
    summary:
      '围绕“微塑料是否影响人体心血管健康”检索公开学术元数据，去重、筛选、逐条核验引文，再交付结论与证据边界。',
    audience: '需要快速建立课题证据底稿的研究生、科研人员与医学编辑',
    difficulty: '进阶',
    outcome:
      '一份每条判断都能回到 DOI/来源记录的证据表、冲突点清单和研究空白，而不是只有流畅摘要。',
    capabilityIds: ['web-research', 'artifacts-download', 'team-mode', 'files-media'],
    requirements: [
      '登录 V5，允许联网检索',
      '使用 2020-01-01 至执行日的英文同行评议研究作为范围',
      '不把相关性写成因果性，不根据标题补写实验结果',
    ],
    sources: [
      {
        title: 'OpenAlex API 与开放学术元数据',
        url: 'https://docs.openalex.org/',
        role: 'input',
        license: 'CC0',
        usageNote:
          '案例只缓存检索到的元数据、开放摘要索引和来源链接；全文仍遵守各出版物自己的许可。',
      },
      {
        title: 'Crossref REST API',
        url: 'https://www.crossref.org/documentation/retrieve-metadata/rest-api/',
        role: 'input',
        license: 'Crossref metadata is generally CC0；成员提供字段可能另有权利',
        usageNote: '用于核对 DOI、题名、年份与期刊，不批量再发布受保护摘要。',
      },
      {
        title: 'ScholarQABench / OpenScholar 研究',
        url: 'https://www.nature.com/articles/s41586-025-10072-4',
        role: 'need-evidence',
        license: '按文章页面标注的开放获取许可使用',
        usageNote:
          '仅链接并概述其对学术问答检索、引文正确性和可验证性的评测动机；运行前核对页面许可。',
      },
    ],
    inputMaterials: [
      {
        title: '检索协议.md',
        description: '固定研究问题、日期范围、纳排标准、关键词与结局指标，避免看过结果后再改规则。',
        sourceUrl:
          'https://docs.openalex.org/how-to-use-the-api/get-lists-of-entities/filter-entity-lists',
        assetPath: 'tutorialCaseCatalog.ts#research-evidence-map/search-protocol',
        revision: 'protocol-v1',
        sha256: '1b69f824f0174cb4e534ec2b7d323dce1d1f227a9f6a7499f76ecfa7eca66297',
        bytes: 152,
        inlineContent:
          'question=microplastics cardiovascular human\nfrom=2020-01-01\nto=2026-08-08\nlanguages=en\ninclude=peer-reviewed human studies\nexclude=title-only inference\n',
        preparation: '保存检索式和执行时间；请求 OpenAlex works 后把原始 JSON 原样留作审计附件。',
      },
      {
        title: 'OpenAlex 30 条固定响应.json',
        description: '按冻结检索式返回的 30 条原始 works JSON；后续候选 CSV 从这里确定性生成。',
        sourceUrl:
          'https://api.openalex.org/works?search=microplastics%20cardiovascular%20human&filter=from_publication_date:2020-01-01,to_publication_date:2026-08-08&sort=cited_by_count:desc&per-page=30',
        assetPath: '/tutorials/cases/research-evidence-map/inputs/openalex-works.json',
        revision: 'captured-2026-08-08',
        sha256: 'e4397d6d448d4b4d12e00a103f2fe707404ffd0705c83d25f4020ad4220d595b',
        bytes: 1655066,
        preparation: '先只填元数据；研究设计和结论必须在打开来源后再标注。',
      },
    ],
    starterPrompt: `你是我的科研证据助理。围绕“微塑料暴露是否影响人体心血管健康”，按附件中的检索协议工作：
1. 从 OpenAlex 检索并用 Crossref 核对 DOI，保留原始检索记录；
2. 先去重，再按预先声明的标准筛选，不得仅凭标题推断结果；
3. 为每项纳入研究记录设计、样本、暴露、结局、效应方向、局限和可点击来源；
4. 将“来源明示”“你的推断”“证据不足”分开；引用无法核验时删除判断而不是补写；
5. 输出 evidence.csv、evidence-map.md 和 search-log.json，并列出冲突证据与下一步研究问题。`,
    stages: [
      {
        id: 'protocol',
        title: '冻结问题与检索协议',
        input: '研究问题、日期范围与预设纳排标准。',
        operation: '复述 PICO/PECO 范围，生成可执行检索式，并在检索前保存协议。',
        visibleProcess: ['范围拆解', '检索式草拟', '协议文件写入'],
        output: '带时间戳的检索协议与查询 URL。',
        acceptance: ['检索前已保存协议', '每条标准可以做是/否判断'],
      },
      {
        id: 'retrieve',
        title: '检索、去重与初筛',
        input: 'OpenAlex/Crossref 返回及候选文献表。',
        operation: '按 DOI、OpenAlex ID 和规范化题名去重，记录每次排除的原因。',
        visibleProcess: ['联网请求', '去重脚本', '筛选计数与排除日志'],
        output: '原始结果、去重表和筛选流转表。',
        acceptance: ['原始返回未被覆盖', '纳入数与排除数可重算'],
      },
      {
        id: 'extract',
        title: '逐篇提取并核验',
        input: '纳入研究的元数据与可访问来源。',
        operation: '逐项提取研究设计和结果；无法从来源确认的字段标为未知。',
        visibleProcess: ['来源打开记录', '字段级证据摘录', 'DOI 反查'],
        output: '证据表和引文核验日志。',
        acceptance: ['每条核心判断有来源 URL', '未知值未被猜测填充'],
      },
      {
        id: 'synthesis',
        title: '综合证据而不越界',
        input: '已核验证据表。',
        operation: '按研究设计和结局分组，说明一致、冲突、偏倚与证据空白。',
        visibleProcess: ['分组统计', '冲突对照', '结论—引文回查'],
        output: '证据图谱、限制说明和可下载底稿。',
        acceptance: ['相关性不被表述为因果', '所有结论能反查到证据行'],
      },
    ],
    artifacts: [
      { title: 'evidence.csv', format: 'CSV', description: '逐研究结构化证据与来源。' },
      { title: 'evidence-map.md', format: 'Markdown', description: '结论、冲突、局限及研究空白。' },
      {
        title: 'search-log.json',
        format: 'JSON',
        description: '查询、时间、计数和 DOI 核验轨迹。',
      },
    ],
    checks: [
      {
        title: '引文可达性',
        method: '对输出中的 DOI/URL 发起 HEAD/GET 并核对题名。',
        passCriterion: '全部核心引文可达且题名一致；失败项不进入结论。',
      },
      {
        title: '证据闭环',
        method: '从每条总结反查 evidence.csv 的行号与来源。',
        passCriterion: '所有事实性结论均能反查，推断被显式标注。',
      },
    ],
    suggestion: {
      agentId: 'research-assistant',
      agentName: '科研助手',
      modelId: 'deepseek-v4-flash',
      modelGuidance: '优先选择擅长长上下文与工具调用的高推理模型；筛选阶段不必追求最高档。',
      why: '任务难点在检索留痕与逐条引文核验，不在生成更长的综述。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'research-bike-demand',
    contentVersion: 4,
    category: 'research',
    title: '公开数据到可复现的单车需求分析',
    summary:
      '用 UCI Bike Sharing 数据回答天气与通勤需求的关系，保留下载校验、数据字典、脚本、诊断图和可复跑环境。',
    audience: '想把“让 AI 分析表格”升级为可复现研究流程的数据分析者',
    difficulty: '进阶',
    outcome: '一套从原始压缩包到报告可一键重跑、数值可由测试复核的分析工程。',
    capabilityIds: ['files-media', 'artifacts-download', 'web-research', 'container-web-preview'],
    requirements: ['Python 3.11+', '允许下载公开数据', '所有随机过程固定 seed'],
    sources: [
      {
        title: 'UCI Bike Sharing Dataset',
        url: 'https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset',
        role: 'input',
        license: 'CC BY 4.0',
        usageNote: '报告和再分发数据时注明 Fanaee-T 与 Gama、UCI 页面及 DOI 10.24432/C5W894。',
      },
      {
        title: '原始论文 DOI',
        url: 'https://doi.org/10.1007/s13748-013-0040-3',
        role: 'method',
        license: '论文版权以出版页为准',
        usageNote: '仅引用方法和数据出处，不把出版商全文打包进教程。',
      },
    ],
    inputMaterials: [
      {
        title: 'Bike-Sharing-Dataset.zip',
        description: 'UCI 页面提供的 hour.csv、day.csv 与说明文件。',
        sourceUrl: 'https://archive.ics.uci.edu/static/public/275/bike+sharing+dataset.zip',
        assetPath: '/tutorials/cases/research-bike-demand/inputs/bike-sharing-dataset.zip',
        revision: 'uci-275-2026-08-08',
        sha256: 'b70182d0d0508e9abbb79306ce5c0cec34869000f8220175ac83d11dbe845401',
        bytes: 279992,
        preparation: '通过数据集页面下载，记录下载时间与 SHA-256；原始文件只读保存。',
      },
      {
        title: 'analysis-question.md',
        description: '主问题、主要结局、候选协变量、切分方案与禁止数据泄漏规则。',
        assetPath: 'tutorialCaseCatalog.ts#research-bike-demand/analysis-question',
        revision: 'question-v1',
        sha256: '16bf375a70712b9609a680b65708d2d4172c920d4d744d1cea3bc5b1410e838f',
        bytes: 134,
        inlineContent:
          'outcome=cnt\nquestion=weather association stratified by workingday\nsplit=chronological\nseed=20260808\nleakage_columns=casual,registered\n',
        preparation: '明确以时间顺序切分；cnt 与 casual/registered 的关系需要在建模前检查。',
      },
    ],
    starterPrompt: `读取 UCI Bike Sharing Dataset，不要改动原始文件。回答“天气变量对小时租赁量的关联在工作日与非工作日是否不同”。
先验证数据字典、缺失值、时间范围和 cnt=casual+registered；按时间顺序划分训练/测试，避免把目标拆分列泄漏进特征。建立一个可解释基线和一个非线性对照，报告测试集指标、残差诊断与不确定性；只谈关联，不宣称因果。
请创建 src/、tests/、requirements.txt、Makefile、report.md 和 figures/，让 make reproduce 能从原始压缩包重建全部表图。`,
    stages: [
      {
        id: 'ingest',
        title: '锁定数据与字典',
        input: 'UCI 压缩包和研究问题。',
        operation: '计算摘要哈希，以只读方式解压并把列名逐项映射到数据字典。',
        visibleProcess: ['文件读取', '哈希计算', '模式与恒等式检查'],
        output: 'data-manifest.json 与数据质量报告。',
        acceptance: ['原始文件哈希已记录', 'cnt 恒等式和时间范围有测试'],
      },
      {
        id: 'plan',
        title: '预先声明分析计划',
        input: '列字典、结局和候选变量。',
        operation: '标注泄漏变量，定义时间切分、基线、指标和交互项。',
        visibleProcess: ['特征审计', '时间切分预览', '计划文件 diff'],
        output: 'analysis-plan.md。',
        acceptance: ['测试集没有参与拟合', '指标在看结果前确定'],
      },
      {
        id: 'model',
        title: '建模与诊断',
        input: '训练集与冻结计划。',
        operation: '训练可解释基线和非线性对照，生成残差、分层和敏感性分析。',
        visibleProcess: ['代码执行', '测试指标', '图表产物'],
        output: '模型结果、图表和机器可读指标。',
        acceptance: ['所有数值来自脚本', '报告包含失败或无效的诊断'],
      },
      {
        id: 'reproduce',
        title: '从干净环境复跑',
        input: '代码、依赖锁定和原始数据。',
        operation: '清理派生文件后执行 make reproduce 与测试。',
        visibleProcess: ['环境安装', '完整命令日志', '产物哈希对比'],
        output: 'report.md、figures/ 与 reproduce.log。',
        acceptance: ['一条命令重建报告', '重复运行关键指标在声明容差内一致'],
      },
    ],
    artifacts: [
      { title: 'report.md', format: 'Markdown', description: '含限制、图表和数值来源的分析报告。' },
      {
        title: 'reproducible-project.zip',
        format: 'ZIP',
        description: '脚本、测试、依赖与数据清单。',
      },
    ],
    checks: [
      {
        title: '防泄漏测试',
        method: '测试特征列表不含 cnt、casual、registered 及未来记录。',
        passCriterion: '测试通过且时间切分边界与计划一致。',
      },
      {
        title: '干净复跑',
        method: '删除派生目录后运行 make reproduce 两次并比较指标 JSON。',
        passCriterion: '两次退出码为 0，关键指标差异不超过预设容差。',
      },
    ],
    suggestion: {
      agentId: 'research-assistant',
      agentName: '科研助手',
      modelId: 'deepseek-v4-flash',
      modelGuidance: '用高推理模型制定计划与审查泄漏；机械绘图和测试可交给更快模型。',
      why: '需要代码、统计解释与可复现性三条链同时闭合。',
    },
    fieldReport: {
      status: 'observed_not_verified',
      sourceLabel: 'UCI Bike Sharing 公开数据集',
      sourceUrl: 'https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset',
      userScene:
        '数据分析者拿到一份真实出行数据，不只想要“天气有关”的摘要，而是需要一套同事能够重新运行、逐项核对的分析工程。',
      obstacle:
        '17,379 条小时记录里既有时间顺序，也有会直接泄漏目标的 casual / registered 两列；随机切分或照单全收都会让结果看起来比实际更好。',
      input: 'UCI 原始 ZIP、数据字典，以及在看结果前冻结的分析问题和时间切分规则。',
      duration: '2 小时 35 分',
      journey: [
        { title: '锁定原始数据', evidence: '17,379 条小时记录、0 个缺失值，输入哈希固定。' },
        { title: '先拦住数据泄漏', evidence: '排除 casual / registered，并按时间顺序划分训练集和测试集。' },
        { title: '让两个模型正面对照', evidence: '同时训练可解释线性基线和非线性 GBM，不只挑最好看的结果。' },
        { title: '在干净环境重跑', evidence: '34 项测试通过；两次主要结果与报告哈希一致。' },
      ],
      metrics: [
        { label: 'GBM 测试集 R²', value: '0.904', detail: '线性基线为 0.714' },
        { label: 'GBM 测试集 RMSE', value: '68.36', detail: '线性基线为 117.81' },
        { label: '自动化验证', value: '34 项', detail: '数据、泄漏、切分与复现测试全部通过' },
      ],
      result: 'V5 交付了可复跑项目、分析报告、诊断图和机器可读指标，而不是一段无法复核的结论。',
      limitations: [
        '这次任务真实完成，但长连接采集先于任务结束，因此还没有可公开的完整逐帧回放。',
        '非负 IAD 指标的普通 bootstrap 区间只能说明重采样稳定性，不能当作零假设显著性检验。',
      ],
      visual: 'bike-model-comparison',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'research-systematic-screening',
    contentVersion: 3,
    category: 'research',
    title: '把系统综述筛选做成可审计流水线',
    summary:
      '以“生成式 AI 辅助编程对开发者生产率的实证研究”为主题，用公开元数据完成去重、双人式筛选模拟与 PRISMA 流程记录。',
    audience: '正在做系统综述、范围综述或选题调研的研究团队',
    difficulty: '挑战',
    outcome: '每条纳排决定有理由、计数可重算、分歧可复核的筛选包，而非不可追踪的论文清单。',
    capabilityIds: ['web-research', 'team-mode', 'artifacts-download', 'files-media'],
    requirements: ['仅使用公开题录/摘要', '先冻结 protocol 再筛选', 'AI 决定必须由研究者复核'],
    sources: [
      {
        title: 'PRISMA 2020 Statement',
        url: 'https://www.prisma-statement.org/prisma-2020-statement',
        role: 'method',
        license: '网站与清单许可按 PRISMA 页面标注',
        usageNote: '链接官方清单；若下载或改编图表，运行前核对其许可和署名要求。',
      },
      {
        title: 'Europe PMC REST API',
        url: 'https://europepmc.org/RestfulWebService',
        role: 'input',
        license: '元数据可通过开放 API 使用；摘要/全文权利逐条不同',
        usageNote: '教程只保存检索元数据和来源链接，不默认再分发全文。',
      },
      {
        title: 'OpenAlex 数据许可',
        url: 'https://docs.openalex.org/additional-help/faq#how-is-openalex-licensed',
        role: 'license',
        license: 'CC0',
        usageNote: '用于补充开放题录、概念和引用关系。',
      },
    ],
    inputMaterials: [
      {
        title: 'protocol.md',
        description: '研究问题、数据库、日期、检索式、纳排标准和冲突裁决规则。',
        assetPath: 'tutorialCaseCatalog.ts#research-systematic-screening/protocol',
        revision: 'protocol-v1',
        sha256: '004c2284c0f8607fb320c933a0684d9033ae0dcb1a9de7575c8b9af18f260afe',
        bytes: 151,
        inlineContent:
          'topic=generative AI and professional developer productivity\ndatabases=Europe PMC,OpenAlex\nfirst_pass=title,abstract\nunknown=maybe\nfinal_decision=human\n',
        preparation: '在任何检索结果进入上下文之前冻结版本并计算 SHA-256。',
      },
      {
        title: 'records.jsonl',
        description: 'Europe PMC 与 OpenAlex 原始响应按行保留，附数据库和查询批次。',
        sourceUrl:
          'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=%28generative%20AI%20OR%20large%20language%20model%29%20AND%20%28software%20developer%20OR%20programming%29%20AND%20productivity&format=json&pageSize=100',
        assetPath: '/tutorials/cases/research-systematic-screening/inputs/europe-pmc-records.json',
        revision: 'captured-2026-08-08',
        sha256: 'f30e288719041ac24b91ab82d428baabe3ee723e9c88f1f8544b2203ae7fa054',
        bytes: 81111,
        preparation: '保留响应原文；规范化副本另存，禁止覆盖来源字段。',
      },
    ],
    starterPrompt: `按照 protocol.md 对“生成式 AI 辅助编程是否提高专业开发者生产率”的实证研究做可审计筛选。
从 Europe PMC 与 OpenAlex 获取公开题录，保留查询和原始响应；按 DOI、题名和作者年份去重。第一轮只用题名/摘要，第二轮只在可合法访问时读取全文。请让两个独立子任务分别给出纳排建议，再列出分歧供我裁决；AI 不得替我做最终纳入决定。
输出 records.csv、decisions.csv、conflicts.csv、prisma-counts.json 和 README.md。每个排除项只能使用 protocol 中的理由代码，无法判断就标记 maybe。`,
    stages: [
      {
        id: 'freeze',
        title: '冻结协议',
        input: 'protocol.md。',
        operation: '检查标准是否互斥可判定，记录版本与哈希。',
        visibleProcess: ['协议校验', '哈希写入', '理由代码表生成'],
        output: '不可静默改写的协议快照。',
        acceptance: ['筛选前已有哈希', '排除理由均有稳定代码'],
      },
      {
        id: 'search',
        title: '多库检索与去重',
        input: '固定检索式与公开 API。',
        operation: '保存原始响应，生成规范化记录并用分层键去重。',
        visibleProcess: ['API 请求', '批次计数', '疑似重复对照'],
        output: 'records.jsonl、records.csv 与 dedupe-log.csv。',
        acceptance: ['数据库原始计数可重算', '模糊重复没有被静默删除'],
      },
      {
        id: 'screen',
        title: '独立筛选与冲突裁决',
        input: '去重后的题录及协议。',
        operation: '两路独立判断，仅把一致结果和冲突候选呈现给研究者。',
        visibleProcess: ['子任务状态', '理由证据', '冲突列表'],
        output: '双路建议、冲突表和人工裁决列。',
        acceptance: ['每条决定含理由代码', '最终决定没有伪装成 AI 自动结论'],
      },
      {
        id: 'report',
        title: '生成 PRISMA 计数与审计包',
        input: '检索、去重、筛选和裁决日志。',
        operation: '从逐条记录聚合计数并检查守恒关系。',
        visibleProcess: ['计数脚本', '守恒断言', '文件打包'],
        output: '流程计数、筛选表和 README。',
        acceptance: ['各阶段计数守恒', '任一纳排项能回到原始记录'],
      },
    ],
    artifacts: [
      {
        title: 'screening-pack.zip',
        format: 'ZIP',
        description: '协议、记录、决定、冲突和审计说明。',
      },
      {
        title: 'prisma-counts.json',
        format: 'JSON',
        description: '可由逐条记录重新聚合的流程计数。',
      },
    ],
    checks: [
      {
        title: '计数守恒',
        method: '脚本验证检索、去重、排除、待定和纳入数量关系。',
        passCriterion: '所有阶段断言通过且无负数/重复 ID。',
      },
      {
        title: '决定可追溯',
        method: '随机抽取 10 条决定，反查协议代码和来源记录。',
        passCriterion: '10/10 均能定位；无法判断项保持 maybe。',
      },
    ],
    suggestion: {
      agentId: 'research-assistant',
      agentName: '科研助手',
      modelId: 'deepseek-v4-flash',
      modelGuidance: '使用两个相互独立的高推理筛选子任务；最后由人做裁决。',
      why: '独立判断与完整分歧记录比让同一模型自我确认更有价值。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'research-open-peer-review',
    contentVersion: 3,
    category: 'research',
    title: '对开放论文做逐条可核验同行评议',
    summary:
      '选取 eLife 开放获取文章，分离事实核对、统计审查和表达建议，生成作者可以逐条回应的评审意见。',
    audience: '首次审稿的青年研究者、课题组内部预审与期刊编辑',
    difficulty: '挑战',
    outcome: '带页段定位、严重性、证据和可操作建议的评审包，并明确 AI 未能验证的事项。',
    capabilityIds: ['files-media', 'web-research', 'team-mode', 'artifacts-download'],
    requirements: ['只审查开放获取材料', '不上传未公开稿件', '作者/编辑承担最终判断'],
    sources: [
      {
        title: 'eLife Research Article 84364',
        url: 'https://elifesciences.org/articles/84364',
        role: 'input',
        license: 'eLife 文章通常为 CC BY；以该文章页面的版权声明为准',
        usageNote: '案例运行前核对页面许可；仅为教学审查，不冒充期刊正式评审。',
      },
      {
        title: 'eLife 关于评审流程的说明',
        url: 'https://reviewer.elifesciences.org/',
        role: 'method',
        license: '网页内容版权/许可以页面声明为准',
        usageNote: '用于理解评审角色和流程，不复制整页内容。',
      },
    ],
    inputMaterials: [
      {
        title: '开放论文 HTML/PDF 与补充材料',
        description: '从 eLife 文章页获取，保留固定访问 URL 和下载日期。',
        sourceUrl: 'https://api.elifesciences.org/articles/84364',
        assetPath: '/tutorials/cases/research-open-peer-review/inputs/elife-84364.json',
        revision: 'elife-84364-captured-2026-08-08',
        sha256: 'a831a91e32d0e576d96865142f4bbb5ff004a53c7988600dceb6031a77568899',
        bytes: 297930,
        preparation: '只下载页面明确开放的文件，并保留原文件名、许可和 SHA-256。',
      },
      {
        title: 'review-scope.md',
        description: '限定主要问题、次要问题、统计复核和不在范围事项。',
        assetPath: 'tutorialCaseCatalog.ts#research-open-peer-review/review-scope',
        revision: 'scope-v1',
        sha256: '61045b8b5a22c274541522bb14599d3fba026b6d80d073cd1ead8d1d0a4ff69b',
        bytes: 136,
        inlineContent:
          'sections=design,statistics,figures,reproducibility,reporting\nseverity=major,minor,question\nmissing_data=unverified\nrole=teaching-review\n',
        preparation: '声明无法访问原始数据时，不重新声称论文数值已被复现。',
      },
    ],
    starterPrompt: `对附件中的 eLife 开放文章做教学性质的同行评议。先绘制“主张—证据—方法”表，再分别审查研究设计、统计、图表一致性、可复现性和报告完整性。
每条意见必须包含：严重性（major/minor/question）、精确页段或图表位置、观察到的事实、为什么重要、作者可执行的修改。能由公开补充材料计算的数值请用代码复核；不能验证的内容必须写“未验证”，不要假装得到原始数据。
最后输出 review.md、claim-evidence.csv、checks/ 和 author-response-template.md；区分事实错误、解释分歧与措辞建议。`,
    stages: [
      {
        id: 'map',
        title: '建立主张—证据地图',
        input: '文章正文、图表和补充材料。',
        operation: '提取主要主张并定位支持它的实验、图表和统计方法。',
        visibleProcess: ['文档解析', '位置引用', '主张与证据配对'],
        output: 'claim-evidence.csv。',
        acceptance: ['每条主要意见有位置', '正文主张与作者解释分栏'],
      },
      {
        id: 'verify',
        title: '执行可验证检查',
        input: '公开数值、补充表和方法。',
        operation: '用脚本检查加总、区间、样本量和图表标签；记录不可复核项。',
        visibleProcess: ['计算脚本', '断言结果', '未验证清单'],
        output: 'checks/ 下的脚本与结果。',
        acceptance: ['计算可重复运行', '缺数据没有被推测补齐'],
      },
      {
        id: 'review',
        title: '分角色独立审查',
        input: '证据地图和检查结果。',
        operation: '方法、统计和表达三路提出意见，再去重并标记分歧。',
        visibleProcess: ['团队任务', '意见合并', '证据回查'],
        output: '按严重性排序的评审草稿。',
        acceptance: ['每条批评都有事实基础', '措辞偏好未升级为 major'],
      },
      {
        id: 'deliver',
        title: '形成可回应的评审包',
        input: '已核验意见和限制。',
        operation: '将意见改写为作者可逐条答复的编号问题，并附核验边界。',
        visibleProcess: ['引用检查', '严重性复核', '产物生成'],
        output: 'review.md 与回复模板。',
        acceptance: ['所有 major 均有位置和理由', '明确声明这是教学辅助评议'],
      },
    ],
    artifacts: [
      { title: 'review.md', format: 'Markdown', description: '按严重性编号的评审意见和范围声明。' },
      { title: 'claim-evidence.csv', format: 'CSV', description: '主张、位置、证据和核验状态。' },
      {
        title: 'author-response-template.md',
        format: 'Markdown',
        description: '逐条回应与修改位置模板。',
      },
    ],
    checks: [
      {
        title: '定位完整性',
        method: '检查所有 major/minor 是否含可定位的页段、章节或图号。',
        passCriterion: '100% 意见可定位；全局建议明确标为全局。',
      },
      {
        title: '数值可复核性',
        method: '在干净环境运行 checks/ 并比较结果文件。',
        passCriterion: '脚本退出码为 0；不可复核项未被报告为复现成功。',
      },
    ],
    suggestion: {
      agentId: 'research-assistant',
      agentName: '科研助手',
      modelId: 'deepseek-v4-flash',
      modelGuidance: '高推理模型负责方法和统计审查；另一模型独立检查文字与引用。',
      why: '分工可减少一份流畅总评掩盖证据和严重性边界。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'research-replication-audit',
    contentVersion: 2,
    category: 'research',
    title: '复跑固定开放研究并定位复现差异',
    summary:
      '复跑 diversity_abm_replication 的固定提交 67af994，在隔离环境中重建并把差异定位到数据、环境、随机性或实现。',
    audience: '需要复核论文代码、教学复现或验收计算研究交付的团队',
    difficulty: '挑战',
    outcome: '一份不把“能启动”冒充“已复现”的审计报告、环境清单和差异证据。',
    capabilityIds: [
      'github-repository',
      'artifacts-download',
      'container-web-preview',
      'team-mode',
    ],
    requirements: ['容器或隔离环境', '固定仓库 commit', '先读项目许可证和资源需求'],
    sources: [
      {
        title: 'ReScience C submissions',
        url: 'https://github.com/ReScience/ReScience-submission',
        role: 'input',
        license: '各提交的代码和材料许可分别标注；文章通常采用开放许可',
        usageNote: '运行前选择明确含 LICENSE、能在可用资源内执行的提交，并固定 commit SHA。',
      },
      {
        title: 'ReScience C 项目',
        url: 'https://rescience.github.io/',
        role: 'method',
        license: '文章/代码许可以各页面和仓库声明为准',
        usageNote: '用于理解计算研究复现的交付形式，不默认复制第三方数据。',
      },
      {
        title: 'The Turing Way 可复现研究指南',
        url: 'https://the-turing-way.netlify.app/reproducible-research/reproducible-research',
        role: 'method',
        license: 'CC BY 4.0',
        usageNote: '引用指南时署名 The Turing Way Community。',
      },
    ],
    inputMaterials: [
      {
        title: '固定的 ReScience 提交仓库',
        description: '固定的 diversity_abm_replication 仓库归档，不在运行时另选项目。',
        sourceUrl:
          'https://codeload.github.com/LukasWallrich/diversity_abm_replication/tar.gz/67af9948843eb1543da67f4987483f62a270361b',
        revision: '67af9948843eb1543da67f4987483f62a270361b',
        sha256: 'e4a7d65b6ea3d427821b523c3b67f1756f983d40629593f6009e8093132ad537',
        bytes: 16620050,
        preparation: '核对归档 SHA-256，并在执行记录中写入仓库 URL、commit SHA 与 LICENSE 路径。',
      },
      {
        title: 'expected-results.md',
        description: '从项目 README/文章中逐字转录预期命令、指标、图表和容差。',
        assetPath: 'tutorialCaseCatalog.ts#research-replication-audit/expected-results',
        revision: 'criteria-v1',
        sha256: '2a2d0a8302c5258fe576c4d8f1bb977ed3bad0de75fafb7d42610ffc9b4bcbfe',
        bytes: 185,
        inlineContent:
          'repository=LukasWallrich/diversity_abm_replication\ncommit=67af9948843eb1543da67f4987483f62a270361b\nlevels=environment,execution,main-results,full-reproduction\nundeclared_tolerance=fail\n',
        preparation: '转录时附来源位置；作者未给容差就不要事后自定为通过。',
      },
    ],
    starterPrompt: `对已冻结的 LukasWallrich/diversity_abm_replication@67af9948843eb1543da67f4987483f62a270361b 做复现审计。先校验归档 SHA-256，再读取 LICENSE、README、文章和资源要求，建立“作者声称—验收方法—容差—来源位置”表。
不要修改原仓库来让它通过：先在隔离环境按作者步骤原样运行并保留完整日志；失败后再在单独分支做最小诊断实验。区分环境重建成功、程序运行成功、主要结果接近和完整复现四个层级。
输出 environment.lock、commands.log、result-comparison.csv、reproduction-report.md 和最小诊断补丁（如有），任何失败都作为结果保留。`,
    stages: [
      {
        id: 'select',
        title: '核验冻结的复现对象',
        input: 'diversity_abm_replication 固定归档与资源边界。',
        operation: '校验归档哈希、许可、数据可得性、固定 commit 与预期结果。',
        visibleProcess: ['仓库浏览', '许可读取', 'commit 和文件哈希'],
        output: 'selection-manifest.json 与 expected-results.md。',
        acceptance: ['commit 不可漂移', '每项预期有来源位置'],
      },
      {
        id: 'environment',
        title: '重建隔离环境',
        input: '项目依赖和运行说明。',
        operation: '记录 OS、运行时、依赖、硬件和安装命令，不先改业务代码。',
        visibleProcess: ['容器构建', '依赖解析', '环境清单'],
        output: 'environment.lock 与 build.log。',
        acceptance: ['环境可二次创建', '未经声明的手工步骤为零'],
      },
      {
        id: 'run',
        title: '原样复跑并保存失败',
        input: '冻结仓库和隔离环境。',
        operation: '按作者命令执行，保存 stdout/stderr、时长和所有产物。',
        visibleProcess: ['长任务进度', '命令日志', '产物预览'],
        output: '不可变运行日志与输出快照。',
        acceptance: ['失败日志没有被覆盖', '运行未访问未声明数据'],
      },
      {
        id: 'compare',
        title: '分层比较与定位差异',
        input: '预期结果和本次输出。',
        operation: '按环境、执行、指标和图形层比较；最小实验定位差异来源。',
        visibleProcess: ['数值 diff', '产物对照', '诊断分支 diff'],
        output: '结果对照表与分层结论。',
        acceptance: ['未达到的层级明确为失败', '修补与原样运行严格分开'],
      },
    ],
    artifacts: [
      {
        title: 'reproduction-report.md',
        format: 'Markdown',
        description: '复现层级、差异、证据与限制。',
      },
      {
        title: 'result-comparison.csv',
        format: 'CSV',
        description: '预期值、实测值、容差、来源和状态。',
      },
      { title: 'environment.lock', format: 'Text', description: '系统、运行时、依赖与硬件快照。' },
    ],
    checks: [
      {
        title: '对象固定',
        method: '比较运行前后仓库 HEAD 与脏状态。',
        passCriterion: '原样运行目录仍为固定 SHA 且无修改。',
      },
      {
        title: '结论分层',
        method: '检查报告是否分别声明环境、执行、主要结果、完整复现状态。',
        passCriterion: '四层均有证据，未通过层级未被合并为成功。',
      },
    ],
    suggestion: {
      agentId: 'research-assistant',
      agentName: '科研助手',
      modelId: 'deepseek-v4-flash',
      modelGuidance: '编码模型负责环境和日志，科研模型负责预期结果与结论边界。',
      why: '复现失败常混合工程与科研判断，分工后证据边界更清晰。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'coding-swe-bench-fix',
    contentVersion: 4,
    category: 'coding',
    title: '像真实维护者一样修一个 SWE-bench Bug',
    summary:
      '从 SWE-bench Verified 固定一条真实 GitHub 问题，在隔离 worktree 先复现、定位最小根因、补回归测试，再交付可审查补丁。',
    audience: '希望检验 AI 是否真的能修仓库问题，而不只是生成代码片段的开发者',
    difficulty: '挑战',
    outcome: '问题路径与正常路径都有自动化证据、diff 最小且不修改测试逃避失败的修复提交。',
    capabilityIds: [
      'github-repository',
      'team-mode',
      'container-web-preview',
      'artifacts-download',
    ],
    requirements: [
      '固定 SWE-bench Verified instance_id 与 base_commit',
      '隔离容器/worktree',
      '不得联网读取 gold patch',
    ],
    sources: [
      {
        title: 'SWE-bench 官方仓库',
        url: 'https://github.com/SWE-bench/SWE-bench',
        role: 'method',
        license: 'MIT',
        usageNote: '遵循官方评测隔离；不得在修复过程中读取答案补丁。',
      },
      {
        title: 'SWE-bench Verified 数据集卡',
        url: 'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified',
        role: 'input',
        license: '数据集卡及每个来源仓库的许可分别适用',
        usageNote: '固定 instance_id/base_commit；仅处理来源仓库许可允许的代码与 issue 文本。',
      },
      {
        title: 'Astropy #12906 原始问题',
        url: 'https://github.com/astropy/astropy/issues/12906',
        role: 'need-evidence',
        license: 'Astropy 仓库采用 BSD-3-Clause；GitHub 页面内容按平台条款使用',
        usageNote: '只使用公开问题描述和最小复现；运行期间不向 Agent 暴露后续修复 PR。',
      },
      {
        title: 'Stack Overflow 2025 Developer Survey：AI',
        url: 'https://survey.stackoverflow.co/2025/ai',
        role: 'need-evidence',
        license: '网页版权归 Stack Overflow；仅链接和概述统计',
        usageNote: '用于说明“几乎正确”和调试 AI 代码仍是用户痛点，不复制整页内容。',
      },
    ],
    inputMaterials: [
      {
        title: '一个固定 Verified 实例',
        description: 'instance_id、problem_statement、repo、base_commit 和官方容器定义。',
        assetPath: 'tutorialCaseCatalog.ts#coding-swe-bench-fix/instance',
        revision: 'astropy__astropy-12907',
        sha256: '60868938a47c575f10e7232e95b8b0dd95dd1c0c56281a00589d8515d37856e2',
        bytes: 204,
        inlineContent:
          'instance_id=astropy__astropy-12907\nrepo=astropy/astropy\nbase_commit=d16bfe05a744909de4b27f5875fe0d4ed41ce607\nproblem=separability_matrix is incorrect for nested CompoundModels\ngold_patch_access=forbidden\n',
        preparation:
          '从公开 split 选择后保存整条 JSON 与 SHA-256；移除 gold patch/test patch 的可见性。',
      },
      {
        title: '仓库基线',
        description: '在 base_commit 建立只用于本案例的 worktree。',
        sourceUrl:
          'https://codeload.github.com/astropy/astropy/tar.gz/d16bfe05a744909de4b27f5875fe0d4ed41ce607',
        revision: 'd16bfe05a744909de4b27f5875fe0d4ed41ce607',
        sha256: '4ffc67512585ebd76f93abe9544e3563f826ccf70e1576492d3f21eb8d3d4979',
        bytes: 7774271,
        preparation: '记录 git status -sb 和基线测试；不在上游仓库直接修改。',
      },
    ],
    starterPrompt: `你在隔离 worktree 中处理附件给出的 SWE-bench Verified 问题。禁止查找或推断官方 gold patch。
先把 issue 转换为可验证验收标准，运行最小命令复现；没有复现证据前不要改代码。定位直接代码路径并写一个会失败的回归测试，然后做最小充分修改。既验证问题路径，也验证邻近正常路径；不要顺手重构、批量格式化或放宽测试。
最后提供 root-cause.md、完整 git diff、测试命令/输出和未覆盖风险；只有独立评测通过才能说“修复通过”。`,
    stages: [
      {
        id: 'baseline',
        title: '冻结实例与基线',
        input: 'Verified 实例 JSON 和 base_commit。',
        operation: '创建隔离 worktree，核对问题文本与仓库状态，执行最小基线检查。',
        visibleProcess: ['git 状态', '问题拆解', '基线命令输出'],
        output: 'instance-manifest.json 和 baseline.log。',
        acceptance: ['HEAD 等于 base_commit', 'gold patch 对任务不可见'],
      },
      {
        id: 'reproduce',
        title: '先写失败证据',
        input: '问题陈述与相关测试入口。',
        operation: '构造最小复现或回归测试，证明当前行为与期望不符。',
        visibleProcess: ['代码搜索', '测试运行', '失败断言'],
        output: '稳定失败的回归测试与根因链。',
        acceptance: ['测试在未修代码上失败', '失败原因与 issue 一致'],
      },
      {
        id: 'patch',
        title: '实施最小根因修复',
        input: '已复现路径和直接相关代码。',
        operation: '只修改根因所需文件，持续查看 diff 并跑针对性测试。',
        visibleProcess: ['精确编辑', 'diff', '问题与正常路径测试'],
        output: '最小代码/测试补丁。',
        acceptance: ['失败测试转绿', '邻近正常路径仍通过'],
      },
      {
        id: 'evaluate',
        title: '独立评测与交付',
        input: '最终补丁与官方测试环境。',
        operation: '在干净环境运行官方评测，不把聊天自评作为通过证据。',
        visibleProcess: ['干净构建', '评测日志', '最终 diff 审查'],
        output: '补丁、测试日志和根因报告。',
        acceptance: ['官方 FAIL_TO_PASS 与 PASS_TO_PASS 均通过', '无无关文件改动'],
      },
    ],
    artifacts: [
      { title: 'fix.patch', format: 'Patch', description: '最小代码与回归测试 diff。' },
      {
        title: 'root-cause.md',
        format: 'Markdown',
        description: '复现、代码路径、修复理由和风险。',
      },
      { title: 'test-results.json', format: 'JSON', description: '命令、退出码和独立评测结果。' },
    ],
    checks: [
      {
        title: '先红后绿',
        method: '在 base_commit 与补丁提交分别运行同一回归测试。',
        passCriterion: '基线因目标行为失败，补丁后通过。',
      },
      {
        title: '官方评测',
        method: '使用 SWE-bench harness 在干净容器评估。',
        passCriterion: 'FAIL_TO_PASS 和 PASS_TO_PASS 全部通过。',
      },
    ],
    suggestion: {
      agentId: 'coding-assistant',
      agentName: '编程助手',
      modelId: 'glm-5.3-zai',
      modelGuidance: '高推理编码模型负责复现与根因；审查者只报告正确性、安全和数据 blocker。',
      why: '真实修复需要可失败测试和独立 harness，不应由生成补丁的模型自行宣布成功。',
    },
    fieldReport: {
      status: 'observed_not_verified',
      sourceLabel: 'Astropy #12906 真实开源问题',
      sourceUrl: 'https://github.com/astropy/astropy/issues/12906',
      userScene:
        '维护者发现嵌套 CompoundModel 会返回错误的可分离矩阵，需要的不只是“看起来合理”的代码，而是先红后绿、正常路径不回归的补丁。',
      obstacle:
        '平铺表达式工作正常，只有右侧模型嵌套时才出错；如果没有固定基线和回归测试，很容易把症状绕过去而不是修到根因。',
      input: 'SWE-bench Verified 实例 astropy__astropy-12907、固定 base commit，以及隔离的 Astropy 仓库。',
      duration: '15 分 49 秒',
      journey: [
        { title: '先让问题稳定变红', evidence: '新增的两个回归检查在基线代码上稳定失败。' },
        { title: '沿递归路径找根因', evidence: '_cstack 把右侧已有矩阵整块覆盖成 1，嵌套结构因此丢失。' },
        { title: '只改根因的一行', evidence: '把常量 1 改为 right，保留右侧子矩阵的真实结构。' },
        { title: '问题与邻近路径一起验证', evidence: '新增回归与原有邻近测试合计 13 项通过。' },
      ],
      metrics: [
        { label: '回归证据', value: '2 → 13', detail: '修复前 2 项失败，修复后 13 项通过' },
        { label: '产品代码修改', value: '1 行', detail: '没有顺手重构或批量格式化' },
        { label: '完整实跑耗时', value: '15:49', detail: '从复现、定位到外部复跑' },
      ],
      result: 'V5 找到一处一行根因修改，补了独立回归测试，并交付根因报告和测试证据。',
      limitations: [
        '这次没有运行官方 SWE-bench FAIL_TO_PASS / PASS_TO_PASS harness，因此不能宣称官方评测通过。',
        '当次产品展示的“完整 diff”漏掉了未跟踪的回归测试文件，所以仍不能作为完整可下载 patch。',
      ],
      visual: 'astropy-patch',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'coding-feature-delivery',
    contentVersion: 3,
    category: 'coding',
    title: '从一条需求交付可合并的 API 功能',
    summary:
      '在 Full Stack FastAPI Template 的固定 fork 中新增一个小型、向后兼容的能力，完整展示约束澄清、契约测试、实现、浏览器验收与审查。',
    audience: '需要让 AI 在现有工程中端到端交付功能的产品工程师',
    difficulty: '进阶',
    outcome: '一份有验收标准、API 契约、前后端测试、迁移判断和审查记录的可合并 PR。',
    capabilityIds: [
      'github-repository',
      'container-web-preview',
      'team-mode',
      'artifacts-download',
    ],
    requirements: ['使用个人 fork 和隔离分支', '固定上游 commit', '不得写入真实生产凭据'],
    sources: [
      {
        title: 'Full Stack FastAPI Template',
        url: 'https://github.com/fastapi/full-stack-fastapi-template',
        role: 'input',
        license: 'MIT',
        usageNote: '在个人 fork 的任务分支练习，保留原许可证和署名。',
      },
      {
        title: 'FastAPI Testing 官方文档',
        url: 'https://fastapi.tiangolo.com/tutorial/testing/',
        role: 'method',
        license: 'MIT（FastAPI 文档仓库）',
        usageNote: '用官方接口作为测试方法参考，不复制无关章节。',
      },
    ],
    inputMaterials: [
      {
        title: '固定模板 fork',
        description: '记录 fork URL、base commit 与现有 CI。',
        sourceUrl:
          'https://codeload.github.com/fastapi/full-stack-fastapi-template/tar.gz/d506ea4883c0f7bfcf5280921cfc407c46808711',
        revision: 'd506ea4883c0f7bfcf5280921cfc407c46808711',
        sha256: '538250a42afb8fc0be383d2a8af66cb182b08d1cfadfd766eff39b2d7c476f0b',
        bytes: 683209,
        preparation: '创建 task-scoped branch；用示例环境变量，禁止接触线上数据库。',
      },
      {
        title: 'feature-request.md',
        description:
          '练习需求：为当前用户新增可选时区偏好，API 可读写，前端设置页可编辑，旧用户保持 UTC。',
        assetPath: 'tutorialCaseCatalog.ts#coding-feature-delivery/feature-request',
        revision: 'request-v1',
        sha256: '7d8545d25022bcdcc3c968f3df8185cff2388690d1a533d7dd6074eff3acf2f1',
        bytes: 185,
        inlineContent:
          'feature=user timezone preference\nformat=IANA timezone name\ndefault=UTC\npaths=API read/write,settings edit,refresh persistence,invalid-value error\ncompatibility=existing users unchanged\n',
        preparation: '写清合法时区、缺省行为、权限、API 响应和回滚/迁移边界。',
      },
    ],
    starterPrompt: `在固定的 full-stack-fastapi-template fork 中实现 feature-request.md 的“用户时区偏好”。
先阅读仓库规则、现有用户模型/API/设置页和测试方式，列出需要我确认的产品歧义；冻结验收标准后再改。保持 API 向后兼容，使用 IANA 时区名，旧用户行为不变。若需要数据库迁移，写明 upgrade/downgrade 和数据默认值。
先补 API 契约测试和前端交互测试，再做最小实现；在容器网页中走完读取、修改、刷新保留和非法值提示。输出 PR.md、migration-note.md、测试日志和完整 diff，不部署。`,
    stages: [
      {
        id: 'discover',
        title: '读仓库并冻结验收标准',
        input: '需求、仓库规则与固定基线。',
        operation: '追踪用户模型到 API/前端的数据流，列出产品歧义和影响面。',
        visibleProcess: ['仓库搜索', '数据流说明', '计划与人工确认'],
        output: 'accepted-criteria.md 与影响文件清单。',
        acceptance: ['合法/非法/缺省路径有定义', '未确认歧义没有被模型擅自决定'],
      },
      {
        id: 'tests',
        title: '先建立契约测试',
        input: '冻结标准和现有测试框架。',
        operation: '增加后端读写/权限/非法值测试与前端交互测试。',
        visibleProcess: ['测试文件 diff', '预期失败', '契约快照'],
        output: '在基线上因缺少功能而失败的测试。',
        acceptance: ['测试失败原因是功能缺失', '旧用户路径有回归断言'],
      },
      {
        id: 'implement',
        title: '实现最小纵向切片',
        input: '测试、模型、API 和设置页。',
        operation: '完成迁移、后端校验、API 字段和前端控件，避免无关重构。',
        visibleProcess: ['精确编辑', '迁移 diff', '针对性测试'],
        output: '可运行的完整纵向功能。',
        acceptance: ['新增与旧路径测试通过', 'diff 不含批量格式化'],
      },
      {
        id: 'accept',
        title: '浏览器验收与独立审查',
        input: '本地完整栈与最终 diff。',
        operation: '按用户路径操作并截图，再由独立审查者核对正确性与数据风险。',
        visibleProcess: ['容器网页预览', '网络请求', '审查意见与修正'],
        output: 'PR 说明、截图、测试和迁移说明。',
        acceptance: ['修改刷新后保留，非法值可理解', '独立审查无 blocker'],
      },
    ],
    artifacts: [
      { title: 'PR.md', format: 'Markdown', description: '需求、设计、测试、截图和回滚说明。' },
      {
        title: 'migration-note.md',
        format: 'Markdown',
        description: '数据默认、upgrade/downgrade 与兼容性。',
      },
      { title: 'test.log', format: 'Text', description: '后端、前端和端到端验收命令。' },
    ],
    checks: [
      {
        title: 'API 契约',
        method: '运行用户偏好读写、权限、非法值和旧记录测试。',
        passCriterion: '所有断言通过且旧响应字段兼容。',
      },
      {
        title: '真实交互',
        method: '浏览器修改时区、刷新、重新登录并提交非法值。',
        passCriterion: '保存持久、错误可见、无控制台或网络异常。',
      },
    ],
    suggestion: {
      agentId: 'coding-assistant',
      agentName: '编程助手',
      modelId: 'glm-5.3-zai',
      modelGuidance: '选择能长时间操作仓库、运行测试和浏览器的编码模型；复杂迁移用高推理档。',
      why: '案例强调跨数据库、API、前端的最小纵向交付，而不是生成孤立代码。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'coding-regression-rescue',
    contentVersion: 4,
    category: 'coding',
    title: '修复 pytest 的 walrus 重复求值回归',
    summary:
      '固定 pytest #14445 与 base commit 28e86a6，用已验证的两条失败用例定位 assertion rewriting 对 walrus 表达式的重复求值。',
    audience: '需要从公开 issue、确定性复现一路交付回归修复的维护者',
    difficulty: '挑战',
    outcome: '可重复触发的最小测试、环境矩阵和不掩盖问题的修复证据。',
    capabilityIds: ['github-repository', 'team-mode', 'artifacts-download'],
    requirements: [
      '只在 fork/worktree 操作',
      '固定公开 issue #14445 与 base commit 28e86a6c2ae0173831e4925a4af89b02a2936d09',
      '不能用重试或放宽断言当修复',
    ],
    sources: [
      {
        title: 'pytest 仓库',
        url: 'https://github.com/pytest-dev/pytest',
        role: 'input',
        license: 'MIT',
        usageNote:
          '案例固定 issue #14445 和 base commit 28e86a6；不在运行时另选 issue，也不自动发 PR。',
      },
      {
        title: 'pytest issue #14445：walrus duplicate evaluation',
        url: 'https://github.com/pytest-dev/pytest/issues/14445',
        role: 'method',
        license: 'MIT（pytest 文档）',
        usageNote: '使用 issue 中公开的最小复现；不复制评论中的候选补丁。',
      },
    ],
    inputMaterials: [
      {
        title: 'pytest 固定仓库归档',
        description: 'pytest base commit 28e86a6 的完整源码归档。',
        sourceUrl:
          'https://codeload.github.com/pytest-dev/pytest/tar.gz/28e86a6c2ae0173831e4925a4af89b02a2936d09',
        revision: '28e86a6c2ae0173831e4925a4af89b02a2936d09',
        sha256: '8130ee6de2457c9c434656de22fa0c786971c05baf6e1d480b10e3df470938a2',
        bytes: 1719201,
        preparation: '下载后先核对 SHA-256，再建立隔离 worktree；不得在归档目录直接改。',
      },
      {
        title: '固定公开 issue 快照',
        description: 'pytest #14445 的固定 GitHub API 响应，包含 walrus 重复求值最小复现。',
        sourceUrl: 'https://api.github.com/repos/pytest-dev/pytest/issues/14445',
        assetPath: '/tutorials/cases/coding-regression-rescue/inputs/pytest-issue-14445.json',
        revision: 'issue-14445-updated-2026-06-02T12:55:32Z',
        sha256: 'b12818a7a7eb4e388c56f0af149f73212dd5fd49d06a3dfdf7bc69e9ecdb8f3a',
        bytes: 7324,
        preparation: '核对响应 SHA-256；使用固定 base commit，不读取 issue 评论中的候选修复。',
      },
      {
        title: 'reproducer.yml',
        description: '固定 Python 3.12.3 命令与预期：rewrite 模式 2 failed，plain 模式为控制路径。',
        assetPath: 'tutorialCaseCatalog.ts#coding-regression-rescue/reproducer',
        revision: 'reproducer-v1',
        sha256: 'db2c5b6a344abe04b944916da0e6f648e2ea99a182a5dad0a9121006fc2514f8',
        bytes: 237,
        inlineContent:
          'base_commit: 28e86a6c2ae0173831e4925a4af89b02a2936d09\nissue: https://github.com/pytest-dev/pytest/issues/14445\npython: 3.12.3\ncommand: python -m pytest -q test_walrus_case.py\nexpected_baseline: 2 failed\nplain_assertion_control: 2 passed\n',
        preparation: '矩阵必须有限且有问题证据，不为猜测无限扩容。',
      },
    ],
    starterPrompt: `在 pytest@28e86a6c2ae0173831e4925a4af89b02a2936d09 的隔离 worktree 中处理公开 issue #14445。先校验仓库归档与 issue 快照哈希，再用 reproducer.yml 的固定命令证明 assertion rewriting 会让 walrus 表达式重复求值；--assert=plain 是必须通过的对照路径。禁止查找现成补丁、自动重试或放宽断言。
找到第一次重复求值的直接代码路径，写确定性回归测试，再做最小修复。分别运行目标测试、相关 assertion rewrite 测试和原有正常路径；如果固定基线不能复现，交付诊断结果并停止，不要声称已修复。
输出 reproducer.py、root-cause.md、fix.patch 和 run-matrix.json。`,
    stages: [
      {
        id: 'confirm',
        title: '确认问题仍存在',
        input: 'issue 快照、base commit 与环境矩阵。',
        operation: '运行固定 rewrite 与 plain 两条命令，记录退出码和环境。',
        visibleProcess: ['环境探测', '两条固定命令', '失败断言对照'],
        output: 'baseline-runs.json。',
        acceptance: ['问题在固定基线有证据', '未复现则明确停止修复'],
      },
      {
        id: 'stabilize',
        title: '把重复求值缩成最小证据',
        input: '两条失败断言和 assertion rewrite 代码路径。',
        operation: '缩小 AST rewrite 触发条件，同时保留 plain 模式正常对照。',
        visibleProcess: ['时间线日志', '状态 diff', '最小 reproducer'],
        output: 'reproducer.py 与失败测试。',
        acceptance: ['rewrite 基线 2/2 失败', 'plain 控制路径 2/2 通过'],
      },
      {
        id: 'fix',
        title: '修第一次错误状态',
        input: '确定性复现和因果链。',
        operation: '修复产生错误状态的最小代码，不在下游吞异常。',
        visibleProcess: ['代码路径', '补丁 diff', '先红后绿'],
        output: '最小修复和回归测试。',
        acceptance: ['复现测试转绿', '测试仍保留严格断言'],
      },
      {
        id: 'stress',
        title: '重复与邻近回归验证',
        input: '最终补丁。',
        operation: '目标测试重复 100 次并跑相关测试；保存每次退出码和时长。',
        visibleProcess: ['重复进度', '失败计数', '相关套件日志'],
        output: 'run-matrix.json 和修复报告。',
        acceptance: ['100 次目标测试零失败', '相关套件通过且无新增 skip'],
      },
    ],
    artifacts: [
      { title: 'reproducer.py', format: 'Python', description: '确定性触发原问题的最小程序。' },
      {
        title: 'run-matrix.json',
        format: 'JSON',
        description: '基线和修复后的逐次退出码、环境与时长。',
      },
      { title: 'fix.patch', format: 'Patch', description: '根因修复和严格回归测试。' },
    ],
    checks: [
      {
        title: '确定性复现',
        method: '在 base commit 连续运行最小复现 20 次。',
        passCriterion: '20/20 触发同一目标失败，否则不进入修复阶段。',
      },
      {
        title: '重复修复验证',
        method: '补丁后目标测试运行 100 次并检查 skip/xfail 变化。',
        passCriterion: '100/100 通过，未新增 skip、xfail、rerun 或放宽断言。',
      },
    ],
    suggestion: {
      agentId: 'coding-assistant',
      agentName: '编程助手',
      modelId: 'glm-5.3-zai',
      modelGuidance: '用高推理模型分析时间线；让第二任务只复核因果链而不另起重构。',
      why: '偶发问题需要可重复证据，更多防御代码不能代替定位。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'coding-frontend-quality',
    contentVersion: 3,
    category: 'coding',
    title: '用真实浏览器修一条前端可访问性问题',
    summary:
      '在 TodoMVC React@ff43b02 上修复已冻结的 checkbox accessible-name 缺陷，并用键盘、axe 和真实浏览器做前后对照。',
    audience: '希望 AI 不只看代码，还能在真实页面中验收体验的前端开发者',
    difficulty: '进阶',
    outcome: '带浏览器证据、自动化回归和移动端/键盘路径验收的最小前端补丁。',
    capabilityIds: [
      'github-repository',
      'container-web-preview',
      'artifacts-download',
      'team-mode',
    ],
    requirements: [
      '固定仓库 commit ff43b02e59dfa604386bb382034b2cd07c2bcd8a',
      '真实浏览器而非只看 DOM 字符串',
      '目标仅限 todo item checkbox 缺少 accessible name',
    ],
    sources: [
      {
        title: 'TodoMVC monorepo',
        url: 'https://github.com/tastejs/todomvc',
        role: 'input',
        license: 'MIT',
        usageNote: '保留许可证；在隔离分支运行并记录具体示例路径和 commit。',
      },
      {
        title: 'WCAG 2.2',
        url: 'https://www.w3.org/TR/WCAG22/',
        role: 'method',
        license: 'W3C Document License',
        usageNote: '评审时引用具体成功准则，不笼统宣称“完全符合 WCAG”。',
      },
      {
        title: 'Lighthouse 性能文档',
        url: 'https://developer.chrome.com/docs/lighthouse/performance/',
        role: 'method',
        license: '页面许可按 Chrome for Developers 声明',
        usageNote: '实验固定浏览器、视口和节流条件，分数仅用于前后对照。',
      },
    ],
    inputMaterials: [
      {
        title: 'TodoMVC React 示例固定提交',
        description: '选择仓库内当前 React 示例并记录启动命令、commit 与依赖锁。',
        sourceUrl:
          'https://codeload.github.com/tastejs/todomvc/tar.gz/ff43b02e59dfa604386bb382034b2cd07c2bcd8a',
        revision: 'ff43b02e59dfa604386bb382034b2cd07c2bcd8a',
        sha256: '22fd7c5251b636773561cc0ab606896f48c8dbcad80e79b427989bfc0e134718',
        bytes: 20046745,
        preparation: '安装依赖后不修改基线，先保存桌面/移动视口与键盘操作录像。',
      },
      {
        title: 'journey.md',
        description: '添加任务、编辑、完成、筛选、清空的键盘与窄屏用户路径。',
        assetPath: 'tutorialCaseCatalog.ts#coding-frontend-quality/journey',
        revision: 'journey-v1',
        sha256: '4a3a22bdeb348ac012ccd3117dd7fb21b40b482d0889f9eb8acdce378bf18952',
        bytes: 247,
        inlineContent:
          'target=examples/react/src/todo/components/item.jsx\ndefect=todo item checkbox has no accessible name because input has no id and adjacent label has no htmlFor\npath=add item,focus checkbox,read accessible name,toggle item\nviewports=1280x800,375x812\n',
        preparation: '给每步定义可观察预期；审计只选择一条实际失败进入修复。',
      },
    ],
    starterPrompt: `在 TodoMVC React@ff43b02e59dfa604386bb382034b2cd07c2bcd8a 上修复已冻结缺陷：examples/react/src/todo/components/item.jsx 的 todo item checkbox 没有 id，旁边 label 没有 htmlFor，因此 checkbox 没有 accessible name。先校验归档哈希，再用真实浏览器按 journey.md 在桌面、375px 窄屏和纯键盘路径复现，保存截图、axe 结果和 accessible-name 断言。
先写自动化回归，再做最小 HTML/React 修复；不要顺手重设计或追分。用相同浏览器与条件做前后对照，并确认添加、编辑、完成和筛选路径未回归。
输出 before-after.md、e2e 测试、trace/ 和 fix.patch。`,
    stages: [
      {
        id: 'baseline',
        title: '捕获真实基线',
        input: '固定页面和 journey.md。',
        operation:
          '按相同视口和浏览器定位 todo item checkbox，执行键盘、axe 与 accessible-name 检查。',
        visibleProcess: ['浏览器操作', '元素定位', '控制台/网络/性能记录'],
        output: '基线截图、录像、axe JSON 和 trace。',
        acceptance: ['问题可由用户路径复现', '环境和测试条件已记录'],
      },
      {
        id: 'scope',
        title: '确认已冻结缺陷的根因',
        input: '基线证据。',
        operation: '确认 input 缺 id、相邻 label 缺 htmlFor 的命名关系，范围不扩到其他评分项。',
        visibleProcess: ['代码定位', '规则映射', '范围声明'],
        output: 'root-cause.md 和验收标准。',
        acceptance: ['问题有用户影响证据', '不以综合评分替代根因'],
      },
      {
        id: 'patch',
        title: '测试先行的最小修复',
        input: '失败路径与相关组件。',
        operation: '增加自动化回归并只改相关组件/样式。',
        visibleProcess: ['测试先红', '组件 diff', '针对性运行'],
        output: '测试和最小前端补丁。',
        acceptance: ['测试在基线失败、补丁后通过', '没有无关视觉改版'],
      },
      {
        id: 'compare',
        title: '同条件前后验收',
        input: '补丁页面和原始基线配置。',
        operation: '重放同一旅程，比较无障碍结果、截图和性能证据。',
        visibleProcess: ['浏览器重放', 'before/after 对照', '移动端截图'],
        output: 'before-after.md 与可审查 patch。',
        acceptance: ['目标失败消失', '添加/编辑/完成/筛选正常路径仍可用'],
      },
    ],
    artifacts: [
      { title: 'before-after.md', format: 'Markdown', description: '固定条件下的浏览器证据对照。' },
      { title: 'frontend-quality.patch', format: 'Patch', description: '回归测试与最小修复。' },
      {
        title: 'browser-evidence.zip',
        format: 'ZIP',
        description: '截图、axe JSON、控制台和性能轨迹。',
      },
    ],
    checks: [
      {
        title: '键盘闭环',
        method: '不使用鼠标重放 journey.md 并断言焦点和可访问名称。',
        passCriterion: '所有步骤可完成，焦点可见且顺序合理。',
      },
      {
        title: '同条件对照',
        method: '固定浏览器版本、视口和节流重跑自动检查。',
        passCriterion: '目标问题消失，正常路径无新增错误；不以分数波动单独判定。',
      },
    ],
    suggestion: {
      agentId: 'coding-assistant',
      agentName: '编程助手',
      modelId: 'glm-5.3-zai',
      modelGuidance: '选择能操控真实浏览器和修改仓库的模型；视觉审查可由独立任务复核。',
      why: '前端质量必须以用户可操作页面为证据，静态代码审查不够。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'coding-dependency-upgrade',
    contentVersion: 3,
    category: 'coding',
    title: '把依赖升级做成可回退的工程变更',
    summary:
      '在 pypa/sampleproject@621e497 的教学约束中把 coverage 7.9.2 升至 7.15.4，验证包构建与安装，不做盲目全量升级。',
    audience: '维护 Python 服务、库或模板并担心升级引入隐性回归的开发者',
    difficulty: '进阶',
    outcome: '仅包含一个有依据依赖升级、兼容性说明、构建/安装证据和明确回退方式的 PR。',
    capabilityIds: ['github-repository', 'web-research', 'artifacts-download'],
    requirements: [
      '固定 base commit 621e4974ca25ce531773def586ba3ed8e736b3fc',
      '固定 coverage 7.9.2 → 7.15.4',
      '一次只升级一个直接测试依赖',
    ],
    sources: [
      {
        title: 'PyPA sampleproject',
        url: 'https://github.com/pypa/sampleproject',
        role: 'input',
        license: 'MIT',
        usageNote: '用于隔离练习；保留许可证，不自动向上游创建 PR。',
      },
      {
        title: 'Python Packaging User Guide 官方源码',
        url: 'https://github.com/pypa/packaging.python.org',
        role: 'method',
        license: 'CC BY-SA 3.0',
        usageNote:
          '按当前官方构建和安装方法验证；文档源码见 https://github.com/pypa/packaging.python.org，改编须保持同许可。',
      },
      {
        title: 'PyPI JSON API',
        url: 'https://docs.pypi.org/api/json/',
        role: 'input',
        license: 'API 元数据使用受 PyPI Terms of Use 约束',
        usageNote: '用于核对发行版、Python 要求和文件摘要，不下载未选择版本的全部文件。',
      },
    ],
    inputMaterials: [
      {
        title: 'sampleproject 固定 fork',
        description: '仓库 base commit、依赖声明和 CI 配置。',
        sourceUrl:
          'https://codeload.github.com/pypa/sampleproject/tar.gz/621e4974ca25ce531773def586ba3ed8e736b3fc',
        revision: '621e4974ca25ce531773def586ba3ed8e736b3fc',
        sha256: 'fd8597e4d351a9fd42007f48339dc93ee6469d8555fd0ff24906c69905357c01',
        bytes: 5978,
        preparation: '创建隔离 worktree，保存基线测试、构建和安装日志。',
      },
      {
        title: 'upgrade-target.md',
        description: '固定教学约束 coverage 7.9.2 → 7.15.4，不在运行时另选依赖或版本。',
        assetPath: 'tutorialCaseCatalog.ts#coding-dependency-upgrade/upgrade-target',
        revision: 'target-v1',
        sha256: '2269bc18f725d9d5713f12024eb9c306578fef34ef516edb3e6d59dc1b0a8bb0',
        bytes: 161,
        inlineContent:
          'dependency=coverage\nfrom=7.9.2\nto=7.15.4\nlocation=project.optional-dependencies.test tutorial constraint\npython_requires=>=3.10\nscope=one direct test dependency\n',
        preparation: '记录旧/新版本、发布日期、Python 要求、上游 changelog URL 和选择理由。',
      },
    ],
    starterPrompt: `在 sampleproject@621e4974ca25ce531773def586ba3ed8e736b3fc 的教学测试约束中，把唯一目标 coverage 从 7.9.2 升至 7.15.4。先校验归档和 upgrade-target.md 哈希，再从 PyPI 与 coverage 官方 changelog 核对 Python 支持、弃用和破坏性变化；若与仓库 requires-python 矩阵不兼容就停止并说明。
保存 coverage 7.9.2 基线测试、sdist/wheel 构建和全新虚拟环境安装证据；然后只更新该测试约束和被实际失败证明必要的兼容代码，不刷新其他依赖。重复相同验证，并检查 wheel 内容、元数据和 import smoke。
输出 upgrade-note.md、before-after.json、构建产物摘要和 patch；回退方式必须只是还原该提交。`,
    stages: [
      {
        id: 'inventory',
        title: '核验固定升级目标',
        input: 'coverage 7.9.2 → 7.15.4、仓库 CI 和 PyPI/上游信息。',
        operation: '读取两个固定版本的 Python 要求和 changelog，形成升级或停止理由。',
        visibleProcess: ['仓库搜索', 'PyPI 请求', 'changelog 来源'],
        output: 'upgrade-target.md。',
        acceptance: ['目标存在于当前仓库', '兼容性判断有一手来源'],
      },
      {
        id: 'baseline',
        title: '建立包生命周期基线',
        input: '未改仓库。',
        operation: '运行测试、构建 sdist/wheel，并在全新 venv 安装和 import。',
        visibleProcess: ['测试', 'build', '安装与 metadata 检查'],
        output: 'before.json 与基线构建摘要。',
        acceptance: ['基线本身可通过', '产物摘要和 Python 版本已记录'],
      },
      {
        id: 'upgrade',
        title: '最小升级与必要兼容',
        input: '目标版本和上游变更。',
        operation: '只更新目标依赖及被证实必要的兼容代码。',
        visibleProcess: ['依赖 diff', '针对性测试', '失败根因'],
        output: '单依赖升级 patch。',
        acceptance: ['无无关依赖漂移', '兼容修改能对应实际失败或上游契约'],
      },
      {
        id: 'verify',
        title: '重跑构建、安装与回归',
        input: '最终 patch。',
        operation: '用相同矩阵生成 after.json，比较测试、包内容和元数据。',
        visibleProcess: ['矩阵运行', 'before/after diff', 'wheel 安装 smoke'],
        output: 'upgrade-note.md、after.json 和构建摘要。',
        acceptance: ['支持矩阵通过', '包内容没有非预期增删'],
      },
    ],
    artifacts: [
      {
        title: 'upgrade-note.md',
        format: 'Markdown',
        description: '动机、上游变化、兼容性、验证和回退。',
      },
      {
        title: 'before-after.json',
        format: 'JSON',
        description: '两侧测试、构建、安装和元数据结果。',
      },
      {
        title: 'dependency-upgrade.patch',
        format: 'Patch',
        description: '一个直接依赖及必要兼容修改。',
      },
    ],
    checks: [
      {
        title: '依赖漂移',
        method: '解析 diff/锁文件，列出发生版本变化的所有直接和传递依赖。',
        passCriterion: '只有目标及解析器不可避免且已说明的传递依赖变化。',
      },
      {
        title: '包生命周期',
        method: '在支持的 Python 矩阵构建 wheel/sdist，并全新安装、import。',
        passCriterion: '测试、构建、安装均通过，METADATA 与预期一致。',
      },
    ],
    suggestion: {
      agentId: 'coding-assistant',
      agentName: '编程助手',
      modelId: 'glm-5.3-zai',
      modelGuidance: '普通编码模型可执行；涉及破坏性版本或复杂矩阵时提高推理档。',
      why: '重点是读取上游契约和可回退验证，不是一次更新更多依赖。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'general-meeting-actions',
    contentVersion: 2,
    category: 'general',
    title: '把公开会议记录变成可追责行动表',
    summary:
      '用 W3C 公开会议纪要演示：区分已决事项、提案和待确认信息，生成负责人/截止时间齐全度检查，而不是自动脑补。',
    audience: '项目经理、研究团队秘书和跨部门协作者',
    difficulty: '入门',
    outcome: '每项行动都能跳回原文位置，缺负责人或日期时明确待确认的行动登记表。',
    capabilityIds: ['files-media', 'artifacts-download', 'chat-basics'],
    requirements: ['只使用公开纪要', '不得从上下文猜测负责人/截止日期', '发布前由参会者确认'],
    sources: [
      {
        title: 'W3C DID 2025-12-04 固定会议纪要',
        url: 'https://www.w3.org/2025/12/04-did-minutes.html',
        role: 'input',
        license: 'W3C Document License；具体纪要以页面声明为准',
        usageNote: '仅使用该固定公开纪要，并在运行前核对 SHA-256；不处理成员私密会议。',
      },
      {
        title: 'W3C Document License',
        url: 'https://www.w3.org/copyright/document-license-2023/',
        role: 'license',
        license: 'W3C Document License 2023',
        usageNote: '引用原文时保留来源；派生行动表不暗示 W3C 背书。',
      },
    ],
    inputMaterials: [
      {
        title: '一份固定 W3C 公开纪要',
        description: '包含议题、发言、决议或 action 的 HTML/文本。',
        sourceUrl: 'https://www.w3.org/2025/12/04-did-minutes.html',
        assetPath: '/tutorials/cases/general-meeting-actions/inputs/w3c-did-minutes.html',
        revision: 'w3c-did-minutes-2025-12-04',
        sha256: '6c597851d31641c1cd1ba6e9141bed1434107160b8f56fe376e1f6087a9ddf51',
        bytes: 22724,
        preparation: '保存永久 URL、会议日期和页面快照哈希；确认页面公开。',
      },
      {
        title: 'action-schema.csv',
        description:
          'id、action、owner、due、status、evidence_url、confidence、needs_confirmation。',
        assetPath: 'tutorialCaseCatalog.ts#general-meeting-actions/action-schema',
        revision: 'schema-v1',
        sha256: '2b7942c40344257f666b477802011e419d71cc51ba75c0d30d02592d0c333dd8',
        bytes: 70,
        inlineContent: 'id,action,owner,due,status,evidence_url,confidence,needs_confirmation\n',
        preparation: 'owner/due 缺失时允许空值，不设自动默认人和日期。',
      },
    ],
    starterPrompt: `把附件中的公开会议纪要整理为行动登记表。只把原文明示的行动、负责人和日期写成事实；“建议”“讨论”“可能”不得升级为已决事项。每行附原文锚点或可检索短语，缺负责人/截止时间就留空并标 needs_confirmation。
另外输出 decisions.md，分开列出正式决议、未决提案和开放问题。最后检查行动数、负责人齐全率、日期齐全率，但不要替团队分配任务。
交付 actions.csv、decisions.md 和 follow-up-email.md；邮件只请求确认缺失字段，不自动发送。`,
    stages: [
      {
        id: 'anchor',
        title: '冻结公开输入并建立锚点',
        input: '纪要 URL/快照。',
        operation: '按议题和段落生成稳定定位，不改写原文。',
        visibleProcess: ['网页读取', '段落编号', '来源清单'],
        output: '带锚点的输入快照。',
        acceptance: ['输入公开且 URL 已保存', '每个段落可重新定位'],
      },
      {
        id: 'extract',
        title: '区分行动、决议与提案',
        input: '带锚点纪要。',
        operation: '按语言证据分类，提取明示 owner/due，未知字段保持空。',
        visibleProcess: ['分类依据', '逐行来源', '不确定项标记'],
        output: 'actions.csv 和 decisions 草稿。',
        acceptance: ['没有脑补负责人/日期', '提案没有标为决议'],
      },
      {
        id: 'validate',
        title: '逐项回查和完整度检查',
        input: '结构化草稿和原文。',
        operation: '回查每项证据，计算缺失字段和重复行动。',
        visibleProcess: ['证据回跳', 'schema 校验', '完整度统计'],
        output: '核验后的行动表和待确认列表。',
        acceptance: ['每项有原文定位', '所有缺失值均显式标记'],
      },
      {
        id: 'deliver',
        title: '生成人工确认材料',
        input: '已核验行动、决议和缺口。',
        operation: '生成下载文件与待发送邮件草稿，不执行外部发送。',
        visibleProcess: ['文件生成', '预览', '外部动作保持未执行'],
        output: '行动表、决议清单和确认邮件草稿。',
        acceptance: ['邮件未自动发送', '收件人能逐条确认缺口'],
      },
    ],
    artifacts: [
      {
        title: 'actions.csv',
        format: 'CSV',
        description: '可追溯行动、负责人、期限与待确认状态。',
      },
      { title: 'decisions.md', format: 'Markdown', description: '正式决议、提案和开放问题分栏。' },
      {
        title: 'follow-up-email.md',
        format: 'Markdown',
        description: '只请求确认缺失字段的邮件草稿。',
      },
    ],
    checks: [
      {
        title: '原文回查',
        method: '逐行打开 evidence_url/锚点并比对行动措辞。',
        passCriterion: '所有行动均有支持文本；无法定位项删除或标待确认。',
      },
      {
        title: '禁止脑补',
        method: '筛选 owner/due 非空行并验证原文明示。',
        passCriterion: '100% 非空 owner/due 有直接证据。',
      },
    ],
    suggestion: {
      agentId: 'office-assistant',
      agentName: '办公助手',
      modelId: 'MiniMax-M3',
      modelGuidance: '默认模型即可；长纪要可提高上下文能力，不需要最高推理档。',
      why: '关键是结构化、来源锚点和缺失值诚实，而不是复杂推理。',
    },
    replay: PENDING_REPLAY,
  },
  {
    id: 'general-public-data-brief',
    contentVersion: 3,
    category: 'general',
    title: '用公开数据做一页市场进入简报',
    summary:
      '通过 World Bank API 比较三个国家的互联网普及、人口和人均 GDP，把事实、计算和商业假设分开交付。',
    audience: '需要快速形成可核验市场初筛材料的创业者、产品与战略团队',
    difficulty: '入门',
    outcome: '一页可追溯简报、原始 API 响应和计算表；不会把宏观指标冒充真实市场规模。',
    capabilityIds: ['web-research', 'artifacts-download', 'container-web-preview'],
    requirements: [
      '联网访问 World Bank API',
      '预先指定三个国家和同一可用年份',
      '不使用未授权付费报告',
    ],
    sources: [
      {
        title: 'World Bank Indicators API',
        url: 'https://api.worldbank.org/v2/',
        role: 'input',
        license: 'World Bank datasets 默认 CC BY 4.0；例外数据集以目录标注为准',
        usageNote: '记录指标代码、国家、年份、请求 URL 和最后更新时间，并按要求署名。',
      },
      {
        title: 'World Bank Data Access and Licensing',
        url: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889386-open-data-terms-of-use',
        role: 'license',
        license: 'CC BY 4.0（受页面列明例外约束）',
        usageNote: '简报附数据来源和许可，不暗示 World Bank 认可商业结论。',
      },
    ],
    inputMaterials: [
      {
        title: 'market-question.md',
        description: '固定比较国家、产品假设、年份规则与宏观指标边界。',
        assetPath: 'tutorialCaseCatalog.ts#general-public-data-brief/market-question',
        revision: 'question-v1',
        sha256: '2674dee70dcc4942cdce32954a05bf81d2641d4213062162b74fa40e72f9c282',
        bytes: 181,
        inlineContent:
          'countries=IDN,VNM,PHL\nyear=2022\nindicators=SP.POP.TOTL,NY.GDP.PCAP.CD,IT.NET.USER.ZS\nproduct=AI coding subscription for individual developers\nmacro_metrics_are_not_market_size=true\n',
        preparation: '固定比较印度尼西亚、越南、菲律宾与 2022 年，不在看过结果后改年份。',
      },
      {
        title: 'World Bank 人均 GDP 响应',
        description: '三国 2022 年 NY.GDP.PCAP.CD 的固定 JSON 响应。',
        sourceUrl:
          'https://api.worldbank.org/v2/country/IDN;VNM;PHL/indicator/NY.GDP.PCAP.CD?format=json&date=2022&per_page=100',
        assetPath: '/tutorials/cases/general-public-data-brief/inputs/world-bank-gdp.json',
        revision: 'world-bank-2022-gdp-captured-2026-08-08',
        sha256: '4999c2a6235c3c510ac06c8276d91f07b803be668ab2a7ac08b3414ad0b6b713',
        bytes: 752,
        preparation: '保存完整请求 URL、响应、抓取时间和 SHA-256，不手抄网页数字。',
      },
      {
        title: 'World Bank 人口响应',
        description: '三国 2022 年 SP.POP.TOTL 的固定 JSON 响应。',
        sourceUrl:
          'https://api.worldbank.org/v2/country/IDN;VNM;PHL/indicator/SP.POP.TOTL?format=json&date=2022&per_page=100',
        assetPath: '/tutorials/cases/general-public-data-brief/inputs/world-bank-population.json',
        revision: 'world-bank-2022-population-captured-2026-08-08',
        sha256: '1681702d6f9ba85240240cd258618c5bad6b35b8a2256239de9df40713987b3b',
        bytes: 688,
        preparation: '保存完整请求 URL、响应、抓取时间和 SHA-256，不手抄网页数字。',
      },
      {
        title: 'World Bank 互联网使用率响应',
        description: '三国 2022 年 IT.NET.USER.ZS 的固定 JSON 响应。',
        sourceUrl:
          'https://api.worldbank.org/v2/country/IDN;VNM;PHL/indicator/IT.NET.USER.ZS?format=json&date=2022&per_page=100',
        assetPath: '/tutorials/cases/general-public-data-brief/inputs/world-bank-internet.json',
        revision: 'world-bank-2022-internet-captured-2026-08-08',
        sha256: '3337d51f8246765e71acd81313f5f0cabac1e2bd59c70836c4ad733595929a83',
        bytes: 797,
        preparation: '保存完整请求 URL、响应、抓取时间和 SHA-256，不手抄网页数字。',
      },
    ],
    starterPrompt: `为一个面向个人开发者的 AI 编程订阅产品制作市场初筛简报。比较印度尼西亚、越南和菲律宾，只用已冻结的 World Bank API 2022 年人口（SP.POP.TOTL）、人均 GDP（NY.GDP.PCAP.CD）和互联网使用率（IT.NET.USER.ZS）响应；先逐个校验 SHA-256，不在运行时改年份。
保存原始 JSON 和请求 URL，用脚本生成 tidy-data.csv；每个数字注明指标、国家、年份和来源。把“数据事实”“计算结果”“商业假设”分开，明确这三个宏观指标不能直接代表付费开发者人数或市场规模。
输出 one-page-brief.html、tidy-data.csv、sources.md 和 assumptions.md，并在浏览器中检查桌面/移动版。`,
    stages: [
      {
        id: 'scope',
        title: '冻结指标与年份规则',
        input: '市场问题、三个国家和指标代码。',
        operation: '核对指标定义、单位和可比性，声明共同年份选择算法。',
        visibleProcess: ['指标元数据', '范围确认', '限制清单'],
        output: 'data-plan.md。',
        acceptance: ['指标代码和单位明确', '没有先看数值再挑年份'],
      },
      {
        id: 'fetch',
        title: '获取并保存原始响应',
        input: '固定 API 请求。',
        operation: '校验三个 2022 年固定响应的哈希，再生成结构化表。',
        visibleProcess: ['API URL', '响应保存', '共同年份计算'],
        output: 'raw/*.json 与 tidy-data.csv。',
        acceptance: ['所有数值来自保存的响应', '三国使用同一年份'],
      },
      {
        id: 'analyze',
        title: '分开事实、计算与假设',
        input: '结构化指标和产品假设。',
        operation: '计算派生比较，但不从宏观数值推导付费市场规模。',
        visibleProcess: ['计算脚本', '来源行号', '假设登记'],
        output: '证据表、假设和建议的初稿。',
        acceptance: ['商业判断显式标为假设', '没有未引用外部数字'],
      },
      {
        id: 'publish',
        title: '制作一页简报并验收',
        input: '核验后的内容和来源。',
        operation: '生成响应式 HTML，在桌面/移动预览并检查链接和数字。',
        visibleProcess: ['HTML 产物', '容器网页预览', '链接/数字检查'],
        output: '一页简报及可下载数据底稿。',
        acceptance: ['移动端无横向溢出', '页面每个数字能回到 tidy-data.csv'],
      },
    ],
    artifacts: [
      { title: 'one-page-brief.html', format: 'HTML', description: '响应式一页初筛简报。' },
      { title: 'tidy-data.csv', format: 'CSV', description: '国家、指标、年份、数值和来源 URL。' },
      {
        title: 'assumptions.md',
        format: 'Markdown',
        description: '商业假设、未知量和下一步一手调研。',
      },
    ],
    checks: [
      {
        title: '数字血缘',
        method: '从 HTML 每个数字反查 CSV，再反查原始 JSON。',
        passCriterion: '全部数字三段一致且国家/指标/年份匹配。',
      },
      {
        title: '结论边界',
        method: '搜索“市场规模、付费用户、收入”等结论并检查证据类型。',
        passCriterion: '未将宏观代理指标表述为真实市场规模；假设均有标签。',
      },
    ],
    suggestion: {
      agentId: 'research-assistant',
      agentName: '科研助手',
      modelId: 'deepseek-v4-flash',
      modelGuidance: '默认模型即可；开启联网和成果预览。',
      why: '数据量小，价值来自来源血缘和结论边界，而不是更昂贵的推理。',
    },
    replay: PENDING_REPLAY,
  },
] as const satisfies readonly TutorialCase[]

export const TUTORIAL_CASE_BY_ID = Object.fromEntries(
  TUTORIAL_CASES.map((tutorialCase) => [tutorialCase.id, tutorialCase]),
) as unknown as Record<TutorialCaseId, TutorialCase>

const TUTORIAL_CASE_ID_SET = new Set<string>(TUTORIAL_CASE_IDS)

export function parseTutorialCaseId(value: string | null | undefined): TutorialCaseId | null {
  return typeof value === 'string' && TUTORIAL_CASE_ID_SET.has(value)
    ? (value as TutorialCaseId)
    : null
}
