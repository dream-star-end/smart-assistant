/**
 * Intelligent UI 第三轮(OCV5-361 后续)视觉预览:来源、大纲 / 思维导图、成稿(含改写对比)、长表格。
 * 和第二轮一样只依赖 MessageList,改造前的树上也能跑(新组件在旧树上显示为降级文本,用于前后对照)。
 * 数据是预览用的示例,不是真实统计。
 */
import { type ReactNode, useEffect } from 'react'
import { conversation, Timeline } from './scenes-iui'
import type { Scene } from './types'

const ui = (v: unknown) => `\n\`\`\`ui\n${JSON.stringify(v)}\n\`\`\`\n`

/** 挂载后点一下某个按钮(截「对比原文」打开后的样子);旧树上没有这个按钮时什么也不做。 */
function ClickAfterMount({ label, children }: { label: string; children: ReactNode }) {
  useEffect(() => {
    const t = setTimeout(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
      btn?.click()
    }, 60)
    return () => clearTimeout(t)
  }, [label])
  return <>{children}</>
}

export const R3_RESEARCH = [
  '按公开口径,2025 年国内新能源乘用车的零售渗透率全年在五成上下,下半年多数月份超过一半 [1][2];出口量继续增长,但增速比前两年放缓 [3]。下面的数字都是预览用的示例。',
  ui({
    type: 'stats',
    title: '2025 年新能源乘用车(示例)',
    items: [
      { label: '全年零售渗透率', value: 51.2, unit: '%', delta: '+8.6 个百分点', trend: [41, 44, 46, 49, 50, 52, 53, 54], basis: '零售口径,来源 [2]' },
      { label: '出口量', value: 186, unit: '万辆', delta: '+19%', trend: [120, 132, 150, 160, 171, 186] },
    ],
  }),
  ui({
    type: 'sources',
    items: [
      { title: '2025 年 12 月汽车工业经济运行情况', url: 'https://www.caam.org.cn/', site: 'caam.org.cn', date: '2026-01-12', note: '全年产销与新能源占比' },
      { title: '2025 年全国乘用车市场分析', url: 'https://www.cpcaauto.com/', site: 'cpcaauto.com', date: '2026-01-08', note: '零售渗透率按月数据' },
      { title: 'Global EV Outlook 2026', url: 'https://www.iea.org/reports/global-ev-outlook-2026', date: '2026-05', note: '各国电动车销量与出口' },
      { title: '海关总署统计月报', url: 'https://www.customs.gov.cn/', site: 'customs.gov.cn', date: '2026-01' },
    ],
  }),
].join('\n')

export const R3_OUTLINE = [
  '这本书的骨架是「两个系统」:先讲它们怎么分工,再讲由此产生的偏差,最后落到决策和幸福感。',
  ui({
    type: 'outline',
    title: '《思考,快与慢》框架',
    subtitle: '五个部分,38 章',
    items: [
      { title: '两个系统', detail: '系统 1 快而自动,系统 2 慢而费力', children: ['注意力与努力', '懒惰的系统 2', { title: '联想机器', children: ['启动效应', '认知放松'] }] },
      { title: '启发式与偏差', detail: '凭直觉估计时的系统性错误', children: ['锚定效应', '可得性启发', '代表性启发', '小数定律'] },
      { title: '过度自信', children: ['理解的错觉', '有效性错觉', '专家直觉什么时候可信'] },
      { title: '选择', detail: '前景理论', children: ['损失厌恶', '禀赋效应', '框架效应'] },
      { title: '两个自我', children: ['经验自我与记忆自我', '峰终定律'] },
    ],
  }),
].join('\n')

export const R3_MINDMAP = [
  '按「谁、做什么、什么时候」拆成四条线,每条线指定一个负责人,周会只看这四张卡。',
  ui({
    type: 'outline',
    title: '新品发布会筹备',
    view: 'map',
    items: [
      { title: '内容', children: ['主讲稿与演示', { title: '产品视频', children: ['脚本', '拍摄', '剪辑'] }, '媒体问答'] },
      { title: '场地与物料', children: ['场地预订', '舞台与灯光', '签到与胸牌'] },
      { title: '宣传', children: ['预热海报', '媒体邀请', { title: '直播', children: ['平台', '推流测试'] }] },
      { title: '时间线', detail: '倒排 6 周', children: ['T-6 周 定方案', 'T-2 周 彩排', 'T-0 发布'] },
    ],
  }),
].join('\n')

export const R3_EMAIL = [
  '给你写了两个版本:正式一点的适合第一次沟通,简短的适合已经口头说过、只需要留个书面记录。',
  ui({
    type: 'draft',
    title: '退租通知',
    kind: 'email',
    variants: [
      {
        label: '正式',
        subject: '关于 3 号楼 1202 室提前退租的通知',
        text: '王先生您好:\n\n我是 3 号楼 1202 室的租客李明。因工作调动,我计划于 11 月 30 日退租,特此提前一个月通知您。\n\n退租前我会把房屋打扫干净,并按合同约定结清水电燃气费用。方便的话,请您告知交房验收的时间,以及押金退还的方式。\n\n感谢这两年的照顾!\n\n李明\n138 0000 0000',
      },
      {
        label: '简短',
        subject: '1202 室 11 月底退租',
        text: '王先生好,跟您确认一下:我 11 月 30 日退租,费用会按合同结清。交房时间您定,押金麻烦转回原账户。谢谢!\n\n李明',
      },
    ],
    note: '合同若约定了更长的提前通知期,以合同为准。',
  }),
].join('\n')

export const R3_POLISH = [
  '改动集中在三处:把「做过很多项目」换成具体成果,删掉重复的「负责」,结尾补一句你想做什么。',
  ui({
    type: 'draft',
    title: '自我介绍(润色后)',
    kind: 'doc',
    variants: [
      {
        label: '润色版',
        text: '我是张悦,做了五年 B 端产品经理。最近两年主导了供应链系统重构,把订单处理时长从 4 小时缩短到 40 分钟。我擅长把业务问题拆成可以落地的需求,也习惯用数据验证效果。接下来,我想在 SaaS 增长方向做更深的积累。',
      },
    ],
    original: '我是张悦,做了五年产品经理,做过很多项目。我负责过供应链系统,负责需求和上线。我擅长把业务问题拆成需求,也会看数据。',
  }),
].join('\n')

const CITIES: [string, string, number, number][] = [
  ['上海', '华东', 4.92, 2487], ['北京', '华北', 4.71, 2185], ['深圳', '华南', 3.68, 1779], ['广州', '华南', 3.1, 1883],
  ['重庆', '西南', 3.02, 3191], ['苏州', '华东', 2.67, 1295], ['成都', '西南', 2.35, 2140], ['杭州', '华东', 2.18, 1252],
  ['武汉', '华中', 2.12, 1377], ['南京', '华东', 1.86, 954], ['天津', '华北', 1.76, 1364], ['宁波', '华东', 1.71, 969],
  ['青岛', '华东', 1.6, 1037], ['无锡', '华东', 1.59, 749], ['长沙', '华中', 1.53, 1051], ['郑州', '华中', 1.42, 1300],
  ['福州', '华东', 1.4, 845], ['济南', '华东', 1.33, 944], ['合肥', '华东', 1.31, 985], ['佛山', '华南', 1.36, 961],
]

export const R3_TABLE = [
  '20 个城市都放在一张表里了:点表头可以排序,右上角能下载成 CSV 用 Excel 打开,上面的框可以按城市或区域筛选。',
  ui({
    type: 'table',
    title: 'GDP 前 20 城市',
    subtitle: '示例数据,单位万亿元 / 万人',
    columns: ['城市', '区域', { label: 'GDP', unit: '万亿元', bar: true }, { label: '常住人口', unit: '万人' }],
    rows: CITIES,
    source: '预览用示例数据',
  }),
].join('\n')

const VIEWPORTS: ('desktop' | 'mobile')[] = ['mobile', 'desktop']
const scene = (id: string, label: string, question: string, answer: string, click?: string): Scene => ({
  id,
  label,
  group: '工作区',
  viewports: VIEWPORTS,
  api: {},
  render: () =>
    click ? (
      <ClickAfterMount label={click}>
        <Timeline messages={conversation(question, answer)} />
      </ClickAfterMount>
    ) : (
      <Timeline messages={conversation(question, answer)} />
    ),
})

export const iuiR3Scenes: Scene[] = [
  scene('iui-r3-research', 'Intelligent UI · 查资料(指标 + 来源)', '2025 年新能源车渗透率到多少了?', R3_RESEARCH),
  scene('iui-r3-outline', 'Intelligent UI · 读书框架(大纲)', '帮我梳理一下《思考,快与慢》的框架', R3_OUTLINE),
  scene('iui-r3-mindmap', 'Intelligent UI · 发布会筹备(思维导图)', '下个月要办新品发布会,帮我把要做的事理一理', R3_MINDMAP),
  scene('iui-r3-email', 'Intelligent UI · 退租邮件(成稿 · 两个版本)', '帮我写封邮件跟房东说下个月底退租', R3_EMAIL),
  scene('iui-r3-polish', 'Intelligent UI · 润色自我介绍(成稿 · 对比原文)', '帮我润色一下这段自我介绍:我是张悦,做了五年产品经理……', R3_POLISH, '对比原文'),
  scene('iui-r3-table', 'Intelligent UI · 长表格(筛选 + CSV + 表头吸顶)', '列一下 GDP 前 20 的城市', R3_TABLE),
]
