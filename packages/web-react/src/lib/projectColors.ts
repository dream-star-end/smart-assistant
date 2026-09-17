/**
 * 项目色板：key 写入 ChatProject.color，dotClass 用设计 token 背景色。
 * 「墨」例外：`bg-primary` 在深色主题是反色（亮色），色名与所见相反（PS-05）——
 * 项目色是用户给项目贴的标签，必须跨主题稳定，故用固定深灰而不跟主题反转。
 *
 * why 放 lib:侧栏 ProjectRow(首屏同步渲染)与 ProjectSettingsDialog(点开才需要的懒块)
 * 共用这张表;此前它定义在对话框文件里,侧栏一引就把整个对话框 + ProjectAssetsPanel 钉进入口
 * 静态闭包(2026-09-17 first-screen-budget 超限修复)。ProjectSettingsDialog 仍 re-export 供既有引用。
 */
export const PROJECT_COLORS: { key: string; label: string; dotClass: string }[] = [
  { key: 'accent', label: '靛紫', dotClass: 'bg-accent' },
  { key: 'info', label: '蓝', dotClass: 'bg-info' },
  { key: 'success', label: '绿', dotClass: 'bg-success' },
  { key: 'warning', label: '琥珀', dotClass: 'bg-warning' },
  { key: 'danger', label: '红', dotClass: 'bg-danger' },
  { key: 'accent-strong', label: '深紫', dotClass: 'bg-accent-strong' },
  { key: 'primary', label: '墨', dotClass: 'bg-[#4b5563]' },
  { key: 'muted', label: '灰', dotClass: 'bg-muted' },
]
