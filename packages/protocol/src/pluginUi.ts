/**
 * 插件专属的 Intelligent UI 组件登记表（OCV5-393）。
 *
 * 规则（以后所有插件都要遵守）：插件专属组件的定义**不进默认上下文**。
 *   - 通用组件协议（系统提示里的 INTELLIGENT_UI 段，每轮都带）里不出现任何插件组件；
 *   - 插件组件的定义放在插件自己的技能目录里，只在 Agent 加载这个插件、要展示它的结果时才读：
 *       author = 'model'：定义在 `<skill>/references/ui-<插件>.md`（不放进 SKILL.md 正文），SKILL.md 只留一行指引；
 *       author = 'cli'  ：组件由插件命令直接打印（如 `ths … --ui`），模型原样转贴，SKILL.md 里只写怎么用 --ui。
 *   - 前端每认一个组件类型，要么在通用协议里，要么在这张表里恰好属于一个插件
 *     （commercial `__tests__/intelligentUi.test.ts` 与 `pluginUiOnDemand.test.ts` 守着）。
 *
 * 新插件加组件：前端 schema 加类型 → 这里登记 → 技能目录写 references/ui-<插件>.md → SKILL.md 加一行指引；
 * 带 plugin.json 的插件同时在清单的 `components.ui` 里声明同一组类型。详见 docs/plugin-authoring.md。
 */

export type PluginUiAuthor = 'model' | 'cli'

export interface PluginUiComponentSet {
  /** 插件 slug（与 plugin.json 的 name、oc-plugin / oc-connect 的 provider 一致）。 */
  plugin: string
  displayName: string
  author: PluginUiAuthor
  /** 承载这个插件的技能（ccb-baseline/skills/<skill>）。 */
  skill: string
  /** 组件定义所在文件，相对技能目录。author=model 时是 references/ui-<插件>.md；author=cli 时是 SKILL.md（只写 --ui 用法）。 */
  doc: string
  /** 前端组件类型（schema.ts 的 IUI_TYPES 里的名字）。 */
  types: readonly string[]
}

export const PLUGIN_UI_COMPONENTS: readonly PluginUiComponentSet[] = Object.freeze([
  {
    plugin: 'ths',
    displayName: '同花顺行情',
    author: 'cli',
    skill: 'ths',
    doc: 'SKILL.md',
    types: ['quote', 'kline', 'intraday', 'stocklist'],
  },
  {
    plugin: 'weibo',
    displayName: '微博',
    author: 'model',
    skill: 'app-connectors',
    doc: 'references/ui-weibo.md',
    types: ['weibo_posts', 'weibo_hot'],
  },
  {
    plugin: 'zhihu',
    displayName: '知乎',
    author: 'model',
    skill: 'app-connectors',
    doc: 'references/ui-zhihu.md',
    types: ['zhihu_answers', 'zhihu_hot'],
  },
  {
    // OCV5-402：公开数据（bili）与登录数据（bili-account）共用一套组件、一份定义文件。
    plugin: 'bili',
    displayName: '哔哩哔哩',
    author: 'model',
    skill: 'app-connectors',
    doc: 'references/ui-bili.md',
    types: ['bili_videos', 'bili_rank', 'bili_video', 'bili_comments', 'bili_danmaku', 'bili_subtitle'],
  },
  {
    plugin: 'feishu',
    displayName: '飞书',
    author: 'model',
    skill: 'app-connectors',
    doc: 'references/ui-feishu.md',
    types: ['feishu_events', 'feishu_doc'],
  },
  {
    // 平台内置的经验分享（OCV5-577 跟进）：不是第三方插件，但同样按需加载，只随 blog-writer 技能进上下文。
    plugin: 'community-blog',
    displayName: '经验分享',
    author: 'model',
    skill: 'blog-writer',
    doc: 'references/ui-blog.md',
    types: ['blog_draft', 'blog_status', 'blog_published'],
  },
])

/** 组件类型 → 所属插件；通用组件返回 null。 */
export function pluginUiOwner(type: string): PluginUiComponentSet | null {
  return PLUGIN_UI_COMPONENTS.find((s) => s.types.includes(type)) ?? null
}

/** 全部插件专属组件类型。 */
export function pluginUiTypes(): string[] {
  return PLUGIN_UI_COMPONENTS.flatMap((s) => [...s.types])
}
