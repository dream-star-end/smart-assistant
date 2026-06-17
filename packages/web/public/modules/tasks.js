// OpenClaude — Scheduled Tasks compatibility wrappers
import { openContextHub, switchContextTasksTab } from './memory.js?v=d3c2a31c'

export async function openTasksModal() {
  await openContextHub('tasks')
}

export function switchTasksTab(tab) {
  return switchContextTasksTab(tab)
}

export async function loadBgTasks() {
  await openContextHub('tasks')
  await switchContextTasksTab('bg')
}

export async function loadExecLog() {
  await openContextHub('tasks')
  await switchContextTasksTab('log')
}

export function initTasksListeners() {
  // Context Hub owns the modern task UI. Kept for main.js compatibility.
}
