/**
 * GNSS-X 地学工具插件（OCV5-401）的静态规格生成器。
 *
 * 输入是 https://mcp.gnss-x.ac.cn/rpc 无鉴权 `tools/list` 的快照（gnssXToolsSnapshot.json），
 * 输出一份 plugin-blueprint-v1（gnss-x.blueprint.json）。它只上 AI 市场，走普通插件的
 * prepare → publish → 审核流程，**不进** DEFAULT_CONNECTORS（不预装）。
 *
 * 每个动作都是 POST /rpc 的 JSON-RPC `tools/call`：`name` 写死成上游工具名，`arguments` 的每个
 * 字段只引用 `params.*`，effect=read（POST 只读，由 blueprint 编译成 safeReadNonGet）。
 *
 * 改 Token 的放置方式只改 GNSS_X_TOKEN_PLACEMENT 一处，然后重新生成并把 GNSS_X_VERSION 加一：
 *   { type: 'bearer' }                      → Authorization: Bearer <token>
 *   { type: 'header', name: 'X-API-Key' }   → X-API-Key: <token>（可加 prefix）
 *   { type: 'query', name: 'token' }        → /rpc?token=<token>
 * 生成：`npx tsx scripts/gen-gnss-x-blueprint.ts`；只核对不写：加 `--check`。
 */

export const GNSS_X_SLUG = 'gnss-x'
export const GNSS_X_VERSION = '1.0.0'
export const GNSS_X_API_ORIGIN = 'https://mcp.gnss-x.ac.cn'
export const GNSS_X_RPC_PATH = '/rpc'
/** GNSS-X 对缺失/无效 Token 返回的 JSON-RPC 错误码（HTTP 401）。 */
export const GNSS_X_AUTH_ERROR_CODE = -32001

/**
 * Token 放在哪个请求头。2026-10-13 管家拍板先用 Authorization: Bearer；拿到真 Token 后实测确认，
 * 不对就按文件头的说明改这一处。
 */
export const GNSS_X_TOKEN_PLACEMENT: GnssXTokenPlacement = { type: 'bearer' }

export type GnssXTokenPlacement =
  | { type: 'bearer' }
  | { type: 'header'; name: string; prefix?: string }
  | { type: 'query'; name: string }

/** 绑定时的身份探测：调用一次 time（消耗 1 次 time 配额），401 即 Token 无效。 */
export const GNSS_X_IDENTITY_ACTION = 'time'

/** 上游 20 个绘图工具（复用 GNSS-X 站内 LLM 出图）。任务要求一律不收。 */
export const GNSS_X_DRAWING_TOOLS = [
  'uml_class',
  'uml_sequence',
  'uml_usecase',
  'uml_activity',
  'uml_state',
  'uml_component',
  'uml_deployment',
  'er_diagram',
  'flowchart',
  'c4_diagram',
  'mechanism',
  'roadmap',
  'architecture',
  'dataflow',
  'pipeline',
  'framework',
  'gantt',
  'mindmap',
  'timeline',
  'quadrant',
] as const

/** 绘图之外不收的工具及理由（审查时逐条可核）。 */
export const GNSS_X_EXCLUDED: Readonly<Record<string, string>> = {
  databox_weather: '任务要求不收；还需另配云遥 DataBox 密钥',
  databox_sounding: '任务要求不收；还需另配云遥 DataBox 密钥',
  satellite_news: '资讯检索，返回第三方新闻原文（不可信文本），不是地学计算',
  satellite_news_report: '资讯日报，同上',
  satellite_news_brief: '资讯速览，同上',
  satellite_news_stats: '资讯统计，同上',
  nequick_gim: '全球格网输出，常超出单次结果上限',
  unit_convert: '单位换算，模型可直接准确完成',
  angle_convert: '角度换算，模型可直接准确完成',
  dew_point: '单个闭式公式（Magnus），模型可直接计算',
  wind_chill: '单个闭式公式，与地学定位无关',
  heat_index: '单个闭式公式，与地学定位无关',
  ballistic_coefficient: 'B=Cd·A/m，drag_acceleration 等已接受 cd/area/mass',
  free_space_loss: 'FSPL 单式，link_budget 已包含',
  error_budget: '各项均方根合成，模型可直接计算',
  seawater_freezing: '单个多项式，使用面窄',
  impact_parameter: '直线几何，不含大气折射，模型可直接计算',
  chapman_profile: '合成教学剖面，非观测数据',
  atmosphere_compare: '模型对比，cira_profile / msis_profile 可分别得到',
  scale_height_profile: '标高剖面，cira_profile 已覆盖主要用途',
  cira_refractivity: '与 atmo_refractivity（atmosphere=cira）重复',
  msis_composition: 'msis_density / msis_profile 已覆盖主要用途',
}

/** 收录的 60 个工具按领域分组（商品页和审查用）；分组必须恰好覆盖收录集合。 */
export const GNSS_X_GROUPS: ReadonlyArray<{ title: string; tools: readonly string[] }> = [
  { title: '时间系统', tools: ['time', 'gpst_utc', 'leap_seconds', 'timezone', 'sidereal'] },
  {
    title: '大地测量与坐标框架',
    tools: [
      'coor',
      'geodesic',
      'ellipsoid',
      'eop_query',
      'helmert',
      'map_projection',
      'eci_ecef',
      'station_epoch',
    ],
  },
  {
    title: '天文与轨道',
    tools: [
      'satellite',
      'sun_moon',
      'orbit',
      'space_object',
      'site_visibility',
      'drag_acceleration',
      'orbit_decay_rate',
      'orbit_lifetime',
    ],
  },
  {
    title: '电离层',
    tools: [
      'tec_query',
      'vtec_map',
      'stec_query',
      'ionosonde',
      'nequick_vtec',
      'nequick_stec',
      'klobuchar',
    ],
  },
  { title: '空间天气', tools: ['kp_index', 'dst_index', 'solar_wind'] },
  {
    title: '大气与气象',
    tools: [
      'pressure_altitude',
      'typhoon',
      'high_impact_weather',
      'cira_profile',
      'msis_density',
      'msis_profile',
      'atmo_refractivity',
      'troposphere_delay',
      'pwv',
    ],
  },
  { title: '掩星反演', tools: ['bending_angle', 'abel_inversion', 'dry_temperature'] },
  {
    title: '重力场',
    tools: [
      'normal_gravity',
      'gravity_correction',
      'eotvos_correction',
      'isostasy',
      'gravity_field',
    ],
  },
  { title: '海洋', tools: ['sound_speed', 'seawater_density'] },
  { title: 'GNSS 信号与几何', tools: ['gnss_frequency', 'dop'] },
  {
    title: '测量平差',
    tools: ['adjustment_gauss_markov', 'leveling_adjust', 'traverse_closure', 'qc_outliers'],
  },
  {
    title: '电波传播',
    tools: ['rain_attenuation', 'gaseous_attenuation', 'link_budget', 'radio_horizon'],
  },
]

export const GNSS_X_MAX_ACTIONS = 60
/** 单个字符串入参上限（矩阵、剖面等以 JSON 字符串传入）。 */
export const GNSS_X_STRING_MAX_LENGTH = 65_536

/**
 * 控制返回规模的入参边界。数组最多 200 项与平台结果硬限（256KB / 深度 8 / 数组 200）一致；
 * 其余数值取自上游文档写明的范围。超过平台硬限的结果会以 RESULT_TOO_LARGE 失败，不会截断。
 */
export const GNSS_X_PARAM_BOUNDS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
> = {
  eop_query: { limit: { minimum: 1, maximum: 200 } },
  space_object: { limit: { minimum: 1, maximum: 200 } },
  dst_index: { limit: { minimum: 1, maximum: 200 } },
  kp_index: { limit: { minimum: 1, maximum: 200 } },
  solar_wind: { limit: { minimum: 1, maximum: 200 } },
  ionosonde: { days: { minimum: 1, maximum: 30 }, bin_minutes: { enum: [5, 15, 30, 60] } },
  cira_profile: { step_km: { minimum: 0.1 } },
  msis_density: { step_km: { minimum: 0.1 } },
  msis_profile: { step_km: { minimum: 0.1 } },
  site_visibility: { step_s: { minimum: 1 } },
  orbit_lifetime: { step_days: { minimum: 0.01 }, max_days: { minimum: 1, maximum: 36_500 } },
}

export const GNSS_X_RESULT_LIMIT_NOTE =
  '单次结果上限 256KB（数组最多 200 项、嵌套最多 8 层），超出会报 RESULT_TOO_LARGE：缩小时间/高度范围、增大步长或减少条数后重试。'

export const GNSS_X_AUTH_HINT =
  'Token 无效、被撤销或该工具配额用完时，上游返回 HTTP 401（JSON-RPC 错误码 -32001），这里显示为 UPSTREAM_AUTH_FAILED；结果里出现 error.code=-32001 也是同一原因。请提示用户到 https://mcp.gnss-x.ac.cn 「用户」页检查 Token 和各工具剩余配额，必要时在 管理中心 → 插件 重新填写 Token；不要自动重试。'

export interface GnssXTool {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
}

export interface GnssXSnapshot {
  tools: GnssXTool[]
}

export interface BuildGnssXOptions {
  tokenPlacement?: GnssXTokenPlacement
}

const FIELD_RE = /^[A-Za-z0-9_.-]{1,128}$/
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])
const ACTION_DESCRIPTION_MAX = 2_000
const SUMMARY_MAX = 80

function fail(message: string): never {
  throw new Error(`gnss-x blueprint: ${message}`)
}

/** 上游描述去掉「XxxTool：」前缀和 Python format 留下的双花括号。 */
function cleanDescription(raw: string | undefined): string {
  return (raw ?? '')
    .replaceAll('{{', '{')
    .replaceAll('}}', '}')
    .replace(/^\s*[A-Za-z]+Tool[：:]\s*/, '')
    .trim()
}

function summaryOf(tool: GnssXTool): string {
  const text = cleanDescription(tool.description)
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  if (!firstLine) fail(`tool ${tool.name} has no description`)
  const sentence = firstLine.split(/(?<=[。；])/)[0] ?? firstLine
  return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1)}…` : sentence
}

/** 上游 anyOf（如 base_time 可为字符串/数值/对象）统一按字符串传：对象用 JSON 字符串。 */
function paramSchema(
  toolName: string,
  name: string,
  raw: Record<string, unknown>,
): { schema: Record<string, unknown>; typeLabel: string; doc: string } {
  if (!FIELD_RE.test(name)) fail(`tool ${toolName} param ${name} is not a safe field name`)
  const doc = cleanDescription(typeof raw.description === 'string' ? raw.description : '')
  let type = typeof raw.type === 'string' ? raw.type : undefined
  let typeLabel = type ?? ''
  if (type === undefined && Array.isArray(raw.anyOf)) {
    type = 'string'
    typeLabel = 'string，对象请传 JSON 字符串'
  }
  if (type === undefined || !SCALAR_TYPES.has(type))
    fail(`tool ${toolName} param ${name} has unsupported type`)
  const schema: Record<string, unknown> = { type }
  if (type === 'string') schema.maxLength = GNSS_X_STRING_MAX_LENGTH
  const bounds = GNSS_X_PARAM_BOUNDS[toolName]?.[name]
  if (bounds) Object.assign(schema, bounds)
  return { schema, typeLabel, doc }
}

function actionDescription(tool: GnssXTool, paramLines: string[]): string {
  const summary = summaryOf(tool)
  const detail = cleanDescription(tool.description)
  const head = [summary, '', '参数：', ...(paramLines.length ? paramLines : ['（无）'])].join('\n')
  const full = `${head}\n\n说明：\n${detail}`
  if (head.length > ACTION_DESCRIPTION_MAX) fail(`tool ${tool.name} parameter list is too long`)
  return full.length > ACTION_DESCRIPTION_MAX
    ? `${full.slice(0, ACTION_DESCRIPTION_MAX - 1)}…`
    : full
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jsonrpc: { type: 'string' },
    id: { type: 'integer' },
    result: { type: 'object' },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'integer' }, message: { type: 'string' } },
    },
  },
}

export function selectedGnssXToolNames(snapshot: GnssXSnapshot): string[] {
  const names = snapshot.tools.map((tool) => tool.name)
  if (new Set(names).size !== names.length) fail('tools/list has duplicate names')
  const excluded = new Set<string>([...GNSS_X_DRAWING_TOOLS, ...Object.keys(GNSS_X_EXCLUDED)])
  for (const name of excluded)
    if (!names.includes(name)) fail(`excluded tool ${name} is missing from tools/list`)
  const selected = names.filter((name) => !excluded.has(name))
  if (selected.length > GNSS_X_MAX_ACTIONS)
    fail(`${selected.length} tools selected; at most ${GNSS_X_MAX_ACTIONS} allowed`)
  const grouped = GNSS_X_GROUPS.flatMap((group) => group.tools)
  if (
    grouped.length !== selected.length ||
    new Set(grouped).size !== grouped.length ||
    grouped.some((name) => !selected.includes(name))
  )
    fail('GNSS_X_GROUPS must cover the selected tools exactly once')
  return grouped
}

function buildAction(tool: GnssXTool): Record<string, unknown> {
  const input = tool.inputSchema ?? {}
  if (input.type !== undefined && input.type !== 'object')
    fail(`tool ${tool.name} inputSchema is not an object`)
  const rawProps = input.properties ?? {}
  const required = (input.required ?? []).filter((name) => Object.hasOwn(rawProps, name))
  const properties: Record<string, unknown> = {}
  const args: Record<string, string> = {}
  const paramLines: string[] = []
  for (const [name, raw] of Object.entries(rawProps)) {
    const { schema, typeLabel, doc } = paramSchema(tool.name, name, raw)
    properties[name] = schema
    args[name] = `$${name}`
    const need = required.includes(name) ? '必填' : '可选'
    paramLines.push(`- ${name}（${typeLabel}，${need}）${doc ? `：${doc.replace(/\s+/g, ' ')}` : ''}`)
  }
  return {
    id: tool.name,
    description: actionDescription(tool, paramLines),
    method: 'POST',
    path: GNSS_X_RPC_PATH,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool.name, arguments: args },
    },
    params: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    },
    result: RESULT_SCHEMA,
    effect: 'read',
  }
}

function humanMd(snapshot: GnssXSnapshot, selected: readonly string[]): string {
  const byName = new Map(snapshot.tools.map((tool) => [tool.name, tool]))
  const groups = GNSS_X_GROUPS.map((group) => {
    const lines = group.tools.map((name) => `- \`${name}\`：${summaryOf(byName.get(name)!)}`)
    return [`### ${group.title}（${group.tools.length}）`, ...lines].join('\n')
  })
  const excluded = Object.entries(GNSS_X_EXCLUDED).map(
    ([name, reason]) => `- \`${name}\`：${reason}`,
  )
  return [
    '## 使用前准备：需要你自己注册并领取 Token',
    '',
    '1. 打开 https://mcp.gnss-x.ac.cn 注册账号（站点可能需要人工审核，有邀请码可即时通过）。',
    '2. 登录后在「用户」页添加一个 LLM 密钥（GNSS-X 领取 Token 时要求绑定），再点「领取 Token」。',
    '3. 在本平台「管理中心 → 插件」安装并打开 GNSS-X 地学工具，把 Token 填进去。Token 只保存在平台服务端，不会进入 AI 的运行环境。',
    '',
    '本插件由第三方服务 GNSS-X（AtomicXpert）提供计算与数据，平台不提供或代领 Token。',
    '',
    `## 收录的 ${selected.length} 个工具（全部只读）`,
    '',
    ...groups.flatMap((group) => [group, '']),
    '## 未收录',
    '',
    `- 绘图类 ${GNSS_X_DRAWING_TOOLS.length} 个（UML、流程图、架构图等，由 GNSS-X 站内 LLM 出图）`,
    ...excluded,
    '',
    '## 配额与限制',
    '',
    '- 每次调用消耗 GNSS-X 对应工具的配额，剩余次数可在 GNSS-X「用户」页查看；绑定时会调用一次 `time` 校验 Token。',
    `- ${GNSS_X_RESULT_LIMIT_NOTE}`,
    '- 每个账号只绑定一个 GNSS-X Token；重新填写会替换旧的。',
    '',
    '## 常见问题',
    '',
    `- **提示 Token 无效或配额用完**（HTTP 401 / 错误码 ${GNSS_X_AUTH_ERROR_CODE}）：到 GNSS-X「用户」页确认 Token 仍有效、对应工具还有剩余配额；需要时在「管理中心 → 插件」重新填写 Token。`,
  ].join('\n')
}

/** 把 tools/list 快照编译成 plugin-blueprint-v1（纯函数，输出稳定）。 */
export function buildGnssXBlueprint(
  snapshot: GnssXSnapshot,
  options: BuildGnssXOptions = {},
): Record<string, unknown> {
  const selected = selectedGnssXToolNames(snapshot)
  const byName = new Map(snapshot.tools.map((tool) => [tool.name, tool]))
  if (!selected.includes(GNSS_X_IDENTITY_ACTION)) fail('identity action is not selected')
  return {
    format: 'plugin-blueprint-v1',
    slug: GNSS_X_SLUG,
    name: 'GNSS-X 地学工具',
    // 市场扫描要求 description 是单行纯文本。
    description: [
      `GNSS-X（AtomicXpert）地学专家工具：时间系统、坐标框架、轨道、电离层、空间天气、大气、重力、海洋、GNSS、测量平差与电波传播共 ${selected.length} 个只读计算/查询工具。`,
      '需要用户自己在 https://mcp.gnss-x.ac.cn 注册账号并领取 Token，再到 管理中心 → 插件 填写；每次调用消耗 GNSS-X 对应工具的配额。',
      '用法：先 oc-connect describe gnss-x <工具名> 看参数，再把 JSON 参数从 stdin 传给 oc-connect call gnss-x <工具名>。',
      GNSS_X_AUTH_HINT,
      GNSS_X_RESULT_LIMIT_NOTE,
    ].join(' '),
    version: GNSS_X_VERSION,
    category: 'research-academic',
    useCases: [
      '把 UTC 时间换算成 GPS 周和周内秒，或查询闰秒与恒星时',
      '查询全球电离层 vTEC、Kp/Dst 地磁指数和太阳风参数',
      '计算测站卫星可见时段、DOP 与对流层/电离层延迟',
      '做 UTM/高斯投影、七参数基准转换和水准网平差',
    ],
    outcomeExamples: [
      '给它 2026-10-13T00:00:00Z → 得到 GPS 周、周内秒和 MJD',
      '给它测站经纬度和时间段 → 得到 GPS 卫星过顶时段与 PDOP',
    ],
    humanMd: humanMd(snapshot, selected),
    tags: ['GNSS', '地学', '电离层', '空间天气', '测绘', '轨道', 'API插件'],
    visibility: 'public',
    apiOrigin: GNSS_X_API_ORIGIN,
    auth: { mode: 'static-token', placement: options.tokenPlacement ?? GNSS_X_TOKEN_PLACEMENT },
    identity: { actionId: GNSS_X_IDENTITY_ACTION, accountKeyPointer: '/jsonrpc' },
    actions: selected.map((name) => buildAction(byName.get(name)!)),
  }
}
