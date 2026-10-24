import type { TaskboardDb } from './db/schema.js'
import { hasUnfinishedRun } from './db/runs.js'
import { taskboardRunControls } from './runControl.js'

/** Retrying waits for persistent settlement and the complete local promise tree. */
export function hasPendingTaskboardExecution(db: TaskboardDb, ticketId: string): boolean {
  return taskboardRunControls.hasActiveTicket(ticketId) || hasUnfinishedRun(db, ticketId)
}
