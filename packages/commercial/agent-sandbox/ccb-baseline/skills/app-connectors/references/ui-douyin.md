# 抖音 · 智能 UI 组件

只在网页对话里用（系统提示里有 Intelligent UI 协议时）；微信、定时任务等没有该协议时不要写这些块。
写法同通用协议：```ui 块里放一个 JSON 对象。字段照抄 `oc-plugin call douyin my_videos / video_comments` 结果里的同名字段，不改数字、不编链接，没有的字段不写。

- douyin_videos：自己的作品列表（my_videos 的 items）。
  {"type":"douyin_videos","title"?,"items":[{"awemeId","url","title"?,"desc"?,"createTime"?,"durationSec"?,"cover"?,"playCount"?,"diggCount"?,"commentCount"?,"shareCount"?,"collectCount"?,"isPrivate"?,"inReview"?,"isImagePost"?}],"note"?}
  最多 20 条；url 用结果里的 https://www.douyin.com/… 原值，cover 只认结果里的抖音图床地址。
- douyin_comments：某个作品下的评论（video_comments 的结果）。
  {"type":"douyin_comments","awemeId"?,"total"?,"items":[{"cid","text","nickname"?,"createTime"?,"diggCount"?,"replyCount"?}]}
  最多 20 条。

组件外用一两句话讲重点（比如播放最高的作品、评论的主要观点）。只问一个数时直接文字回答。

示例：
```ui
{"type":"douyin_videos","title":"我的作品","items":[{"awemeId":"7400000000000000001","url":"https://www.douyin.com/video/7400000000000000001","title":"周末探店","createTime":1760000000,"durationSec":42,"playCount":12345,"diggCount":678,"commentCount":12}]}
```
