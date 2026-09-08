import { TUTORIAL_CASE_BY_ID, type TutorialCase } from './tutorialCaseCatalog'

/** Original deliverables, not another tutorial-case registry or a replay claim. */
export type SignatureWork = {
  id: 'planet' | 'gravity'
  title: string
  kicker: string
  subtitle: string
  action: string
  color: string
  request: string
  prompt: string
  explanation: string
  limits: string
}
export const SIGNATURE_WORKS: readonly SignatureWork[] = [
  {
    id: 'planet', title: '一句话，造一颗属于你的星球。', kicker: 'AN IDEA → AN ENTIRE WORLD',
    subtitle: '不是一张太空壁纸。拖动星球，移动太阳，亲手改变海岸线与昼夜。',
    action: '探索这颗星球', color: '#a9eee0',
    request: '给我一个能亲手探索的外星世界：可以转动，改变昼夜，还能生成新的大陆。',
    prompt: '我想做一个像案例展厅 AURELIA 那样精致、可交互的三维作品。请先确认主题、主要交互和使用设备，再设计画面并编写真实可运行代码。交付可打开的作品与源文件，测试手机布局和关键交互，注明视觉近似与设备要求。不要把预录动画或静态图片冒充实时三维；先给我一个可体验的版本再迭代。',
    explanation: '从需求到视觉设计、球面射线求交、分形地形、昼夜光照，再到可操作的独立网页。作品不需要请求外部模型，画面由浏览器实时计算。',
    limits: '程序化三维视觉作品，不是观测数据或科研级天体模型；需要 WebGL。地形为球面着色，不提供地表登陆。',
  },
  {
    id: 'gravity', title: '把“三体”，变成你能玩的实验。', kicker: 'AN EQUATION → A LIVING EXPERIMENT',
    subtitle: '改变一个星体的质量与速度。看八字轨道如何瓦解，秩序如何走向混沌。',
    action: '开始引力实验', color: '#ceb9ff',
    request: '不要只向我解释三体问题。做一个能拖动星体、调整质量和速度的实验，让我自己试。',
    prompt: '我想把一个复杂知识点做成可亲手探索的交互实验，类似案例展厅的三体引力实验室。请先确认知识点、受众与必须准确的规律，再选择合适的教学模型。交付真实计算的交互网页、完整源码、关键数值检查与近似边界；提供暂停、重置和参数控制，不用预录轨迹冒充计算，不承诺科研级精度。',
    explanation: '不是沿预设路径播放。三个星体的位置来自实时牛顿引力数值积分；暂停、拖动和改变质量后，后续轨迹会真正改变。能量误差同时可见。',
    limits: 'G=1 的二维软化引力教学模型；固定步长速度 Verlet，不模拟碰撞、相对论或天体真实尺度。参数干预后重建能量参考。',
  },
]
export function signatureAsset(work: SignatureWork, file: string): string {
  return '/tutorials/showcase-works/' + work.id + '/' + file
}
export function signatureTask(work: SignatureWork): TutorialCase {
  // The existing feature-delivery starter is the transport, not an assertion
  // that this work is a verified replay of that case.
  return { ...TUTORIAL_CASE_BY_ID['coding-feature-delivery'], title: work.title, summary: work.subtitle, starterPrompt: work.prompt }
}
