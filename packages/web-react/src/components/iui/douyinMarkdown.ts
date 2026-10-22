/**
 * 抖音组件（OCV5-553）→ Markdown：复制、导出、组件关闭或渲染失败时用。
 *
 * 作品标题、简介、评论、昵称都是第三方文字，一律经 mdText 转义（规则见 pluginMarkdown.ts），链接经 mdUrl；
 * 原文里的 ``` 围栏、HTML、链接写法只能显示成文字。
 */
import { type DouyinSpec, dateText, workBadges, workDuration, workTitle } from './douyinSchema'
import { mdText, mdUrl } from './pluginMarkdown'
import { countText } from './pluginSchema'

function counts(items: [string, number | undefined][]): string {
  return items
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${countText(v)}`)
    .join(' · ')
}

function head(title: string, subtitle: string | undefined): string[] {
  return [`**${mdText(title)}**`, ...(subtitle ? [mdText(subtitle)] : []), '']
}

function foot(note: string | undefined): string[] {
  return note ? ['', `> ${mdText(note)}`] : []
}

export function douyinToMarkdown(spec: DouyinSpec): string {
  switch (spec.type) {
    case 'douyin_videos':
      return [
        ...head(spec.title ?? '我的抖音作品', spec.subtitle),
        ...spec.items.map((v, i) => {
          const meta = [
            ...workBadges(v),
            dateText(v.createTime),
            workDuration(v),
            counts([
              ['播放', v.playCount],
              ['点赞', v.diggCount],
              ['评论', v.commentCount],
              ['分享', v.shareCount],
              ['收藏', v.collectCount],
            ]) || undefined,
          ]
            .filter(Boolean)
            .join(' · ')
          return `${i + 1}. [${mdText(workTitle(v))}](${mdUrl(v.url)})${meta ? `(${meta})` : ''}`
        }),
        ...foot(spec.note),
      ]
        .join('\n')
        .trim()
    case 'douyin_comments':
      return [
        ...head(
          spec.title ??
            (spec.total !== undefined ? `评论(共 ${countText(spec.total)} 条)` : '评论'),
          spec.subtitle,
        ),
        ...spec.items.flatMap((c) => {
          const meta = [
            counts([
              ['赞', c.diggCount],
              ['回复', c.replyCount],
            ]) || undefined,
            dateText(c.createTime, true),
          ]
            .filter(Boolean)
            .join(' · ')
          return [
            `**${mdText(c.nickname ?? '抖音用户')}**${meta ? ` · ${meta}` : ''}`,
            ...c.text.split('\n').map((l) => `> ${mdText(l)}`),
            '',
          ]
        }),
        ...foot(spec.note),
      ]
        .join('\n')
        .trim()
  }
}
