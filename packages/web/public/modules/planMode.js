// OpenClaude — Codex autonomous planning mode
// The old manual "计划表" pill has been removed. Codex app-server now runs in
// default collaboration mode and may emit plan/task updates by itself when the
// task is complex enough. The only explicit override we keep is the "开始实施"
// button on a historical plan card, which forces the next turn back to default.

let _forceDefaultNextSubmit = false

export function requestDefaultNextSubmit() {
  _forceDefaultNextSubmit = true
}

export function getConversationModeForSubmit() {
  if (_forceDefaultNextSubmit) {
    _forceDefaultNextSubmit = false
    return 'default'
  }
  return undefined
}
