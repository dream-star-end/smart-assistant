// 任务面板服务端开关。与 web 侧 `VITE_TASKBOARD_ENABLED`(packages/web-react/src/lib/taskboardFeature.ts)
// 同一语义:商业版隐藏 UI 之外,容器 gateway 也不得自己跑巡检/简报。
//
// 背景(INC-20260906-COMMERCIAL-TASKBOARD-DIGEST):商业版只做了前端隐藏,gateway 的
// PatrolEngine + TaskboardNotifier 无条件启动,每个新起容器第一次 tick 就给用户写一条
// "任务面板每日简报(0/0/0)"站内信,刚注册的用户 1 分钟内就能收到。
//
// 范围:只关后台自动化(巡检 tick / 简报 / 待确认 / 熔断通知)。`/api/board/*` 不在此关闭——
// project-context 与 MCP 复用它,且不产生主动通知。
//
// 注入方:master 的 v3supervisor 按 flavor 决定(packages/commercial/src/agent-sandbox/taskboardEnv.ts)。

export const TASKBOARD_ENABLED_ENV = 'OC_TASKBOARD_ENABLED'

/** 缺省启用(selfhost / 个人版 / 测试);只有精确 '0' 才关。 */
export function taskboardEnabledFromEnv(raw: string | undefined): boolean {
  return raw !== '0'
}

export function isTaskboardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return taskboardEnabledFromEnv(env[TASKBOARD_ENABLED_ENV])
}
