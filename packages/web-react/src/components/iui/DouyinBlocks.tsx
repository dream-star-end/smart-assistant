/**
 * Intelligent UI —— 抖音插件专属组件（OCV5-553）：自己的作品列表、某个作品下的评论。
 *
 * - 数据全部来自块里的字段（模型照抄 `oc-plugin call douyin my_videos / video_comments` 的结果）；
 *   组件不补数据，缺的字段就不显示。
 * - 视觉沿用插件组件的公共样式（oc-plg-*），抖音用自己的强调色（.is-douyin），明暗主题都只用 token。
 * - 手机优先：封面是竖图缩略图，元信息换行；长列表默认显示 10 条；外链新窗口打开、不带来源页。
 * - 封面走 Media（referrerPolicy=no-referrer），只接受 douyinpic.com 的 https 地址；失败时换成色块，不影响正文。
 */
import { useState } from 'react'
import { Counts, ExtLink, FoldText, MoreButton } from './PluginBlocks'
import {
  type DouyinCommentsSpec,
  type DouyinVideoItem,
  type DouyinVideosSpec,
  dateText,
  workBadges,
  workDuration,
  workTitle,
} from './douyinSchema'
import { countText } from './pluginSchema'
import { Frame, Media } from './shell'
import { specToMarkdown } from './toMarkdown'

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean }

const COLLAPSED = 10

function frameProps<S extends { title?: string; subtitle?: string; note?: string }>(
  spec: S,
  kind: string,
  fallbackTitle: string,
  rest: Omit<BlockProps<S>, 'spec'>,
) {
  return {
    kind,
    title: spec.title ?? fallbackTitle,
    subtitle: spec.subtitle,
    nested: rest.nested,
    note: spec.note,
    notes: rest.notes,
    streaming: rest.streaming,
    className: 'oc-plg is-douyin',
  }
}

function WorkRow({ v }: { v: DouyinVideoItem }) {
  const title = workTitle(v)
  const dur = workDuration(v)
  const date = dateText(v.createTime)
  const badges = workBadges(v)
  return (
    <li className="oc-dy-row">
      <span className="oc-dy-cover">
        <Media src={v.cover} alt={`${title} 的封面`} fallbackText="抖" />
        {dur && <span className="oc-dy-duration tabular-nums">{dur}</span>}
      </span>
      <span className="oc-dy-main">
        <ExtLink href={v.url} className="oc-dy-title">
          {title}
        </ExtLink>
        {(date || badges.length > 0) && (
          <span className="oc-dy-line">
            {date && <span className="oc-plg-meta oc-dy-when">{date}</span>}
            {badges.map((b) => (
              <span key={b} className="oc-plg-tag">
                {b}
              </span>
            ))}
          </span>
        )}
        <Counts
          items={[
            ['播放', v.playCount],
            ['点赞', v.diggCount],
            ['评论', v.commentCount],
            ['分享', v.shareCount],
            ['收藏', v.collectCount],
          ]}
        />
      </span>
    </li>
  )
}

export function DouyinVideosBlock({ spec, ...rest }: BlockProps<DouyinVideosSpec>) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED)
  return (
    <Frame
      {...frameProps(spec, 'douyin_videos', '我的抖音作品', rest)}
      copyText={() => specToMarkdown(spec)}
    >
      <ul className="oc-dy-list">
        {shown.map((v) => (
          <WorkRow key={v.awemeId} v={v} />
        ))}
      </ul>
      <MoreButton
        total={spec.items.length}
        expanded={expanded}
        unit="个"
        onToggle={() => setExpanded((x) => !x)}
      />
    </Frame>
  )
}

export function DouyinCommentsBlock({ spec, ...rest }: BlockProps<DouyinCommentsSpec>) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? spec.items : spec.items.slice(0, COLLAPSED)
  const fallback = spec.total !== undefined ? `评论 · 共 ${countText(spec.total)} 条` : '评论'
  return (
    <Frame
      {...frameProps(spec, 'douyin_comments', fallback, rest)}
      copyText={() => specToMarkdown(spec)}
    >
      <ul className="oc-plg-answers">
        {shown.map((c) => {
          const name = c.nickname ?? '抖音用户'
          const time = dateText(c.createTime, true)
          return (
            <li key={c.cid} className="oc-plg-answer">
              <div className="oc-plg-post-head">
                <span className="oc-plg-avatar" aria-hidden>
                  {name.slice(0, 1)}
                </span>
                <span className="min-w-0">
                  <span className="oc-plg-author">{name}</span>
                  {time && <span className="oc-plg-meta">{time}</span>}
                </span>
              </div>
              <FoldText text={c.text} />
              <div className="oc-plg-post-foot">
                <Counts
                  items={[
                    ['赞', c.diggCount],
                    ['回复', c.replyCount],
                  ]}
                />
              </div>
            </li>
          )
        })}
      </ul>
      <MoreButton
        total={spec.items.length}
        expanded={expanded}
        unit="条"
        onToggle={() => setExpanded((x) => !x)}
      />
    </Frame>
  )
}
