import type { IncomingMessage } from 'node:http'
import { TaskboardCancelledError, type TaskboardRunControl } from './runControl.js'

export class TaskboardBodyTimeoutError extends Error {
  constructor() { super('taskboard delegate request body timed out'); this.name = 'TaskboardBodyTimeoutError' }
}

/** Body reading has no admission side effects and must not hold Stop forever. */
export function readTaskboardDelegateBody(
  req: IncomingMessage,
  read: (req: IncomingMessage) => Promise<string>,
  control?: Pick<TaskboardRunControl, 'signal' | 'assertOpen'>,
  timeoutMs = 30_000,
): Promise<string> {
  if (!control) return read(req)
  control.assertOpen()
  return new Promise<string>((resolve, reject) => {
    let done = false
    const finish = (error?: Error, body?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      control.signal.removeEventListener('abort', stop)
      req.off('aborted', closed)
      req.off('close', closed)
      if (error) reject(error)
      else resolve(body ?? '')
    }
    const closeRequest = (error: Error) => {
      finish(error)
      req.destroy?.()
    }
    const stop = () => closeRequest(new TaskboardCancelledError())
    const closed = () => { if (!req.complete) finish(new Error('taskboard delegate request body closed')) }
    const timer = setTimeout(() => closeRequest(new TaskboardBodyTimeoutError()), timeoutMs)
    timer.unref?.()
    control.signal.addEventListener('abort', stop, { once: true })
    req.once('aborted', closed)
    req.once('close', closed)
    if (control.signal.aborted) { stop(); return }
    try {
      read(req).then((body) => finish(undefined, body), (error) => finish(error instanceof Error ? error : new Error(String(error))))
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}
