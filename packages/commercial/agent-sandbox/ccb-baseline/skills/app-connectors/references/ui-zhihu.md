# 知乎 · 智能 UI 组件

只在网页对话里用（系统提示里有 Intelligent UI 协议时）；微信、定时任务等没有该协议时不要写这些块。
写法同通用协议：```ui 代码块里放一个 JSON 对象。字段照抄 `oc-plugin call zhihu …` 结果里的同名字段：不改数字，不编造链接，没有的字段就不写。

- zhihu_answers：一个问题和它的回答，对应 get_question + list_question_answers（或 get_answer）。
  {"type":"zhihu_answers","question"?:{"title","url"?,"detail"?,"answerCount"?,"followerCount"?},"items":[{"authorName"?,"headline"?,"excerpt","voteCount"?,"commentCount"?,"url"?}]}
  excerpt 用结果里的 excerpt；只有全文（text）时摘前 300 字左右，不改写原意。最多 20 个回答。
- zhihu_hot：热榜，对应 list_hot。
  {"type":"zhihu_hot","title"?,"items":[{"rank","title","hotValue"?,"excerpt"?,"url"?}]}

组件外面照常用一两句话讲结论，比如高赞回答的共识和分歧。
搜索结果、推荐流、通知、我的回答和文章用通用组件（cards / table）。

示例：
```ui
{"type":"zhihu_hot","title":"知乎热榜","items":[{"rank":1,"title":"示例问题？","hotValue":3560000,"url":"https://www.zhihu.com/question/100000001"}]}
```
