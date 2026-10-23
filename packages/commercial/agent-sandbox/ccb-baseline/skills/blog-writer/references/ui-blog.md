# 经验分享 · 智能 UI 组件

只在网页对话里用（系统提示里有 Intelligent UI 协议时）；微信、定时任务等没有该协议时不要写这些块。
写法同通用协议：```ui 代码块里放一个 JSON 对象。

- blog_draft：草稿预览卡，用户在卡上确认投稿。
  {"type":"blog_draft","draft_id","version","title","summary","category":"research"|"coding"|"general","body","note"?}
  draft_id 自己起（字母数字和 -_，≤40），同一篇的各版本不变；version 从 1 起，每次修改加 1。
  body 是 Markdown 正文，图片写 `![说明](/容器内绝对路径.png)`。note 用一句话说明这一版改了什么。
- blog_status：投稿后的审核状态卡，只写稿件号，状态由页面向服务端查询。
  {"type":"blog_status","id":"12"}
- blog_published：已发布文章的链接卡，只写稿件号；没发布时页面会显示当前状态。
  {"type":"blog_published","id":"12"}

不要在卡片外重复整篇正文；卡片外用一两句话说明结构和需要用户注意的地方。

示例：
```ui
{"type":"blog_draft","draft_id":"weekly-report","version":1,"title":"用定时任务做周报：从 40 分钟到 0","summary":"记录把手动周报交给助手和定时任务的过程、口径怎么定，以及两个踩过的坑。","category":"general","body":"## 场景\n\n每周一要给团队发数据周报……\n\n## 怎么做的\n\n1. ……\n\n![每周汇总](/home/agent/workspace/outputs/weekly.png)"}
```
