/**
 * 经验分享组件 → Markdown（智能 UI 关闭、复制、导出、渲染出错时用）。
 * 草稿转成可读的文章；状态卡只写稿件号和去哪看，不编造状态。
 */
import type { BlogSpec } from './blogSchema'

const CATEGORY_LABEL = { research: '研究', coding: '编程', general: '通用' } as const

export function blogToMarkdown(spec: BlogSpec): string {
  switch (spec.type) {
    case 'blog_draft':
      return [
        `**经验分享草稿 · v${spec.version}**（${CATEGORY_LABEL[spec.category]}，未投稿）`,
        '',
        `# ${spec.title}`,
        ...(spec.summary ? ['', `> ${spec.summary}`] : []),
        '',
        spec.body,
        ...(spec.note ? ['', `_本版改动：${spec.note}_`] : []),
      ].join('\n')
    case 'blog_status':
    case 'blog_published':
      return `经验分享稿件 #${spec.id}：到「经验分享 → 我的投稿」查看审核状态和链接。`
  }
}
