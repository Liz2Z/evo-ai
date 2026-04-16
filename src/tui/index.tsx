import { render } from 'ink'
import type { Manager } from '../manager/scheduler'
import { KanbanBoard } from './components/KanbanBoard'

interface TUIOptions {
  emitter: Manager | null
  manager: Manager | null
  heartbeatIntervalMs: number
  onQuit: () => void
}

export function startTUI({ emitter, manager, heartbeatIntervalMs, onQuit }: TUIOptions) {
  const App = () => (
    <KanbanBoard
      emitter={emitter}
      manager={manager}
      heartbeatIntervalMs={heartbeatIntervalMs}
      onQuit={onQuit}
    />
  )

  const instance = render(<App />)

  return instance
}
