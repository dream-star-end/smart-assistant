# 飞书 · 智能 UI 组件

只在网页对话里用（系统提示里有 Intelligent UI 协议时）；微信、定时任务等没有该协议时不要写这些块。
写法同通用协议：```ui 代码块里放一个 JSON 对象。字段照抄 `oc-connect call feishu …` 结果里的同名字段，不编造时间和链接。

- feishu_events：日程，对应 list_calendar_events 的 events。前端按天分组，并按用户本地时区显示。
  {"type":"feishu_events","title"?,"items":[{"summary","startTime","endTime"?,"status"?,"location"?}]}
  startTime / endTime 原样写结果里的 ISO 时间。status 为 cancelled 的日程会显示为已取消。
- feishu_doc：文档卡片，对应 get_doc。points 是你从正文提炼的 3–8 条要点，每条一句话，不加原文没有的内容。
  {"type":"feishu_doc","title","docId"?,"url"?,"updatedAt"?,"points":["要点"],"excerpt"?}
  title 用文档第一行标题。url 只能来自用户给的链接，没有就不写。excerpt 是原文开头的一小段（可省略）。

建日程、发消息这类写操作仍按 app-connectors 的确认流程处理；执行成功后可以用 feishu_events 展示新建的日程。

示例：
```ui
{"type":"feishu_events","title":"本周日程","items":[{"summary":"周会","startTime":"2026-10-13T02:00:00.000Z","endTime":"2026-10-13T03:00:00.000Z"}]}
```
