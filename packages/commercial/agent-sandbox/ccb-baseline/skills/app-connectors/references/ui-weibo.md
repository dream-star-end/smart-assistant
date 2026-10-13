# 微博 · 智能 UI 组件

只在网页对话里用（系统提示里有 Intelligent UI 协议时）；微信、定时任务等没有该协议时不要写这些块。
写法同通用协议：```ui 代码块里放一个 JSON 对象。字段照抄 `oc-plugin call weibo …` 结果里的同名字段：不改数字，不编造链接、图片或认证标记，没有的字段就不写。

- weibo_posts：微博列表，对应 list_home_posts / list_user_posts / search_posts / get_post / list_favorites / list_liked_posts 的结果。
  {"type":"weibo_posts","title"?,"items":[{"authorName","verified"?,"createdAt"?,"text","images"?:[{"url"}],"likeCount"?,"commentCount"?,"repostCount"?,"url"?}]}
  最多 20 条。text 照抄原文，长文前端会自动折叠。
- weibo_hot：热搜榜，对应 list_hot_searches 的 searches。
  {"type":"weibo_hot","title"?,"items":[{"rank","keyword","hotValue"?,"label"?,"url"?}]}

组件外面照常用一两句话讲重点，比如和用户问题相关的那几条。用户只要一两条信息时直接用文字回答。
私信、通知、评论、粉丝列表用通用组件（table / cards / timeline）。

示例：
```ui
{"type":"weibo_hot","title":"微博热搜","items":[{"rank":1,"keyword":"示例话题","hotValue":1203456,"label":"热","url":"https://s.weibo.com/weibo?q=%23示例话题%23"}]}
```
