/**
 * Intelligent UI 第二轮(OCV5-361 后续)视觉预览:覆盖全部新组件的七段对话,真实 MessageList 渲染。
 * 和 scenes-iui.tsx 一样只依赖 MessageList,改造前的树上也能跑(新组件在旧树上显示为降级文本,用于前后对照)。
 * 图片用 Unsplash 公开图(截图机需能访问外网;加载失败时组件显示色块)。
 */
import { conversation, Timeline } from './scenes-iui'
import type { Scene } from './types'

const ui = (v: unknown) => `\n\`\`\`ui\n${JSON.stringify(v)}\n\`\`\`\n`
const photo = (id: string) => `https://images.unsplash.com/photo-${id}?w=900&q=70&auto=format&fit=crop`

export const R2_WARDROBE = [
  "秋天的胶囊衣橱,我会用 12 件单品,围绕巧克力棕、奶油白、深牛仔和酒红来搭。剪裁放松一点,针织要好,通勤、周末、晚饭都能穿。",
  "### 1. 这一季的感觉",
  ui({
    type: "gallery",
    images: [
      { src: photo("1445205170230-053b83016050"), caption: "暖色衣架" },
      { src: photo("1483985988355-763728e1935b"), caption: "酒红大衣" },
      { src: photo("1434389677669-e08b4cac3105"), caption: "奶油白针织" },
      { src: photo("1591047139829-d91aecb6caea"), caption: "驼色夹克" },
    ],
  }),
  ui({
    type: "swatches",
    colors: [
      { hex: "#efe6d8", name: "奶油白" },
      { hex: "#b8875a", name: "驼色" },
      { hex: "#5b3a29", name: "巧克力" },
      { hex: "#7a1f2b", name: "酒红" },
      { hex: "#2f3e55", name: "深牛仔" },
    ],
  }),
  "诀窍是几乎每件都能互换,再用酒红配饰或有肌理的面料让整套不显得平。",
  "### 2. 12 件清单",
  ui({
    type: "cards",
    layout: "grid",
    items: [
      { title: "奶油白粗针毛衣", subtitle: "上装 · 2 件", icon: "shirt", tags: ["百搭"] },
      { title: "驼色短夹克", subtitle: "外套", image: photo("1591047139829-d91aecb6caea"), tags: ["通勤"] },
      { title: "深色直筒牛仔", subtitle: "下装 · 2 条", icon: "shirt", tags: ["周末"] },
      { title: "酒红针织开衫", subtitle: "层搭", icon: "heart", tags: ["点睛"] },
    ],
  }),
  ui({ type: "suggestions", items: ["按我的身高 165 cm 调整版型", "换成适合下雨天的搭配", "预算控制在 3000 元内"] }),
].join("\n")

export const R2_GARDEN = [
  "不需要抬高的种植床,也不需要大院子。我会先用四五个盆,沿着围栏或者朝南的角落摆。",
  ui({
    type: "tiles",
    title: "你的 4×4 英尺菜园",
    columns: 2,
    items: [
      { title: "生菜 + 小萝卜", subtitle: "24 寸种植盆", icon: "leaf", tone: "green" },
      { title: "荷兰豆", subtitle: "盆 + 攀爬架", icon: "sprout", tone: "green" },
      { title: "羽衣甘蓝", subtitle: "12 寸盆", icon: "leaf", tone: "amber" },
      { title: "香草", subtitle: "1–2 个小盆", icon: "flower", tone: "amber" },
    ],
    caption: "示意布局,不按比例。每个盆之间留出能伸手浇水的空间。",
  }),
  ui({
    type: "progress",
    title: "每天需要的日照",
    subtitle: "按 8 小时满格",
    items: [
      { label: "荷兰豆", value: 7, max: 8, unit: "小时", tone: "good" },
      { label: "羽衣甘蓝", value: 6, max: 8, unit: "小时", tone: "good" },
      { label: "生菜", value: 4, max: 8, unit: "小时", note: "夏天正午要遮一点" },
      { label: "香草", value: 5, max: 8, unit: "小时" },
    ],
  }),
  ui({
    type: "steps",
    title: "这个周末",
    checkable: true,
    items: [
      { title: "买 4 个盆和 2 袋营养土", detail: "盆底要有排水孔", done: true },
      { title: "装土到离盆沿 3 厘米" },
      { title: "荷兰豆插好攀爬架再播种" },
      { title: "生菜和小萝卜混播", detail: "小萝卜 4 周就能收,正好给生菜让地方" },
      { title: "香草直接买小苗" },
    ],
  }),
  ui({ type: "callout", tone: "tip", title: "浇水", body: "手指插进土里 2 厘米,**干了再浇**。盆栽比地栽干得快,夏天可能每天都要浇。" }),
].join("\n")

export const R2_FINANCE = [
  "三个常用的都放在下面了,切换标签就能用。数字都在你这边实时算,公式可以展开核对。",
  ui({
    type: "tabs",
    title: "理财计算器",
    tabs: [
      {
        label: "定投",
        block: {
          type: "calculator",
          inputs: [
            { id: "monthly", label: "每月投入", value: 3000, step: 500, unit: "元" },
            { id: "rate", label: "年化收益", kind: "slider", value: 6, min: 0, max: 12, step: 0.5, unit: "%" },
            { id: "years", label: "投资年限", kind: "slider", value: 20, min: 1, max: 40, step: 1, unit: "年" },
          ],
          outputs: [
            { id: "value", label: "预计终值", formula: "rate == 0 ? monthly*12*years : monthly * ((1 + rate/1200)^(years*12) - 1) / (rate/1200)", unit: "元", format: "integer", primary: true },
            { id: "invested", label: "累计投入", formula: "monthly*12*years", unit: "元", format: "integer" },
            { id: "growth", label: "预计收益", formula: "value - invested", unit: "元", format: "integer", tone: "up" },
          ],
          breakdown: ["invested", "growth"],
          chart: { kind: "area", x: "years", from: 0, to: "years", series: ["value", "invested"], x_label: "年" },
          assumptions: ["按月复利,收益率固定", "不含税费与通胀"],
        },
      },
      {
        label: "房贷",
        block: {
          type: "calculator",
          inputs: [
            { id: "loan", label: "贷款额", value: 1000000, step: 50000, unit: "元" },
            { id: "rate", label: "年利率", kind: "slider", value: 3.1, min: 2, max: 6, step: 0.05, unit: "%" },
            { id: "years", label: "年限", kind: "select", value: 30, options: [{ label: "20 年", value: 20 }, { label: "30 年", value: 30 }] },
          ],
          outputs: [
            { id: "monthly", label: "每月还款", formula: "pmt(rate/1200, years*12, loan)", unit: "元", format: "currency", primary: true },
            { id: "interest", label: "总利息", formula: "monthly*years*12 - loan", unit: "元", format: "integer", tone: "down" },
          ],
          breakdown: [],
          assumptions: ["等额本息"],
        },
      },
      {
        label: "分账",
        block: {
          type: "calculator",
          inputs: [
            { id: "bill", label: "账单", value: 864, step: 1, unit: "元" },
            { id: "people", label: "人数", value: 4, min: 1, max: 30, step: 1, unit: "人" },
            { id: "tip", label: "加服务费", kind: "toggle", value: false },
          ],
          outputs: [{ id: "each", label: "每人", formula: "bill * (tip ? 1.1 : 1) / people", unit: "元", format: "currency", primary: true }],
        },
      },
    ],
  }),
  ui({
    type: "stats",
    items: [
      { label: "沪深 300(近 12 月)", value: "3,986", delta: "+8.4%", trend: [3680, 3612, 3705, 3760, 3698, 3821, 3876, 3790, 3902, 3955, 3931, 3986] },
      { label: "10 年国债收益率", value: "1.86%", delta: "-0.21", tone: "down", trend: [2.07, 2.05, 2.01, 1.98, 1.99, 1.95, 1.93, 1.9, 1.91, 1.88, 1.87, 1.86] },
    ],
    source: "示例数据,仅用于界面预览",
  }),
].join("\n")

export const R2_MENU = [
  "我会做一顿英式周日烤肉,带一点地中海风味:脆皮土豆、蒜香迷迭香羊腿、时令蔬菜和一份清爽的沙拉。",
  "### 1. 菜单",
  ui({
    type: "cards",
    items: [
      { title: "主菜:迷迭香蒜香烤羊腿", body: "柠檬、大蒜、迷迭香和橄榄油腌一晚,配自制肉汁和薄荷酱。", image: photo("1529692236671-f1f6cf9683ba"), tags: ["110 分钟"] },
      { title: "必备:超脆烤土豆", body: "先煮再摇出毛边,高温烤到金黄,没有商量余地。", image: photo("1518977676601-b53f82aba655"), tags: ["配菜"] },
      { title: "蜂蜜烤胡萝卜", body: "带一点孜然,和羊腿同时进烤箱。", image: photo("1598170845058-32b9d6a5da37"), tags: ["素"] },
      { title: "柠檬香草沙拉", body: "解腻用,开饭前 10 分钟再拌。", image: photo("1512621776951-a57141f2eefd"), tags: ["素", "快手"] },
    ],
  }),
  "### 2. 用量(按人数换算)",
  ui({
    type: "recipe",
    title: "烤羊腿全套",
    servings: 5,
    meta: [
      { label: "准备", value: "30 分钟" },
      { label: "烤制", value: "110 分钟" },
    ],
    ingredients: [
      { name: "带骨羊腿", amount: 2, unit: "kg" },
      { name: "土豆", amount: 1500, unit: "g" },
      { name: "胡萝卜", amount: 750, unit: "g" },
      { name: "迷迭香", amount: 4, unit: "枝" },
      { name: "大蒜", amount: 1, unit: "头" },
      { name: "橄榄油", amount: 60, unit: "ml" },
      { name: "盐和黑胡椒", note: "按口味" },
    ],
    steps: ["前一晚把羊腿用蒜、迷迭香、橄榄油和盐腌上", "烤前 1 小时拿出来回温", "220°C 烤 20 分钟,再转 170°C 烤到中心 60°C", "出炉静置 20 分钟再切"],
  }),
  ui({ type: "suggestions", items: ["改成 8 个人", "加一道素食主菜", "需要提前买些什么?"] }),
].join("\n")

export const R2_OFFSIDE = [
  "核心规则:队友传球的那一刻,如果你在对方半场、而且比球和倒数第二名防守球员都更靠近对方球门,你就处在越位位置。",
  ui({
    type: "steps",
    title: "裁判按这个顺序判断",
    items: [
      { title: "传球那一刻在对方半场吗?", detail: "在本方半场永远不越位" },
      { title: "比球更靠近对方球门吗?" },
      { title: "比倒数第二名防守球员更靠前吗?", detail: "通常是最后一名后卫,守门员在后面时" },
      { title: "有没有参与进攻?", detail: "只是站在越位位置不算犯规" },
    ],
  }),
  ui({ type: "callout", tone: "info", title: "手臂不算", body: "判断位置时只看头、躯干和脚,**手和手臂不算**。" }),
  ui({
    type: "quiz",
    title: "测一下",
    questions: [
      { question: "球员在本方半场接到队友直传,能被判越位吗?", options: ["能", "不能"], answer: 1, explain: "越位位置只在对方半场成立。" },
      { question: "角球直接传到门前,接球的进攻球员越位吗?", options: ["越位", "不越位"], answer: 1, explain: "直接从角球、界外球、球门球接球不判越位。" },
      { question: "进攻球员只有手臂超过了防守球员,算越位位置吗?", options: ["算", "不算"], answer: 1, explain: "手和手臂不计入越位判断。" },
    ],
  }),
].join("\n")

export const R2_TRIP = [
  "三天走一号公路,节奏刚好:第一天沿海往南,第二天留给大苏尔,第三天慢慢开到洛杉矶。",
  ui({
    type: "route",
    title: "旧金山 → 洛杉矶",
    stops: [
      { name: "旧金山", detail: "早上 8 点出发,先过金门大桥看一眼" },
      { name: "蒙特雷", detail: "17 英里海岸线 + 水族馆", note: "午饭" },
      { name: "大苏尔", detail: "比克斯比大桥、麦克威瀑布", note: "值得绕路", highlight: true },
      { name: "圣路易斯奥比斯波", detail: "住一晚,第二天早上去赫氏城堡" },
      { name: "洛杉矶", detail: "傍晚到圣塔莫尼卡看日落" },
    ],
    legs: [
      { mode: "自驾", distance: "190 km", duration: "2 小时" },
      { mode: "自驾", distance: "50 km", duration: "1 小时" },
      { mode: "自驾", distance: "150 km", duration: "3 小时" },
      { mode: "自驾", distance: "310 km", duration: "4 小时" },
    ],
  }),
  ui({
    type: "progress",
    title: "预算",
    subtitle: "两个人,总预算 9,000 元",
    items: [
      { label: "住宿", value: 4200, max: 4500, unit: "元", tone: "warn" },
      { label: "油费", value: 900, max: 1200, unit: "元", tone: "good" },
      { label: "餐饮", value: 2400, max: 2200, unit: "元", note: "海边餐厅偏贵,超了 200 元" },
    ],
  }),
  ui({
    type: "form",
    title: "想按你的情况再调整",
    fields: [
      { id: "date", label: "出发日期", kind: "date" },
      { id: "people", label: "几个人", kind: "number", unit: "人", value: "2", required: true },
      { id: "style", label: "更想要", kind: "chips", options: ["看风景", "吃好的", "拍照", "少开车"], multi: true },
    ],
    submit: "按这个重排",
  }),
].join("\n")

export const R2_LAPTOPS = [
  "常出差、主要写代码、预算 1.5 万:三台都能用,差别在重量、续航和接口。",
  ui({
    type: "compare",
    items: [
      { name: "MacBook Air 15", tag: "M4 · 24GB", price: "¥12,999", summary: "续航最长,最省心", pros: ["续航 18 小时", "无风扇静音"], cons: ["外接只能两屏"], recommended: true },
      { name: "ThinkPad X1 Carbon", tag: "Ultra 7 · 32GB", price: "¥14,499", summary: "最轻,键盘最好", pros: ["1.09 kg", "接口齐全"], cons: ["续航一般"] },
      { name: "Framework 13", tag: "Ryzen AI · 32GB", price: "¥11,899", summary: "能自己升级维修", pros: ["内存硬盘可换", "Linux 友好"], cons: ["做工略松"] },
    ],
    verdict: "常出差优先续航,选 MacBook Air;离不开 Linux 选 Framework。",
  }),
  ui({
    type: "table",
    title: "关键参数",
    columns: ["机型", { label: "重量", unit: "kg" }, { label: "续航", unit: "小时", bar: true }, "雷电 / USB4", { label: "价格", unit: "元" }],
    rows: [
      ["MacBook Air 15", 1.51, 18, "✓", 12999],
      ["ThinkPad X1 Carbon", 1.09, 11, "✓", 14499],
      ["Framework 13", 1.3, 9, "✗", 11899],
    ],
    highlight: 0,
    source: "各厂商官网规格页,2026-10;续航为厂商视频播放口径",
  }),
  ui({
    type: "chart",
    kind: "bar",
    title: "实测编译耗时",
    subtitle: "越低越好,单位秒",
    labels: ["MacBook Air", "X1 Carbon", "Framework"],
    series: [
      { name: "冷编译", values: [212, 268, 241] },
      { name: "增量", values: [14, 19, 16] },
    ],
    source: "同一仓库 tsc -b,三次取中位数(示例数据)",
  }),
].join("\n")

const VIEWPORTS: ('desktop' | 'mobile')[] = ['mobile', 'desktop']
const scene = (id: string, label: string, question: string, answer: string): Scene => ({
  id,
  label,
  group: '工作区',
  viewports: VIEWPORTS,
  api: {},
  render: () => <Timeline messages={conversation(question, answer)} />,
})

export const iuiR2Scenes: Scene[] = [
  scene('iui-r2-wardrobe', 'Intelligent UI · 秋季胶囊衣橱(拼贴 + 色板 + 卡片)', '秋天想搭一套胶囊衣橱,通勤和周末都能穿', R2_WARDROBE),
  scene('iui-r2-garden', 'Intelligent UI · 小菜园(方块网格 + 进度 + 清单)', '后院只有 4×4 英尺,想种点菜怎么规划?', R2_GARDEN),
  scene('iui-r2-finance', 'Intelligent UI · 理财计算器(分段 + 曲线 + 占比)', '做个理财计算器,看看定投 20 年能攒多少', R2_FINANCE),
  scene('iui-r2-menu', 'Intelligent UI · 周日菜单(图片卡 + 食谱)', '周日请朋友来吃烤羊腿,人数还没定,帮我做个方案', R2_MENU),
  scene('iui-r2-offside', 'Intelligent UI · 越位规则(步骤 + 小测验)', '足球越位到底怎么判?', R2_OFFSIDE),
  scene('iui-r2-trip', 'Intelligent UI · 一号公路(路线 + 预算 + 表单)', '旧金山到洛杉矶走一号公路,三天怎么安排?', R2_TRIP),
  scene('iui-r2-laptops', 'Intelligent UI · 笔记本(对比 + 数据条 + 图表)', '出差多、主要写代码,1.5 万内买哪台笔记本?', R2_LAPTOPS),
]
