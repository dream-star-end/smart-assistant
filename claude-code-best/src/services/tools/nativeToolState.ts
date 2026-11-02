/** Real per-session ToolHost state. Never serialize AppState or function reducers. */
import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'

export function createToolStateReducers(
  setAppState: ToolUseContext['setAppState'],
): Pick<ToolUseContext, 'updateFileHistoryState' | 'updateAttributionState'> {
  return {
    updateFileHistoryState: (updater) => {
      setAppState((previous) => {
        const updated = updater(previous.fileHistory)
        return updated === previous.fileHistory ? previous : { ...previous, fileHistory: updated }
      })
    },
    updateAttributionState: (updater) => {
      setAppState((previous) => {
        const updated = updater(previous.attribution)
        return updated === previous.attribution ? previous : { ...previous, attribution: updated }
      })
    },
  }
}
export type NativeToolView = {
  inProgressToolUseIDs: ReadonlySet<string>
  responseLength: number
  interruptible: boolean
}
export function createNativeToolState(
  initialAppState: AppState,
  onStateChange: (state: AppState, previous: AppState) => void,
  onViewChange: (view: NativeToolView) => void,
) {
  const store = createStore(initialAppState, ({ newState, oldState }) =>
    onStateChange(newState, oldState),
  )
  let inProgressToolUseIDs = new Set<string>()
  let responseLength = 0
  let interruptible = false
  const view = (): NativeToolView => ({
    inProgressToolUseIDs: new Set(inProgressToolUseIDs),
    responseLength,
    interruptible,
  })
  return {
    store,
    view,
    getAppState: store.getState,
    setAppState: store.setState,
    // Background tasks always reach the same session root store.
    setAppStateForTasks: store.setState,
    ...createToolStateReducers(store.setState),
    setInProgressToolUseIDs: (update: (previous: Set<string>) => Set<string>) => {
      inProgressToolUseIDs = new Set(update(new Set(inProgressToolUseIDs)))
      onViewChange(view())
    },
    setResponseLength: (update: (previous: number) => number) => {
      const next = update(responseLength)
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('native-response-length')
      responseLength = next
      onViewChange(view())
    },
    setHasInterruptibleToolInProgress: (next: boolean) => {
      interruptible = next
      onViewChange(view())
    },
  }
}
