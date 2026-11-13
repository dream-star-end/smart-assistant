// Why a studio project is waiting, and which continue action matches the brief page.
// approve() acknowledges provider failures; resume() continues a user or budget pause.

import type { StudioEvent, StudioProject } from './types'

export interface StudioPause {
  reason: string
  action: 'approve' | 'resume'
}

function messageOf(e: StudioEvent): string {
  const m = e.payload && typeof e.payload.message === 'string' ? e.payload.message.trim() : ''
  return m
}

export function studioPause(project: StudioProject, events: StudioEvent[]): StudioPause | null {
  const awaiting =
    typeof project.settings?.awaitingReason === 'string' ? project.settings.awaitingReason : null
  const providerWait = project.status === 'awaiting_user' && awaiting === 'provider_failure'
  if (!providerWait && project.status !== 'paused') return null
  const types = providerWait
    ? ['project.awaiting_user']
    : ['project.paused', 'budget.exceeded', 'budget.exhausted']
  const text = [...events]
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .filter((e) => types.includes(e.type))
    .map(messageOf)
    .find(Boolean)
  if (providerWait) {
    return { action: 'approve', reason: text || '制作已暂停，已有结果会保留。' }
  }
  const budget = project.settings?.pausedReason === 'budget'
  return {
    action: 'resume',
    reason:
      text ||
      (budget
        ? '预算不够下一步了，已暂停。调高预算后点继续。'
        : '已暂停。点继续后从刚才的步骤接着做。'),
  }
}
