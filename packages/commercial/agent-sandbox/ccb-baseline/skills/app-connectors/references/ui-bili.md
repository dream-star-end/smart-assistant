# 哔哩哔哩 · 智能 UI 组件

只在网页对话里用（系统提示里有 Intelligent UI 协议时）；微信、定时任务等没有该协议时不要写这些块。
写法同通用协议：```ui 块里放一个 JSON 对象。字段照抄 `oc-connect call bili …` / `oc-plugin call bili-account …` 结果里的同名字段，不改数字、不编链接，没有的字段不写。

- bili_videos：视频卡片列表（search 的 data.result、popular 的 data.list、收藏夹、观看历史）。
  {"type":"bili_videos","title"?,"items":[{"bvid","title","pic"?,"author"?,"owner"?:{"name"},"play"?,"stat"?:{"view","danmaku"},"video_review"?,"duration"?,"pubdate"?,"progress"?,"view_at"?,"fav_time"?}]}
  最多 30 条；search 的 title 带 <em> 高亮也可原样照抄。
- bili_rank：排行榜（rank 的 data.list，名次按顺序）。
  {"type":"bili_rank","title"?,"items":[{"bvid","title","pic"?,"owner":{"name"},"stat":{"view"},"score"?}]}
- bili_video：单个视频详情（video 的 data）。
  {"type":"bili_video","bvid","title","pic"?,"owner":{"name"},"desc"?,"duration"?,"pubdate"?,"tname"?,"stat":{…七项},"pages"?:[{"page","part","duration"}]}
- bili_comments：评论（comments 的 data）。
  {"type":"bili_comments","bvid"?,"cursor"?:{"all_count"},"replies":[{"member":{"uname"},"like","rcount"?,"content":{"message"},"ctime"?}]}
- bili_danmaku：弹幕（danmaku 的结果原样带上 total、maxT、density、items）。
  {"type":"bili_danmaku","bvid"?,"total","maxT","density":[…],"items":[{"t","text"}]}
- bili_subtitle：字幕（bili-account 的 subtitle 结果）。
  {"type":"bili_subtitle","bvid"?,"lang"?,"lines":[{"from","to"?,"text"}]}

组件外用一两句话讲重点（比如弹幕最密集的时刻、评论的主要观点）。只问一个数时直接文字回答。

示例：
```ui
{"type":"bili_rank","title":"全站排行","items":[{"bvid":"BV1xx411c7mD","title":"示例视频","owner":{"name":"某UP"},"stat":{"view":1203456},"score":98765}]}
```
